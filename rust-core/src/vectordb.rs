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

/// Default HNSW parameters
const HNSW_M: usize = 32;             // max connections per node
const HNSW_MAX_LAYER: usize = 16;
const HNSW_EF_CONSTRUCTION: usize = 200;
const HNSW_MIN_CAPACITY: usize = 1_000;

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

/// Persisted state — serialized with bincode for speed, JSON as fallback for loading
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
    vectors: HashMap<usize, Vec<f32>>,
    next_id: usize,
}

fn make_hnsw(capacity: usize) -> Hnsw<'static, f32, DistCosine> {
    Hnsw::new(
        HNSW_M,
        capacity.max(HNSW_MIN_CAPACITY),
        HNSW_MAX_LAYER,
        HNSW_EF_CONSTRUCTION,
        DistCosine {},
    )
}

impl VectorDB {
    /// Create a new empty vector database
    pub fn new() -> Self {
        Self {
            hnsw: make_hnsw(HNSW_MIN_CAPACITY),
            metadata: HashMap::new(),
            vectors: HashMap::new(),
            next_id: 0,
        }
    }

    /// Create with a capacity hint (avoids HNSW resizing)
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            hnsw: make_hnsw(capacity),
            metadata: HashMap::with_capacity(capacity),
            vectors: HashMap::with_capacity(capacity),
            next_id: 0,
        }
    }

    /// Load from disk or create new
    pub fn open(path: &Path) -> Result<Self> {
        // Try bincode first, then JSON fallback
        let bincode_path = path.with_extension("bin");
        let json_path = path.with_extension("json");

        if bincode_path.exists() {
            return Self::load_bincode(&bincode_path);
        }
        if json_path.exists() {
            return Self::load_json(&json_path);
        }
        Ok(Self::new())
    }

    /// Load from bincode format (fast)
    fn load_bincode(path: &Path) -> Result<Self> {
        let file = File::open(path).context("Failed to open bincode database")?;
        let reader = BufReader::with_capacity(1 << 20, file); // 1MB buffer
        let state: PersistedState = bincode::deserialize_from(reader)
            .context("Failed to parse bincode database")?;
        Self::from_state(state)
    }

    /// Load from JSON format (legacy compatibility)
    fn load_json(path: &Path) -> Result<Self> {
        let file = File::open(path).context("Failed to open JSON database")?;
        let reader = BufReader::new(file);
        let state: PersistedState = serde_json::from_reader(reader)
            .context("Failed to parse JSON database")?;
        Self::from_state(state)
    }

    /// Rebuild HNSW from persisted state using parallel batch insert
    fn from_state(state: PersistedState) -> Result<Self> {
        let capacity = state.vectors.len().max(HNSW_MIN_CAPACITY);
        let hnsw = make_hnsw(capacity);

        // Batch insert all vectors at once (parallel internally via hnsw_rs)
        let data: Vec<(&Vec<f32>, usize)> = state.vectors.iter()
            .map(|(&id, vec)| (vec, id))
            .collect();
        hnsw.parallel_insert(&data);

        Ok(Self {
            hnsw,
            metadata: state.metadata,
            vectors: state.vectors,
            next_id: state.next_id,
        })
    }

    /// Save database to disk (bincode format)
    pub fn save(&self, path: &Path) -> Result<()> {
        fs::create_dir_all(path.parent().unwrap_or(Path::new(".")))?;

        let bincode_path = path.with_extension("bin");

        // Serialize directly — no clone needed, bincode serializes by reference
        let state = PersistedState {
            metadata: self.metadata.clone(),
            vectors: self.vectors.clone(),
            next_id: self.next_id,
        };

        let file = File::create(&bincode_path)?;
        let writer = BufWriter::with_capacity(1 << 20, file); // 1MB buffer
        bincode::serialize_into(writer, &state)
            .context("Failed to serialize database")?;

        // Remove legacy JSON file if it exists
        let json_path = path.with_extension("json");
        if json_path.exists() {
            let _ = fs::remove_file(&json_path);
        }

        Ok(())
    }

    /// Insert a vector with metadata
    pub fn insert(&mut self, vector: &[f32], metadata: IndexMetadata) -> usize {
        assert_eq!(vector.len(), EMBEDDING_DIM);

        let id = self.next_id;
        self.next_id += 1;

        let vec = vector.to_vec();
        self.hnsw.insert((&vec, id));
        self.vectors.insert(id, vec);
        self.metadata.insert(id, metadata);

        id
    }

    /// Batch insert vectors with metadata (uses parallel HNSW insert)
    pub fn insert_batch(&mut self, items: Vec<(Vec<f32>, IndexMetadata)>) {
        if items.is_empty() {
            return;
        }

        let start_id = self.next_id;

        // Assign IDs and store metadata + vectors
        for (i, (vec, meta)) in items.iter().enumerate() {
            let id = start_id + i;
            self.vectors.insert(id, vec.clone());
            self.metadata.insert(id, meta.clone());
        }

        // Build references for parallel HNSW insert
        let data: Vec<(&Vec<f32>, usize)> = (0..items.len())
            .map(|i| {
                let id = start_id + i;
                (self.vectors.get(&id).unwrap(), id)
            })
            .collect();

        self.hnsw.parallel_insert(&data);
        self.next_id = start_id + items.len();
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
                    score: 1.0 - n.distance,
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
        self.hnsw = make_hnsw(HNSW_MIN_CAPACITY);
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

    #[test]
    fn test_batch_insert() {
        let mut db = VectorDB::with_capacity(10);

        let items: Vec<(Vec<f32>, IndexMetadata)> = (0..5)
            .map(|i| {
                let mut vec = vec![0.0f32; EMBEDDING_DIM];
                vec[0] = i as f32 * 0.1;
                let meta = IndexMetadata {
                    path: format!("test_{}.php", i),
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
                    search_text: format!("test {}", i),
                };
                (vec, meta)
            })
            .collect();

        db.insert_batch(items);
        assert_eq!(db.len(), 5);

        let query = vec![0.0f32; EMBEDDING_DIM];
        let results = db.search(&query, 3);
        assert!(results.len() <= 3);
    }
}
