//! ONNX-based semantic embeddings for Magento code search
//!
//! Uses all-MiniLM-L6-v2 model for 384-dimensional embeddings

use anyhow::{Context, Result};
use ndarray::Array1;
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;
use std::path::Path;
use tokenizers::Tokenizer;

/// Embedding dimension for all-MiniLM-L6-v2
pub const EMBEDDING_DIM: usize = 384;

/// Maximum sequence length
const MAX_SEQ_LEN: usize = 256;

/// Semantic embedder using ONNX runtime
pub struct Embedder {
    session: Session,
    tokenizer: Tokenizer,
}

impl Embedder {
    /// Create a new embedder from model files
    pub fn new(model_path: &Path, tokenizer_path: &Path) -> Result<Self> {
        // Initialize ONNX session
        let session = Session::builder()?
            .with_optimization_level(GraphOptimizationLevel::Level3)?
            .with_intra_threads(4)?
            .commit_from_file(model_path)
            .context("Failed to load ONNX model")?;

        // Load tokenizer
        let tokenizer = Tokenizer::from_file(tokenizer_path)
            .map_err(|e| anyhow::anyhow!("Failed to load tokenizer: {}", e))?;

        Ok(Self { session, tokenizer })
    }

    /// Download and initialize with default model (all-MiniLM-L6-v2)
    pub fn from_pretrained(cache_dir: &Path) -> Result<Self> {
        let model_path = cache_dir.join("all-MiniLM-L6-v2.onnx");
        let tokenizer_path = cache_dir.join("tokenizer.json");

        // Download if not exists
        if !model_path.exists() {
            Self::download_model(cache_dir)?;
        }

        Self::new(&model_path, &tokenizer_path)
    }

    /// Download the default model
    fn download_model(cache_dir: &Path) -> Result<()> {
        use std::fs;
        use std::io::Write;

        fs::create_dir_all(cache_dir)?;

        let model_url = "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx";
        let tokenizer_url = "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/tokenizer.json";

        tracing::info!("Downloading embedding model...");

        // Download model
        let model_bytes = reqwest::blocking::get(model_url)
            .context("Failed to download model")?
            .bytes()
            .context("Failed to read model bytes")?;

        let model_path = cache_dir.join("all-MiniLM-L6-v2.onnx");
        let mut file = fs::File::create(&model_path)?;
        file.write_all(&model_bytes)?;

        // Download tokenizer
        let tokenizer_bytes = reqwest::blocking::get(tokenizer_url)
            .context("Failed to download tokenizer")?
            .bytes()
            .context("Failed to read tokenizer bytes")?;

        let tokenizer_path = cache_dir.join("tokenizer.json");
        let mut file = fs::File::create(&tokenizer_path)?;
        file.write_all(&tokenizer_bytes)?;

        tracing::info!("Model downloaded successfully");
        Ok(())
    }

    /// Generate embedding for a single text
    pub fn embed(&mut self, text: &str) -> Result<Vec<f32>> {
        let embeddings = self.embed_batch(&[text])?;
        Ok(embeddings.into_iter().next().unwrap())
    }

    /// Generate embeddings for a batch of texts
    pub fn embed_batch(&mut self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
        let batch_size = texts.len();

        // Tokenize
        let encodings = self
            .tokenizer
            .encode_batch(texts.to_vec(), true)
            .map_err(|e| anyhow::anyhow!("Tokenization failed: {}", e))?;

        // Prepare input data
        let mut input_ids: Vec<i64> = Vec::with_capacity(batch_size * MAX_SEQ_LEN);
        let mut attention_mask: Vec<i64> = Vec::with_capacity(batch_size * MAX_SEQ_LEN);
        let mut token_type_ids: Vec<i64> = Vec::with_capacity(batch_size * MAX_SEQ_LEN);

        for encoding in &encodings {
            let ids = encoding.get_ids();
            let mask = encoding.get_attention_mask();
            let types = encoding.get_type_ids();

            let len = ids.len().min(MAX_SEQ_LEN);

            // Add tokens (truncate if needed)
            for i in 0..len {
                input_ids.push(ids[i] as i64);
                attention_mask.push(mask[i] as i64);
                token_type_ids.push(types[i] as i64);
            }

            // Pad to MAX_SEQ_LEN
            for _ in len..MAX_SEQ_LEN {
                input_ids.push(0);
                attention_mask.push(0);
                token_type_ids.push(0);
            }
        }

        // Keep a copy of attention mask for pooling
        let attention_mask_copy = attention_mask.clone();

        // Create tensors using (shape, vec) tuple format
        let shape = [batch_size, MAX_SEQ_LEN];
        let input_ids_tensor = Tensor::from_array((shape, input_ids))?;
        let attention_mask_tensor = Tensor::from_array((shape, attention_mask))?;
        let token_type_ids_tensor = Tensor::from_array((shape, token_type_ids))?;

        // Run inference
        let outputs = self.session.run(ort::inputs![
            "input_ids" => input_ids_tensor,
            "attention_mask" => attention_mask_tensor,
            "token_type_ids" => token_type_ids_tensor,
        ])?;

        // Extract embeddings (last_hidden_state) - returns (shape, data)
        let (output_shape, output_data) = outputs["last_hidden_state"]
            .try_extract_tensor::<f32>()?;

        // Shape is [batch_size, seq_len, hidden_dim]
        let seq_len = output_shape[1] as usize;
        let hidden_dim = output_shape[2] as usize;

        // Mean pooling with attention mask
        let mut embeddings = Vec::with_capacity(batch_size);

        for i in 0..batch_size {
            // Compute mean of non-padded tokens
            let mut sum = Array1::<f32>::zeros(EMBEDDING_DIM);
            let mut count = 0.0f32;

            for j in 0..seq_len {
                let mask_idx = i * MAX_SEQ_LEN + j;
                if mask_idx < attention_mask_copy.len() && attention_mask_copy[mask_idx] > 0 {
                    for k in 0..EMBEDDING_DIM.min(hidden_dim) {
                        let idx = i * seq_len * hidden_dim + j * hidden_dim + k;
                        sum[k] += output_data[idx];
                    }
                    count += 1.0;
                }
            }

            // Normalize
            let embedding: Vec<f32> = if count > 0.0 {
                sum.iter().map(|&x| x / count).collect()
            } else {
                vec![0.0; EMBEDDING_DIM]
            };

            // L2 normalize
            let norm: f32 = embedding.iter().map(|x| x * x).sum::<f32>().sqrt();
            let embedding: Vec<f32> = if norm > 0.0 {
                embedding.iter().map(|x| x / norm).collect()
            } else {
                embedding
            };

            embeddings.push(embedding);
        }

        Ok(embeddings)
    }
}

/// Lightweight embedder that calls external process (for JS integration)
pub struct ExternalEmbedder {
    binary_path: String,
}

impl ExternalEmbedder {
    pub fn new(binary_path: &str) -> Self {
        Self {
            binary_path: binary_path.to_string(),
        }
    }

    pub fn embed(&self, text: &str) -> Result<Vec<f32>> {
        use std::process::Command;

        let output = Command::new(&self.binary_path)
            .arg("embed")
            .arg("--text")
            .arg(text)
            .output()
            .context("Failed to run embedder")?;

        if !output.status.success() {
            anyhow::bail!(
                "Embedder failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        let embedding: Vec<f32> = serde_json::from_slice(&output.stdout)
            .context("Failed to parse embedding output")?;

        Ok(embedding)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_embedding_dimension() {
        assert_eq!(EMBEDDING_DIM, 384);
    }
}
