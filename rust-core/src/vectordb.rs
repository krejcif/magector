//! HNSW-based vector database with persistence
//!
//! Provides efficient similarity search for code embeddings

use anyhow::{Context, Result};
use hnsw_rs::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::BufWriter;
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

/// Persisted state V1 — legacy format (no tombstones)
#[derive(Serialize, Deserialize)]
struct PersistedState {
    metadata: HashMap<usize, IndexMetadata>,
    vectors: HashMap<usize, Vec<f32>>,
    next_id: usize,
}

/// Version tag written before V2 payloads
const PERSIST_VERSION_V2: u8 = 2;

/// Persisted state V2 — includes tombstone set
#[derive(Serialize, Deserialize)]
struct PersistedStateV2 {
    metadata: HashMap<usize, IndexMetadata>,
    vectors: HashMap<usize, Vec<f32>>,
    next_id: usize,
    tombstones: HashSet<usize>,
}

/// Vector database for semantic code search
pub struct VectorDB {
    hnsw: Hnsw<'static, f32, DistCosine>,
    metadata: HashMap<usize, IndexMetadata>,
    vectors: HashMap<usize, Vec<f32>>,
    next_id: usize,
    tombstones: HashSet<usize>,
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
            tombstones: HashSet::new(),
        }
    }

    /// Create with a capacity hint (avoids HNSW resizing)
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            hnsw: make_hnsw(capacity),
            metadata: HashMap::with_capacity(capacity),
            vectors: HashMap::with_capacity(capacity),
            next_id: 0,
            tombstones: HashSet::new(),
        }
    }

    /// Load from disk or create new.
    ///
    /// Reads directly from `path`. As a one-time migration fallback, also
    /// checks for a legacy `.bin` file (e.g. `magector.bin` when path is
    /// `magector.db`) and migrates it in place.
    pub fn open(path: &Path) -> Result<Self> {
        if path.exists() {
            match Self::load(path) {
                Ok(db) => return Ok(db),
                Err(e) => {
                    // Check if this is a format mismatch (schema changed)
                    let is_format_error = e.chain()
                        .any(|c| c.to_string().contains("FormatChanged") || c.to_string().contains("schema mismatch"));
                    if is_format_error {
                        tracing::warn!(
                            "Database format incompatible at {:?}. Removing old database — re-index required.",
                            path
                        );
                        let _ = fs::remove_file(path);
                        return Ok(Self::new());
                    }
                    return Err(e);
                }
            }
        }

        // One-time migration: old versions saved to <stem>.bin
        let legacy_bin = path.with_extension("bin");
        if legacy_bin.exists() {
            tracing::info!("Migrating legacy database {:?} -> {:?}", legacy_bin, path);
            fs::rename(&legacy_bin, path)?;
            match Self::load(path) {
                Ok(db) => return Ok(db),
                Err(_) => {
                    tracing::warn!("Legacy database format incompatible. Removing.");
                    let _ = fs::remove_file(path);
                    return Ok(Self::new());
                }
            }
        }

        Ok(Self::new())
    }

    /// Load database from a bincode file (V2 with tombstones, V1 fallback).
    /// Returns `Err` with `FormatChanged` context if the schema is incompatible.
    fn load(path: &Path) -> Result<Self> {
        let bytes = fs::read(path).context("Failed to read database")?;
        if bytes.is_empty() {
            return Ok(Self::new());
        }

        // Try V2 first: first byte == PERSIST_VERSION_V2
        if bytes[0] == PERSIST_VERSION_V2 {
            match bincode::deserialize::<PersistedStateV2>(&bytes[1..]) {
                Ok(state) => return Self::from_state_v2(state),
                Err(e) => {
                    tracing::warn!("V2 database format incompatible: {e}");
                    return Err(anyhow::anyhow!("Database format changed (schema mismatch). Re-index required."))
                        .context("FormatChanged");
                }
            }
        }

        // Fallback: V1 (no version byte)
        match bincode::deserialize::<PersistedState>(&bytes) {
            Ok(state) => Self::from_state(state),
            Err(e) => {
                tracing::warn!("V1 database format incompatible: {e}");
                Err(anyhow::anyhow!("Database format changed (schema mismatch). Re-index required."))
                    .context("FormatChanged")
            }
        }
    }

    /// Check if a database file is compatible with the current format.
    /// Returns `true` if the file can be loaded, `false` if it needs re-indexing.
    pub fn check_format(path: &Path) -> bool {
        if !path.exists() {
            return true; // No file = will create new
        }
        let bytes = match fs::read(path) {
            Ok(b) => b,
            Err(_) => return false,
        };
        if bytes.is_empty() {
            return true;
        }

        if bytes[0] == PERSIST_VERSION_V2 {
            bincode::deserialize::<PersistedStateV2>(&bytes[1..]).is_ok()
        } else {
            bincode::deserialize::<PersistedState>(&bytes).is_ok()
        }
    }

    /// Rebuild HNSW from persisted V1 state
    fn from_state(state: PersistedState) -> Result<Self> {
        let capacity = state.vectors.len().max(HNSW_MIN_CAPACITY);
        let hnsw = make_hnsw(capacity);

        let data: Vec<(&Vec<f32>, usize)> = state.vectors.iter()
            .map(|(&id, vec)| (vec, id))
            .collect();
        hnsw.parallel_insert(&data);

        Ok(Self {
            hnsw,
            metadata: state.metadata,
            vectors: state.vectors,
            next_id: state.next_id,
            tombstones: HashSet::new(),
        })
    }

    /// Rebuild HNSW from persisted V2 state (skip tombstoned vectors)
    fn from_state_v2(state: PersistedStateV2) -> Result<Self> {
        let live_count = state.vectors.len().saturating_sub(state.tombstones.len());
        let capacity = live_count.max(HNSW_MIN_CAPACITY);
        let hnsw = make_hnsw(capacity);

        // Only insert non-tombstoned vectors
        let data: Vec<(&Vec<f32>, usize)> = state.vectors.iter()
            .filter(|(id, _)| !state.tombstones.contains(id))
            .map(|(&id, vec)| (vec, id))
            .collect();
        hnsw.parallel_insert(&data);

        Ok(Self {
            hnsw,
            metadata: state.metadata,
            vectors: state.vectors,
            next_id: state.next_id,
            tombstones: state.tombstones,
        })
    }

    /// Save database to disk (V2 bincode format with tombstones)
    pub fn save(&self, path: &Path) -> Result<()> {
        fs::create_dir_all(path.parent().unwrap_or(Path::new(".")))?;

        let state = PersistedStateV2 {
            metadata: self.metadata.clone(),
            vectors: self.vectors.clone(),
            next_id: self.next_id,
            tombstones: self.tombstones.clone(),
        };

        let file = File::create(path)?;
        let mut writer = BufWriter::with_capacity(1 << 20, file);
        // Write version byte, then V2 payload
        use std::io::Write;
        writer.write_all(&[PERSIST_VERSION_V2])?;
        bincode::serialize_into(writer, &state)
            .context("Failed to serialize database")?;

        // Clean up legacy files from old versions
        for ext in &["bin", "json"] {
            let legacy = path.with_extension(ext);
            if legacy != path && legacy.exists() {
                let _ = fs::remove_file(&legacy);
            }
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

    /// Search for similar vectors (pure semantic), filtering tombstoned IDs
    pub fn search(&self, query: &[f32], k: usize) -> Vec<SearchResult> {
        assert_eq!(query.len(), EMBEDDING_DIM);

        // Fetch extra candidates to compensate for tombstoned entries
        let extra = if self.tombstones.is_empty() { 0 } else { self.tombstones.len().min(k) };
        let fetch = k + extra;
        let ef_search = (fetch * 2).max(50);
        let results = self.hnsw.search(query, fetch, ef_search);

        results
            .into_iter()
            .filter(|n| !self.tombstones.contains(&n.d_id))
            .filter_map(|n| {
                let id = n.d_id;
                self.metadata.get(&id).map(|meta| SearchResult {
                    id,
                    score: 1.0 - n.distance,
                    metadata: meta.clone(),
                })
            })
            .take(k)
            .collect()
    }

    /// Hybrid search: semantic + keyword re-ranking
    ///
    /// Fetches extra candidates from HNSW, then boosts scores based on
    /// keyword matches in path and search_text. This significantly improves
    /// accuracy for type-specific queries (helper, plugin, di.xml, setup, etc.)
    pub fn hybrid_search(
        &self,
        query: &[f32],
        query_text: &str,
        k: usize,
        sona: Option<&crate::sona::SonaEngine>,
    ) -> Vec<SearchResult> {
        assert_eq!(query.len(), EMBEDDING_DIM);

        // Fetch 3x candidates for re-ranking (plus tombstone headroom)
        let extra = if self.tombstones.is_empty() { 0 } else { self.tombstones.len().min(k) };
        let candidates = k * 3 + extra;
        let ef_search = (candidates * 2).max(64);
        let results = self.hnsw.search(query, candidates, ef_search);

        // Lowercase query terms for matching
        let query_lower = query_text.to_lowercase();
        let query_terms: Vec<&str> = query_lower.split_whitespace().collect();

        // Detect specific file/type patterns in query for strong boosting
        let wants_di_xml = query_lower.contains("di.xml");
        let wants_db_schema = query_lower.contains("db_schema");
        let wants_helper = query_terms.contains(&"helper");
        let wants_plugin = query_terms.contains(&"plugin");
        let wants_repository = query_terms.contains(&"repository");
        let wants_setup = query_terms.contains(&"setup");
        let wants_observer = query_terms.contains(&"observer");

        let mut scored: Vec<SearchResult> = results
            .into_iter()
            .filter(|n| !self.tombstones.contains(&n.d_id))
            .filter_map(|n| {
                let id = n.d_id;
                self.metadata.get(&id).map(|meta| {
                    let semantic_score = 1.0 - n.distance;

                    // Compute keyword bonus from path and search_text
                    let path_lower = meta.path.to_lowercase();
                    let search_lower = meta.search_text.to_lowercase();

                    let mut keyword_bonus: f32 = 0.0;
                    let mut matched_terms = 0u32;

                    for term in &query_terms {
                        if term.len() < 3 { continue; }

                        // Path match is strongest signal
                        if path_lower.contains(term) {
                            keyword_bonus += 0.08;
                            matched_terms += 1;
                        }
                        // Search text match
                        if search_lower.contains(term) {
                            keyword_bonus += 0.03;
                            matched_terms += 1;
                        }
                        // Class name match
                        if let Some(ref cn) = meta.class_name {
                            if cn.to_lowercase().contains(term) {
                                keyword_bonus += 0.06;
                                matched_terms += 1;
                            }
                        }
                        // Magento type match (e.g. "helper", "plugin", "di_config")
                        if let Some(ref mt) = meta.magento_type {
                            let mt_lower = mt.to_lowercase();
                            if mt_lower.contains(term) || term.replace('.', "_") == mt_lower {
                                keyword_bonus += 0.10;
                                matched_terms += 1;
                            }
                        }
                    }

                    // Strong type-specific boosts when query explicitly names a type
                    let mtype = meta.magento_type.as_deref().unwrap_or("");
                    if wants_di_xml && (mtype == "di_config" || path_lower.ends_with("di.xml")) {
                        keyword_bonus += 0.20;
                    }
                    if wants_db_schema && (mtype == "db_schema" || path_lower.ends_with("db_schema.xml")) {
                        keyword_bonus += 0.20;
                    }
                    if wants_helper && (mtype == "helper" || path_lower.contains("/helper/")) {
                        keyword_bonus += 0.15;
                    }
                    if wants_plugin && (mtype == "plugin" || path_lower.contains("/plugin/") || meta.is_plugin) {
                        keyword_bonus += 0.15;
                    }
                    if wants_repository && (mtype == "repository" || meta.is_repository) {
                        keyword_bonus += 0.15;
                    }
                    if wants_setup && (mtype == "setup" || path_lower.contains("/setup/")) {
                        keyword_bonus += 0.15;
                    }
                    if wants_observer && (mtype == "observer" || path_lower.contains("/observer/") || meta.is_observer) {
                        keyword_bonus += 0.15;
                    }

                    // Multi-term bonus: reward results matching many query terms
                    if matched_terms >= 3 {
                        keyword_bonus += 0.05;
                    }

                    // Cap keyword bonus to avoid overwhelming semantic score
                    let keyword_bonus = keyword_bonus.min(0.45);
                    let sona_adj = sona.map(|s| s.score_adjustment(query_text, meta)).unwrap_or(0.0);
                    let final_score = semantic_score + keyword_bonus + sona_adj;

                    SearchResult {
                        id,
                        score: final_score,
                        metadata: meta.clone(),
                    }
                })
            })
            .collect();

        // Sort by final score descending and take top k
        scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(k);
        scored
    }

    /// Mark a vector ID as tombstoned (soft-delete)
    pub fn tombstone(&mut self, id: usize) {
        self.tombstones.insert(id);
    }

    /// Remove all vectors whose metadata path matches the given path.
    /// Returns the IDs that were tombstoned.
    pub fn remove_by_path(&mut self, path: &str) -> Vec<usize> {
        let ids: Vec<usize> = self.metadata.iter()
            .filter(|(_, meta)| meta.path == path)
            .map(|(&id, _)| id)
            .collect();
        for &id in &ids {
            self.tombstones.insert(id);
        }
        ids
    }

    /// Ratio of tombstoned entries to total vectors (0.0 – 1.0)
    pub fn tombstone_ratio(&self) -> f64 {
        if self.vectors.is_empty() {
            return 0.0;
        }
        self.tombstones.len() as f64 / self.vectors.len() as f64
    }

    /// Compact: rebuild HNSW and purge tombstoned entries from all maps.
    /// This reclaims memory and restores search performance.
    pub fn compact(&mut self) {
        if self.tombstones.is_empty() {
            return;
        }

        // Remove tombstoned entries from metadata and vectors
        for &id in &self.tombstones {
            self.metadata.remove(&id);
            self.vectors.remove(&id);
        }

        // Rebuild HNSW from live vectors
        let capacity = self.vectors.len().max(HNSW_MIN_CAPACITY);
        self.hnsw = make_hnsw(capacity);
        let data: Vec<(&Vec<f32>, usize)> = self.vectors.iter()
            .map(|(&id, vec)| (vec, id))
            .collect();
        if !data.is_empty() {
            self.hnsw.parallel_insert(&data);
        }

        self.tombstones.clear();
    }

    /// Get total number of live (non-tombstoned) vectors
    pub fn len(&self) -> usize {
        self.metadata.len().saturating_sub(self.tombstones.len())
    }

    /// Check if empty (no live vectors)
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Clear all data
    pub fn clear(&mut self) {
        self.hnsw = make_hnsw(HNSW_MIN_CAPACITY);
        self.metadata.clear();
        self.vectors.clear();
        self.tombstones.clear();
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

    fn make_test_meta(path: &str) -> IndexMetadata {
        IndexMetadata {
            path: path.to_string(),
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

        }
    }

    #[test]
    fn test_tombstone_filters_search() {
        let mut db = VectorDB::new();

        let v1 = vec![0.1f32; EMBEDDING_DIM];
        let v2 = vec![0.2f32; EMBEDDING_DIM];
        let id1 = db.insert(&v1, make_test_meta("file1.php"));
        let _id2 = db.insert(&v2, make_test_meta("file2.php"));

        // Before tombstone: both found
        let results = db.search(&v1, 10);
        assert!(results.len() >= 1);

        // Tombstone id1
        db.tombstone(id1);

        // After tombstone: id1 should be filtered out
        let results = db.search(&v1, 10);
        assert!(results.iter().all(|r| r.id != id1));
    }

    #[test]
    fn test_remove_by_path() {
        let mut db = VectorDB::new();
        let v = vec![0.1f32; EMBEDDING_DIM];
        db.insert(&v, make_test_meta("remove_me.php"));
        db.insert(&v, make_test_meta("keep_me.php"));

        let removed = db.remove_by_path("remove_me.php");
        assert_eq!(removed.len(), 1);
        assert_eq!(db.len(), 1); // only keep_me.php remains live
    }

    #[test]
    fn test_compact_rebuilds() {
        let mut db = VectorDB::new();
        let v = vec![0.1f32; EMBEDDING_DIM];
        let id = db.insert(&v, make_test_meta("old.php"));
        db.insert(&v, make_test_meta("new.php"));

        db.tombstone(id);
        assert!(db.tombstone_ratio() > 0.0);

        db.compact();
        assert_eq!(db.tombstones.len(), 0);
        assert_eq!(db.vectors.len(), 1);
        assert!(db.metadata.contains_key(&(id + 1))); // "new.php" still there
    }

    #[test]
    fn test_v2_save_load_roundtrip() {
        let dir = std::env::temp_dir().join("magector_test_v2");
        let _ = fs::create_dir_all(&dir);
        let db_path = dir.join("test_v2.db");

        {
            let mut db = VectorDB::new();
            let v = vec![0.1f32; EMBEDDING_DIM];
            let id = db.insert(&v, make_test_meta("a.php"));
            db.insert(&v, make_test_meta("b.php"));
            db.tombstone(id);
            db.save(&db_path).unwrap();
        }

        // Reload and verify tombstone persisted
        let db = VectorDB::open(&db_path).unwrap();
        assert!(db.tombstones.contains(&0));
        assert_eq!(db.len(), 1); // b.php live

        let _ = fs::remove_dir_all(&dir);
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
