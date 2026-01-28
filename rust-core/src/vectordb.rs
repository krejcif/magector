//! HNSW-based vector database with persistence
//!
//! Provides efficient similarity search for code embeddings

use anyhow::{Context, Result};
use hnsw_rs::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter};
use std::path::Path;

use crate::embedder::EMBEDDING_DIM;

/// Metadata associated with each indexed item
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexMetadata {
    pub path: String,
    pub file_type: String,
    pub magento_type: Option<String>,
    pub class_name: Option<String>,
    pub class_type: Option<String>,
    pub method_name: Option<String>,
    pub methods: Vec<String>,
    pub namespace: Option<String>,
    pub module: Option<String>,
    pub area: Option<String>,
    pub extends: Option<String>,
    pub implements: Vec<String>,
    pub is_controller: bool,
    pub is_repository: bool,
    pub is_plugin: bool,
    pub is_observer: bool,
    pub is_model: bool,
    pub is_block: bool,
    pub is_resolver: bool,
    pub is_api_interface: bool,
    // JavaScript specific
    pub is_ui_component: bool,
    pub is_widget: bool,
    pub is_mixin: bool,
    pub js_dependencies: Vec<String>,
    pub search_text: String,
}

/// Search result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub id: usize,
    pub score: f32,
    pub metadata: IndexMetadata,
}

/// Persisted state
#[derive(Serialize, Deserialize)]
struct PersistedState {
    metadata: HashMap<usize, IndexMetadata>,
    vectors: HashMap<usize, Vec<f32>>,
    next_id: usize,
}

/// Vector database for semantic code search
pub struct VectorDB {
    hnsw: Hnsw<'static, f32, DistCosine>,
    metadata: HashMap<usize, IndexMetadata>,
    vectors: HashMap<usize, Vec<f32>>, // Store vectors for persistence
    next_id: usize,
}

impl VectorDB {
    /// Create a new empty vector database
    pub fn new() -> Self {
        let hnsw = Hnsw::new(
            32,             // max_nb_connection (M)
            100_000,        // capacity
            16,             // max layer
            200,            // ef_construction
            DistCosine {},
        );

        Self {
            hnsw,
            metadata: HashMap::new(),
            vectors: HashMap::new(),
            next_id: 0,
        }
    }

    /// Load from disk or create new
    pub fn open(path: &Path) -> Result<Self> {
        let metadata_path = path.with_extension("json");
        if metadata_path.exists() {
            Self::load(path)
        } else {
            Ok(Self::new())
        }
    }

    /// Load existing database from disk
    pub fn load(path: &Path) -> Result<Self> {
        let metadata_path = path.with_extension("json");

        // Load state
        let file = File::open(&metadata_path)
            .context("Failed to open database file")?;
        let reader = BufReader::new(file);
        let state: PersistedState = serde_json::from_reader(reader)
            .context("Failed to parse database")?;

        // Rebuild HNSW index
        let hnsw = Hnsw::new(32, state.vectors.len().max(100_000), 16, 200, DistCosine {});

        for (&id, vector) in &state.vectors {
            hnsw.insert((vector, id));
        }

        Ok(Self {
            hnsw,
            metadata: state.metadata,
            vectors: state.vectors,
            next_id: state.next_id,
        })
    }

    /// Save database to disk
    pub fn save(&self, path: &Path) -> Result<()> {
        fs::create_dir_all(path.parent().unwrap_or(Path::new(".")))?;

        let metadata_path = path.with_extension("json");

        let state = PersistedState {
            metadata: self.metadata.clone(),
            vectors: self.vectors.clone(),
            next_id: self.next_id,
        };

        let file = File::create(&metadata_path)?;
        let writer = BufWriter::new(file);
        serde_json::to_writer(writer, &state)?;

        Ok(())
    }

    /// Insert a vector with metadata
    pub fn insert(&mut self, vector: &[f32], metadata: IndexMetadata) -> usize {
        assert_eq!(vector.len(), EMBEDDING_DIM);

        let id = self.next_id;
        self.next_id += 1;

        let vec = vector.to_vec();

        // Insert into HNSW
        self.hnsw.insert((&vec, id));

        // Store for persistence
        self.vectors.insert(id, vec);
        self.metadata.insert(id, metadata);

        id
    }

    /// Search for similar vectors
    pub fn search(&self, query: &[f32], k: usize) -> Vec<SearchResult> {
        assert_eq!(query.len(), EMBEDDING_DIM);

        let ef_search = (k * 2).max(100);
        let results = self.hnsw.search(query, k, ef_search);

        results
            .into_iter()
            .filter_map(|n| {
                let id = n.d_id;
                self.metadata.get(&id).map(|meta| SearchResult {
                    id,
                    score: 1.0 - n.distance, // Convert distance to similarity
                    metadata: meta.clone(),
                })
            })
            .collect()
    }

    /// Get total number of vectors
    pub fn len(&self) -> usize {
        self.metadata.len()
    }

    /// Check if empty
    pub fn is_empty(&self) -> bool {
        self.metadata.is_empty()
    }

    /// Clear all data
    pub fn clear(&mut self) {
        self.hnsw = Hnsw::new(32, 100_000, 16, 200, DistCosine {});
        self.metadata.clear();
        self.vectors.clear();
        self.next_id = 0;
    }
}

impl Default for VectorDB {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_insert_search() {
        let mut db = VectorDB::new();

        let vector = vec![0.1f32; EMBEDDING_DIM];
        let metadata = IndexMetadata {
            path: "test.php".to_string(),
            file_type: "php".to_string(),
            magento_type: None,
            class_name: None,
            class_type: None,
            method_name: None,
            methods: Vec::new(),
            namespace: None,
            module: None,
            area: None,
            extends: None,
            implements: Vec::new(),
            is_controller: false,
            is_repository: false,
            is_plugin: false,
            is_observer: false,
            is_model: false,
            is_block: false,
            is_resolver: false,
            is_api_interface: false,
            is_ui_component: false,
            is_widget: false,
            is_mixin: false,
            js_dependencies: Vec::new(),
            search_text: "test".to_string(),
        };

        db.insert(&vector, metadata);

        let results = db.search(&vector, 1);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].metadata.path, "test.php");
    }
}
