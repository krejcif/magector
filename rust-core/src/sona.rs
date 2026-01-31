//! SONA - Self-Organizing Neural Adjustment
//!
//! Learns from MCP tool call patterns to adjust search result scoring.
//! Tracks when users follow up a `magento_search` with a specific tool
//! (e.g. `magento_find_plugin`) and boosts matching result types for
//! similar queries in the future.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

use crate::embedder::EMBEDDING_DIM;
use crate::vectordb::IndexMetadata;

const MAX_ADJUSTMENT: f32 = 0.15;
const BASE_LR: f32 = 0.05;

/// MicroLoRA rank (very small — 2 dimensions for minimal overhead)
const LORA_RANK: usize = 2;

/// LoRA base learning rate (decays with update count)
const LORA_LR: f32 = 0.001;

/// Minimum cosine similarity between original and LoRA-adjusted embedding.
/// If the adjustment is more destructive than this, skip it entirely.
const MIN_LORA_SIMILARITY: f32 = 0.90;

/// EWC regularization strength
const EWC_LAMBDA: f32 = 2000.0;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SonaSignal {
    #[serde(rename = "type")]
    pub signal_type: String,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub timestamp: u64,
    #[serde(default, alias = "searchResultPaths")]
    pub search_result_paths: Vec<String>,
    #[serde(default, alias = "followedTool")]
    pub followed_tool: Option<String>,
    #[serde(default, alias = "followedArgs")]
    pub followed_args: Option<serde_json::Value>,
    #[serde(default, alias = "originalQuery")]
    pub original_query: Option<String>,
    #[serde(default, alias = "refinedQuery")]
    pub refined_query: Option<String>,
    #[serde(default, alias = "originalResultPaths")]
    pub original_result_paths: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
pub struct LearnedWeights {
    /// pattern_hash → (feature_name → delta_weight)
    pub adjustments: HashMap<u64, HashMap<String, f32>>,
    /// pattern_hash → observation_count
    pub counts: HashMap<u64, u32>,
    /// Cross-query global feature bias (weakest signal, always applies)
    #[serde(default)]
    pub global_bias: HashMap<String, f32>,
    /// Number of global observations
    #[serde(default)]
    pub global_count: u32,
    /// Per-term feature adjustments (medium strength, enables cross-query generalization)
    #[serde(default)]
    pub term_adjustments: HashMap<String, HashMap<String, f32>>,
    /// Per-term observation counts
    #[serde(default)]
    pub term_counts: HashMap<String, u32>,
}

/// MicroLoRA adapter — rank-2 low-rank adaptation for embedding adjustment
///
/// Total parameters: 2 × (EMBEDDING_DIM × LORA_RANK) = 2 × 384 × 2 = 1536 floats (~6KB)
/// Applied as: embedding' = embedding + B × (A × embedding)
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MicroLoRA {
    /// Down-projection: EMBEDDING_DIM → LORA_RANK (flattened row-major)
    pub a: Vec<f32>,
    /// Up-projection: LORA_RANK → EMBEDDING_DIM (flattened row-major)
    pub b: Vec<f32>,
    /// Learning rate for LoRA updates
    pub lr: f32,
    /// Number of LoRA updates applied (used for learning rate decay)
    #[serde(default)]
    pub update_count: u32,
}

impl Default for MicroLoRA {
    fn default() -> Self {
        // Initialize with small random-like values (deterministic)
        let a_size = EMBEDDING_DIM * LORA_RANK;
        let b_size = LORA_RANK * EMBEDDING_DIM;
        let mut a = vec![0.0f32; a_size];
        let mut b = vec![0.0f32; b_size];

        // Xavier-like init: scale = sqrt(2 / (fan_in + fan_out))
        let scale_a = (2.0 / (EMBEDDING_DIM + LORA_RANK) as f32).sqrt();
        let scale_b = (2.0 / (LORA_RANK + EMBEDDING_DIM) as f32).sqrt();

        // Simple deterministic pseudo-random init
        let mut rng_state: u64 = 0x12345678_deadbeef;
        for v in a.iter_mut() {
            rng_state = rng_state.wrapping_mul(6364136223846793005).wrapping_add(1);
            let frac = ((rng_state >> 33) as f32) / (u32::MAX as f32) - 0.5;
            *v = frac * scale_a;
        }
        for v in b.iter_mut() {
            rng_state = rng_state.wrapping_mul(6364136223846793005).wrapping_add(1);
            let frac = ((rng_state >> 33) as f32) / (u32::MAX as f32) - 0.5;
            *v = frac * scale_b;
        }

        Self { a, b, lr: 0.001, update_count: 0 }
    }
}

impl MicroLoRA {
    /// Apply LoRA transformation: embedding' = embedding + B × (A × embedding)
    pub fn forward(&self, embedding: &[f32]) -> Vec<f32> {
        assert_eq!(embedding.len(), EMBEDDING_DIM);

        // hidden = A × embedding (LORA_RANK-dim)
        let mut hidden = vec![0.0f32; LORA_RANK];
        for r in 0..LORA_RANK {
            let mut sum = 0.0f32;
            let row_start = r * EMBEDDING_DIM;
            for c in 0..EMBEDDING_DIM {
                sum += self.a[row_start + c] * embedding[c];
            }
            hidden[r] = sum;
        }

        // delta = B × hidden (EMBEDDING_DIM-dim)
        let mut result = embedding.to_vec();
        for r in 0..EMBEDDING_DIM {
            let mut sum = 0.0f32;
            let row_start = r * LORA_RANK;
            for c in 0..LORA_RANK {
                sum += self.b[row_start + c] * hidden[c];
            }
            result[r] += sum;
        }

        result
    }

    /// Update LoRA weights from a feedback signal (simple gradient approximation)
    ///
    /// When a user selects a result, we nudge the LoRA to make the query embedding
    /// closer to that result's embedding direction.
    pub fn update_from_signal(&mut self, query_emb: &[f32], target_emb: &[f32]) {
        assert_eq!(query_emb.len(), EMBEDDING_DIM);
        assert_eq!(target_emb.len(), EMBEDDING_DIM);

        // Decay learning rate with update count
        self.update_count += 1;
        let lr = LORA_LR / (1.0 + 0.005 * self.update_count as f32);

        // Compute desired delta = target - query (direction to move)
        let mut delta = vec![0.0f32; EMBEDDING_DIM];
        for i in 0..EMBEDDING_DIM {
            delta[i] = target_emb[i] - query_emb[i];
        }

        // Approximate gradient update for B matrix
        // hidden = A × query_emb
        let mut hidden = vec![0.0f32; LORA_RANK];
        for r in 0..LORA_RANK {
            let row_start = r * EMBEDDING_DIM;
            for c in 0..EMBEDDING_DIM {
                hidden[r] += self.a[row_start + c] * query_emb[c];
            }
        }

        // Update B: B += lr * delta ⊗ hidden^T
        for r in 0..EMBEDDING_DIM {
            let row_start = r * LORA_RANK;
            for c in 0..LORA_RANK {
                self.b[row_start + c] += lr * delta[r] * hidden[c];
            }
        }

        // Update A: A += lr * B^T × delta ⊗ query_emb^T (simplified)
        for r in 0..LORA_RANK {
            let mut grad_hidden = 0.0f32;
            for i in 0..EMBEDDING_DIM {
                grad_hidden += self.b[i * LORA_RANK + r] * delta[i];
            }
            let row_start = r * EMBEDDING_DIM;
            for c in 0..EMBEDDING_DIM {
                self.a[row_start + c] += lr * grad_hidden * query_emb[c];
            }
        }
    }
}

/// EWC++ (Elastic Weight Consolidation) regularizer
///
/// Prevents catastrophic forgetting of previously learned patterns when
/// learning from new feedback signals. Uses online Fisher information estimation.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct EwcRegularizer {
    /// Fisher information diagonal (same shape as LoRA params concatenated)
    pub fisher: Vec<f32>,
    /// Optimal weights from previous learning (reference point)
    pub star_weights: Vec<f32>,
    /// Lambda (regularization strength)
    pub lambda: f32,
    /// Number of updates accumulated
    pub update_count: u32,
}

impl Default for EwcRegularizer {
    fn default() -> Self {
        let total_params = EMBEDDING_DIM * LORA_RANK * 2; // A + B matrices
        Self {
            fisher: vec![0.0; total_params],
            star_weights: vec![0.0; total_params],
            lambda: EWC_LAMBDA,
            update_count: 0,
        }
    }
}

impl EwcRegularizer {
    /// Update Fisher information and star weights from current LoRA state
    pub fn update_fisher(&mut self, lora: &MicroLoRA) {
        let current_weights = Self::flatten_lora(lora);

        if self.update_count == 0 {
            // First update: just store the reference
            self.star_weights = current_weights;
        } else {
            // Online update: running average of Fisher information
            let alpha = 1.0 / (self.update_count as f32 + 1.0);
            for i in 0..self.fisher.len() {
                let diff = current_weights[i] - self.star_weights[i];
                let new_fisher = diff * diff; // Approximate Fisher diagonal
                self.fisher[i] = (1.0 - alpha) * self.fisher[i] + alpha * new_fisher;
            }
            self.star_weights = current_weights;
        }

        self.update_count += 1;
    }

    /// Compute EWC penalty for current weights vs star weights
    pub fn penalty(&self, lora: &MicroLoRA) -> f32 {
        if self.update_count == 0 {
            return 0.0;
        }

        let current = Self::flatten_lora(lora);
        let mut penalty = 0.0f32;
        for i in 0..current.len().min(self.star_weights.len()) {
            let diff = current[i] - self.star_weights[i];
            penalty += self.fisher[i] * diff * diff;
        }

        0.5 * self.lambda * penalty
    }

    /// Apply EWC regularization to LoRA weights (pull toward star weights)
    pub fn regularize(&self, lora: &mut MicroLoRA) {
        if self.update_count == 0 {
            return;
        }

        let lr = lora.lr;
        // Regularize A weights
        let a_size = EMBEDDING_DIM * LORA_RANK;
        for i in 0..a_size.min(self.star_weights.len()) {
            let reg_grad = self.lambda * self.fisher[i] * (lora.a[i] - self.star_weights[i]);
            lora.a[i] -= lr * reg_grad;
        }
        // Regularize B weights
        for i in 0..lora.b.len().min(self.star_weights.len().saturating_sub(a_size)) {
            let fi = i + a_size;
            let reg_grad = self.lambda * self.fisher[fi] * (lora.b[i] - self.star_weights[fi]);
            lora.b[i] -= lr * reg_grad;
        }
    }

    fn flatten_lora(lora: &MicroLoRA) -> Vec<f32> {
        let mut weights = Vec::with_capacity(lora.a.len() + lora.b.len());
        weights.extend_from_slice(&lora.a);
        weights.extend_from_slice(&lora.b);
        weights
    }
}

pub struct SonaEngine {
    pub learned: LearnedWeights,
    pub lora: MicroLoRA,
    pub ewc: EwcRegularizer,
}

/// Persisted SONA state (V2 with LoRA + EWC)
#[derive(Serialize, Deserialize)]
struct SonaStateV2 {
    learned: LearnedWeights,
    lora: MicroLoRA,
    ewc: EwcRegularizer,
}

/// Version byte for V2 SONA files
const SONA_VERSION_V2: u8 = 2;

impl SonaEngine {
    pub fn new() -> Self {
        Self {
            learned: LearnedWeights::default(),
            lora: MicroLoRA::default(),
            ewc: EwcRegularizer::default(),
        }
    }

    pub fn open(path: &Path) -> anyhow::Result<Self> {
        let bytes = std::fs::read(path)?;
        if bytes.is_empty() {
            return Ok(Self::new());
        }

        // Try V2 format first
        if bytes[0] == SONA_VERSION_V2 {
            let state: SonaStateV2 = bincode::deserialize(&bytes[1..])?;
            return Ok(Self {
                learned: state.learned,
                lora: state.lora,
                ewc: state.ewc,
            });
        }

        // Fallback: V1 format (just LearnedWeights)
        let learned: LearnedWeights = bincode::deserialize(&bytes)?;
        Ok(Self {
            learned,
            lora: MicroLoRA::default(),
            ewc: EwcRegularizer::default(),
        })
    }

    pub fn save(&self, path: &Path) -> anyhow::Result<()> {
        let state = SonaStateV2 {
            learned: self.learned.clone(),
            lora: self.lora.clone(),
            ewc: self.ewc.clone(),
        };
        let mut bytes = vec![SONA_VERSION_V2];
        bytes.extend(bincode::serialize(&state)?);
        std::fs::write(path, bytes)?;
        Ok(())
    }

    /// FNV-1a hash of normalized, sorted query terms (3+ chars)
    fn pattern_hash(query: &str) -> u64 {
        let lower = query.to_lowercase();
        let mut terms: Vec<&str> = lower
            .split_whitespace()
            .filter(|t| t.len() >= 3)
            .collect();
        terms.sort();
        terms.dedup();
        let mut h: u64 = 0xcbf29ce484222325;
        for t in &terms {
            for b in t.bytes() {
                h ^= b as u64;
                h = h.wrapping_mul(0x100000001b3);
            }
            h ^= 0xff;
        }
        h
    }

    /// Normalize query into lowercase terms (3+ chars), sorted and deduped.
    pub fn normalize_terms(query: &str) -> Vec<String> {
        let lower = query.to_lowercase();
        let mut terms: Vec<String> = lower
            .split_whitespace()
            .filter(|t| t.len() >= 3)
            .map(|t| t.to_string())
            .collect();
        terms.sort();
        terms.dedup();
        terms
    }

    /// Apply a feature adjustment map to metadata, returning the total delta.
    fn apply_features(adj: &HashMap<String, f32>, meta: &IndexMetadata) -> f32 {
        let mut delta = 0.0f32;
        if meta.is_plugin {
            delta += adj.get("is_plugin").unwrap_or(&0.0);
        }
        if meta.is_observer {
            delta += adj.get("is_observer").unwrap_or(&0.0);
        }
        if meta.is_controller {
            delta += adj.get("is_controller").unwrap_or(&0.0);
        }
        if meta.is_block {
            delta += adj.get("is_block").unwrap_or(&0.0);
        }
        if meta.class_name.is_some() {
            delta += adj.get("class_match").unwrap_or(&0.0);
        }
        if meta.magento_type.as_deref() == Some("di_config") || meta.file_type == "xml" {
            delta += adj.get("config_match").unwrap_or(&0.0);
        }
        // Specific config XML directory match (files under /etc/*.xml)
        let path_lower = meta.path.to_lowercase();
        if path_lower.contains("/etc/") && path_lower.ends_with(".xml") {
            delta += adj.get("config_xml_dir").unwrap_or(&0.0);
        }
        delta
    }

    /// Learn from a feedback signal
    pub fn learn(&mut self, signal: &SonaSignal) {
        let query = if signal.query.is_empty() {
            if let Some(ref q) = signal.original_query {
                q.as_str()
            } else {
                return;
            }
        } else {
            &signal.query
        };

        let feature = match signal.signal_type.as_str() {
            "refinement_to_plugin" => "is_plugin",
            "refinement_to_class" => "class_match",
            "refinement_to_config" => "config_match",
            "refinement_to_observer" => "is_observer",
            "refinement_to_controller" => "is_controller",
            "refinement_to_block" => "is_block",
            "trace_after_search" => "is_controller",
            _ => return,
        };

        // 1. Per-query-hash learning (strongest, existing behavior)
        let pattern = Self::pattern_hash(query);
        let count = self.learned.counts.entry(pattern).or_insert(0);
        *count += 1;
        let lr = BASE_LR / (1.0 + (*count as f32) * 0.1);

        let entry = self.learned.adjustments.entry(pattern).or_default();
        let w = entry.entry(feature.to_string()).or_insert(0.0);
        *w = (*w + lr).min(MAX_ADJUSTMENT);

        // For config refinements, also learn the more specific config_xml_dir feature
        if signal.signal_type == "refinement_to_config" {
            let w2 = entry.entry("config_xml_dir".to_string()).or_insert(0.0);
            *w2 = (*w2 + lr * 0.5).min(MAX_ADJUSTMENT);
        }

        // 2. Global bias learning (weakest, reduced rate)
        let global_lr = lr * 0.3;
        self.learned.global_count += 1;
        let gw = self.learned.global_bias.entry(feature.to_string()).or_insert(0.0);
        *gw = (*gw + global_lr).min(MAX_ADJUSTMENT);

        // 3. Per-term learning (medium strength)
        let terms = Self::normalize_terms(query);
        let term_lr = lr * 0.5;
        for term in &terms {
            let tc = self.learned.term_counts.entry(term.clone()).or_insert(0);
            *tc += 1;
            let term_entry = self.learned.term_adjustments.entry(term.clone()).or_default();
            let tw = term_entry.entry(feature.to_string()).or_insert(0.0);
            *tw = (*tw + term_lr).min(MAX_ADJUSTMENT);
        }

        // 4. Mild negative learning for features that weren't followed
        const NEGATIVE_LR_FACTOR: f32 = 0.1;
        let negative_features: &[&str] = &[
            "is_plugin", "is_observer", "is_controller", "is_block",
            "class_match", "config_match",
        ];
        for &neg_feat in negative_features {
            if neg_feat == feature {
                continue;
            }
            // Per-hash negative
            let entry = self.learned.adjustments.entry(pattern).or_default();
            let w = entry.entry(neg_feat.to_string()).or_insert(0.0);
            *w = (*w - lr * NEGATIVE_LR_FACTOR).max(-MAX_ADJUSTMENT);
            // Global negative
            let gw = self.learned.global_bias.entry(neg_feat.to_string()).or_insert(0.0);
            *gw = (*gw - global_lr * NEGATIVE_LR_FACTOR).max(-MAX_ADJUSTMENT);
            // Term negative
            for term in &terms {
                let te = self.learned.term_adjustments.entry(term.clone()).or_default();
                let tw = te.entry(neg_feat.to_string()).or_insert(0.0);
                *tw = (*tw - term_lr * NEGATIVE_LR_FACTOR).max(-MAX_ADJUSTMENT);
            }
        }
    }

    /// Compute score adjustment for a search result given the query.
    ///
    /// Uses 3-tier scoring:
    /// 1. Exact query-hash match (strongest)
    /// 2. Per-term matching (medium, enables cross-query generalization)
    /// 3. Global bias (weakest, always applies after any learning)
    pub fn score_adjustment(&self, query: &str, meta: &IndexMetadata) -> f32 {
        let mut delta = 0.0f32;

        // 1. Exact query-hash match (strongest, existing behavior)
        let pattern = Self::pattern_hash(query);
        if let Some(adj) = self.learned.adjustments.get(&pattern) {
            delta += Self::apply_features(adj, meta);
        }

        // 2. Term-level matching (medium strength)
        let terms = Self::normalize_terms(query);
        let mut term_sum = 0.0f32;
        let mut term_count = 0u32;
        for term in &terms {
            if let Some(adj) = self.learned.term_adjustments.get(term.as_str()) {
                term_sum += Self::apply_features(adj, meta);
                term_count += 1;
            }
        }
        if term_count > 0 {
            delta += (term_sum / term_count as f32) * 0.7;
        }

        // 3. Global bias (weakest, always applies if any learning has occurred)
        if self.learned.global_count > 0 {
            delta += Self::apply_features(&self.learned.global_bias, meta) * 0.3;
        }

        delta.clamp(-MAX_ADJUSTMENT, MAX_ADJUSTMENT)
    }

    /// Adjust a query embedding using the learned MicroLoRA adapter
    ///
    /// Called before HNSW search to adapt the embedding based on learned patterns.
    /// Modifies the embedding in-place.
    pub fn adjust_query_embedding(&self, embedding: &mut Vec<f32>) {
        if embedding.len() != EMBEDDING_DIM {
            return;
        }

        let original = embedding.clone();
        let adjusted = self.lora.forward(embedding);

        // Check cosine similarity between original and adjusted
        let dot: f32 = original.iter().zip(adjusted.iter()).map(|(a, b)| a * b).sum();
        let norm_orig: f32 = original.iter().map(|x| x * x).sum::<f32>().sqrt();
        let norm_adj: f32 = adjusted.iter().map(|x| x * x).sum::<f32>().sqrt();
        let similarity = if norm_orig > 0.0 && norm_adj > 0.0 {
            dot / (norm_orig * norm_adj)
        } else {
            1.0
        };

        // Only apply if adjustment isn't too destructive
        if similarity < MIN_LORA_SIMILARITY {
            return;
        }

        embedding.copy_from_slice(&adjusted);

        // L2-normalize after adjustment to maintain unit-length for cosine similarity
        let norm: f32 = embedding.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 0.0 {
            for x in embedding.iter_mut() {
                *x /= norm;
            }
        }
    }

    /// Learn from feedback with LoRA + EWC update
    ///
    /// If query/target embeddings are provided, also updates the MicroLoRA adapter
    /// with EWC regularization to prevent forgetting.
    pub fn learn_with_embeddings(
        &mut self,
        signal: &SonaSignal,
        query_emb: Option<&[f32]>,
        target_emb: Option<&[f32]>,
    ) {
        // Standard pattern learning
        self.learn(signal);

        // LoRA update if embeddings available
        if let (Some(q), Some(t)) = (query_emb, target_emb) {
            if q.len() == EMBEDDING_DIM && t.len() == EMBEDDING_DIM {
                self.lora.update_from_signal(q, t);
                self.ewc.regularize(&mut self.lora);
                self.ewc.update_fisher(&self.lora);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_meta(is_plugin: bool, is_observer: bool, is_controller: bool) -> IndexMetadata {
        IndexMetadata {
            path: String::new(),
            file_type: "php".to_string(),
            magento_type: None,
            class_name: None,
            class_type: None,
            method_name: None,
            methods: vec![],
            namespace: None,
            module: None,
            area: None,
            extends: None,
            implements: vec![],
            is_controller,
            is_repository: false,
            is_plugin,
            is_observer,
            is_model: false,
            is_block: false,
            is_resolver: false,
            is_api_interface: false,
            is_ui_component: false,
            is_widget: false,
            is_mixin: false,
            js_dependencies: vec![],
            search_text: String::new(),
        }
    }

    #[test]
    fn test_pattern_hash_stability() {
        let h1 = SonaEngine::pattern_hash("checkout cart totals");
        let h2 = SonaEngine::pattern_hash("checkout cart totals");
        assert_eq!(h1, h2);

        // Order-independent
        let h3 = SonaEngine::pattern_hash("totals cart checkout");
        assert_eq!(h1, h3);
    }

    #[test]
    fn test_learn_and_adjust() {
        let mut engine = SonaEngine::new();
        let signal = SonaSignal {
            signal_type: "refinement_to_plugin".to_string(),
            query: "checkout cart totals".to_string(),
            timestamp: 0,
            search_result_paths: vec![],
            followed_tool: None,
            followed_args: None,
            original_query: None,
            refined_query: None,
            original_result_paths: None,
        };
        engine.learn(&signal);

        let meta_plugin = make_meta(true, false, false);
        let meta_plain = make_meta(false, false, false);

        let adj_plugin = engine.score_adjustment("checkout cart totals", &meta_plugin);
        let adj_plain = engine.score_adjustment("checkout cart totals", &meta_plain);

        assert!(adj_plugin > 0.0, "Plugin should get positive adjustment");
        assert_eq!(adj_plain, 0.0, "Non-plugin should get zero adjustment");
    }

    #[test]
    fn test_adjustment_capped() {
        let mut engine = SonaEngine::new();
        let signal = SonaSignal {
            signal_type: "refinement_to_plugin".to_string(),
            query: "test query".to_string(),
            timestamp: 0,
            search_result_paths: vec![],
            followed_tool: None,
            followed_args: None,
            original_query: None,
            refined_query: None,
            original_result_paths: None,
        };
        // Learn many times
        for _ in 0..1000 {
            engine.learn(&signal);
        }

        let meta = make_meta(true, false, false);
        let adj = engine.score_adjustment("test query", &meta);
        assert!(
            adj <= MAX_ADJUSTMENT,
            "Adjustment {} should never exceed {}",
            adj,
            MAX_ADJUSTMENT
        );
    }

    #[test]
    fn test_learning_rate_decay() {
        let mut engine = SonaEngine::new();
        let signal = SonaSignal {
            signal_type: "refinement_to_plugin".to_string(),
            query: "product price".to_string(),
            timestamp: 0,
            search_result_paths: vec![],
            followed_tool: None,
            followed_args: None,
            original_query: None,
            refined_query: None,
            original_result_paths: None,
        };

        engine.learn(&signal);
        let meta = make_meta(true, false, false);
        let adj1 = engine.score_adjustment("product price", &meta);

        engine.learn(&signal);
        let adj2 = engine.score_adjustment("product price", &meta);

        let delta2 = adj2 - adj1;
        // Second learning should produce a smaller delta than the first
        assert!(delta2 < adj1, "Learning rate should decay");
    }

    #[test]
    fn test_empty_returns_zero() {
        let engine = SonaEngine::new();
        let meta = make_meta(true, true, true);
        let adj = engine.score_adjustment("never seen query", &meta);
        assert_eq!(adj, 0.0);
    }

    #[test]
    fn test_persistence_roundtrip() {
        let dir = std::env::temp_dir().join("magector_sona_test");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("test.sona");

        let mut engine = SonaEngine::new();
        let signal = SonaSignal {
            signal_type: "refinement_to_observer".to_string(),
            query: "event dispatch".to_string(),
            timestamp: 0,
            search_result_paths: vec![],
            followed_tool: None,
            followed_args: None,
            original_query: None,
            refined_query: None,
            original_result_paths: None,
        };
        engine.learn(&signal);
        engine.save(&path).unwrap();

        let loaded = SonaEngine::open(&path).unwrap();
        let meta = make_meta(false, true, false);
        let adj_orig = engine.score_adjustment("event dispatch", &meta);
        let adj_loaded = loaded.score_adjustment("event dispatch", &meta);
        assert_eq!(adj_orig, adj_loaded);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ─── MicroLoRA tests ───────────────────────────────────────

    #[test]
    fn test_lora_default_init() {
        let lora = MicroLoRA::default();
        assert_eq!(lora.a.len(), EMBEDDING_DIM * LORA_RANK);
        assert_eq!(lora.b.len(), LORA_RANK * EMBEDDING_DIM);
        // Should not be all zeros (initialized with pseudo-random values)
        assert!(lora.a.iter().any(|&v| v != 0.0));
    }

    #[test]
    fn test_lora_forward_preserves_dim() {
        let lora = MicroLoRA::default();
        let embedding = vec![0.1f32; EMBEDDING_DIM];
        let result = lora.forward(&embedding);
        assert_eq!(result.len(), EMBEDDING_DIM);
    }

    #[test]
    fn test_lora_forward_modifies_embedding() {
        let lora = MicroLoRA::default();
        let embedding = vec![0.1f32; EMBEDDING_DIM];
        let result = lora.forward(&embedding);
        // Should not be identical (LoRA adds a delta)
        assert!(result.iter().zip(embedding.iter()).any(|(a, b)| (a - b).abs() > 1e-10));
    }

    #[test]
    fn test_lora_update_changes_weights() {
        let mut lora = MicroLoRA::default();
        let a_before = lora.a.clone();

        let query = vec![0.1f32; EMBEDDING_DIM];
        let mut target = vec![0.2f32; EMBEDDING_DIM];
        target[0] = 0.5; // Make target different

        lora.update_from_signal(&query, &target);
        // Weights should have changed
        assert!(lora.a.iter().zip(a_before.iter()).any(|(a, b)| (a - b).abs() > 1e-10));
    }

    #[test]
    fn test_adjust_query_embedding() {
        let engine = SonaEngine::new();
        let mut embedding = vec![0.1f32; EMBEDDING_DIM];
        let original = embedding.clone();

        engine.adjust_query_embedding(&mut embedding);

        // Should be modified
        assert!(embedding.iter().zip(original.iter()).any(|(a, b)| (a - b).abs() > 1e-10));

        // Should be L2-normalized
        let norm: f32 = embedding.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-5, "Embedding should be L2-normalized, got norm={}", norm);
    }

    // ─── EWC tests ────────────────────────────────────────────

    #[test]
    fn test_ewc_default() {
        let ewc = EwcRegularizer::default();
        assert_eq!(ewc.update_count, 0);
        assert_eq!(ewc.lambda, EWC_LAMBDA);
    }

    #[test]
    fn test_ewc_penalty_zero_initially() {
        let ewc = EwcRegularizer::default();
        let lora = MicroLoRA::default();
        assert_eq!(ewc.penalty(&lora), 0.0);
    }

    #[test]
    fn test_ewc_fisher_update() {
        let mut ewc = EwcRegularizer::default();
        let lora = MicroLoRA::default();

        ewc.update_fisher(&lora);
        assert_eq!(ewc.update_count, 1);
        assert_eq!(ewc.star_weights.len(), lora.a.len() + lora.b.len());
    }

    #[test]
    fn test_ewc_regularize_pulls_toward_star() {
        let mut lora = MicroLoRA::default();
        let mut ewc = EwcRegularizer::default();

        // Record initial state
        ewc.update_fisher(&lora);

        // Perturb weights
        for v in lora.a.iter_mut() {
            *v += 0.1;
        }
        let perturbed_a = lora.a.clone();

        // Update fisher with perturbed weights (so fisher > 0)
        ewc.update_fisher(&lora);

        // Perturb again
        for v in lora.a.iter_mut() {
            *v += 0.1;
        }

        // Regularize should pull weights back toward star
        ewc.regularize(&mut lora);

        // At least some weights should be closer to star_weights than the perturbed values
        let mut closer_count = 0;
        for i in 0..lora.a.len().min(ewc.star_weights.len()) {
            let dist_before = (perturbed_a[i] + 0.1 - ewc.star_weights[i]).abs();
            let dist_after = (lora.a[i] - ewc.star_weights[i]).abs();
            if dist_after < dist_before {
                closer_count += 1;
            }
        }
        // Some weights should be pulled closer (not all, depends on fisher values)
        assert!(closer_count > 0 || ewc.fisher.iter().all(|&f| f == 0.0));
    }

    #[test]
    fn test_v2_persistence_with_lora() {
        let dir = std::env::temp_dir().join("magector_sona_v2_test");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("test_v2.sona");

        let mut engine = SonaEngine::new();
        // Modify LoRA weights
        engine.lora.a[0] = 42.0;
        engine.ewc.update_fisher(&engine.lora);

        engine.save(&path).unwrap();
        let loaded = SonaEngine::open(&path).unwrap();

        assert_eq!(loaded.lora.a[0], 42.0);
        assert_eq!(loaded.ewc.update_count, 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_learn_with_embeddings() {
        let mut engine = SonaEngine::new();
        let signal = SonaSignal {
            signal_type: "refinement_to_plugin".to_string(),
            query: "checkout cart totals".to_string(),
            timestamp: 0,
            search_result_paths: vec![],
            followed_tool: None,
            followed_args: None,
            original_query: None,
            refined_query: None,
            original_result_paths: None,
        };

        let query_emb = vec![0.1f32; EMBEDDING_DIM];
        let target_emb = vec![0.2f32; EMBEDDING_DIM];
        let a_before = engine.lora.a.clone();

        engine.learn_with_embeddings(&signal, Some(&query_emb), Some(&target_emb));

        // LoRA weights should have changed
        assert!(engine.lora.a.iter().zip(a_before.iter()).any(|(a, b)| (a - b).abs() > 1e-10));
        // EWC should have been updated
        assert!(engine.ewc.update_count > 0);
        // Pattern learning should still work
        let meta = make_meta(true, false, false);
        assert!(engine.score_adjustment("checkout cart totals", &meta) > 0.0);
    }
}
