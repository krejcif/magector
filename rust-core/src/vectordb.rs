//! HNSW-based vector database with persistence
//!
//! Provides efficient similarity search for code embeddings

use anyhow::{Context, Result};
use hnsw_rs::prelude::*;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::embedder::EMBEDDING_DIM;

/// Default HNSW parameters
const HNSW_M: usize = 32;             // max connections per node
const HNSW_MAX_LAYER: usize = 16;
const HNSW_EF_CONSTRUCTION: usize = 200;
const HNSW_MIN_CAPACITY: usize = 1_000;

/// Up to this many vectors a search compares the query with every live one instead of walking
/// the HNSW graph: exact, a few ms for 50k × 384 dims, and nothing to build. Building the graph
/// of a 42k-vector index costs ~1 min on 2 vCPUs, which `serve` paid before it reported ready.
const FLAT_SEARCH_MAX: usize = 300_000;

/// Move a database that can't be decoded aside, keeping it for recovery.
/// An index costs hours of CPU to build, so a decode failure — which can also
/// come from a truncated write, not just a schema change — must never delete it.
pub(crate) fn keep_incompatible_aside(path: &Path) -> Option<PathBuf> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut name = path.file_name()?.to_os_string();
    name.push(format!(".incompatible-{stamp}"));
    let dest = path.with_file_name(name);
    fs::rename(path, &dest).ok().map(|_| dest)
}

/// Check whether a vector is safe for cosine distance computation.
/// Rejects NaN, Inf, and zero vectors — these produce NaN distances
/// that corrupt the HNSW graph structure.
fn norm(v: &[f32]) -> f32 {
    v.iter().map(|x| x * x).sum::<f32>().sqrt()
}

/// 1 − cosine similarity, clamped at 0 as hnsw_rs's DistCosine does (`query_norm` = |query|).
fn cosine_distance(query: &[f32], query_norm: f32, v: &[f32]) -> f32 {
    let denom = query_norm * norm(v);
    if denom <= 0.0 {
        return 0.0;
    }
    let dot: f32 = query.iter().zip(v).map(|(a, b)| a * b).sum();
    (1.0 - dot / denom).max(0.0)
}

fn is_valid_vector(v: &[f32]) -> bool {
    let mut norm_sq = 0.0f32;
    for &x in v {
        if x.is_nan() || x.is_infinite() {
            return false;
        }
        norm_sq += x * x;
    }
    norm_sq > 1e-12
}

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
const PERSIST_VERSION_V2: u8 = 3;

/// Persisted state V2 — includes tombstone set
#[derive(Serialize, Deserialize)]
struct PersistedStateV2 {
    metadata: HashMap<usize, IndexMetadata>,
    vectors: HashMap<usize, Vec<f32>>,
    next_id: usize,
    tombstones: HashSet<usize>,
}

/// A database file decoded, before any HNSW graph is built from it.
enum Persisted {
    Empty,
    V1(PersistedState),
    V2(PersistedStateV2),
}

/// Read and decode a database file (V2 with tombstones, V1 fallback).
/// Returns `Err` with `FormatChanged` context if the schema is incompatible.
fn read_persisted(path: &Path) -> Result<Persisted> {
    let bytes = fs::read(path).context("Failed to read database")?;
    if bytes.is_empty() {
        return Ok(Persisted::Empty);
    }

    // Try V2 first: first byte == PERSIST_VERSION_V2
    if bytes[0] == PERSIST_VERSION_V2 {
        return match bincode::serde::decode_from_slice::<PersistedStateV2, _>(&bytes[1..], bincode::config::standard()) {
            Ok((state, _)) => Ok(Persisted::V2(state)),
            Err(e) => {
                tracing::warn!("V2 database format incompatible: {e}");
                Err(anyhow::anyhow!("Database format changed (schema mismatch). Re-index required."))
                    .context("FormatChanged")
            }
        };
    }

    // Fallback: V1 (no version byte)
    match bincode::serde::decode_from_slice::<PersistedState, _>(&bytes, bincode::config::standard()) {
        Ok((state, _)) => Ok(Persisted::V1(state)),
        Err(e) => {
            tracing::warn!("V1 database format incompatible: {e}");
            Err(anyhow::anyhow!("Database format changed (schema mismatch). Re-index required."))
                .context("FormatChanged")
        }
    }
}

/// Ids among `vectors` that loading tombstones on top of `tombstones`: the vectors that
/// are not valid for cosine distance (NaN, Inf, zero). Shared by `open` and
/// `persisted_len`, so the count they report cannot drift apart.
fn invalid_vector_ids(vectors: &HashMap<usize, Vec<f32>>, tombstones: &HashSet<usize>) -> Vec<usize> {
    vectors
        .iter()
        .filter(|(id, vec)| !tombstones.contains(id) && !is_valid_vector(vec))
        .map(|(&id, _)| id)
        .collect()
}

/// Vector database for semantic code search
pub struct VectorDB {
    /// Search graph, used only above FLAT_SEARCH_MAX vectors and built on the first search there
    /// (or `warm`) rather than on open: `index`, `stats` and the incremental refresh never search,
    /// and building the graph of a 42k-vector index costs ~1 min on 2 vCPUs.
    hnsw: OnceLock<Hnsw<'static, f32, DistCosine>>,
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
            hnsw: OnceLock::new(),
            metadata: HashMap::new(),
            vectors: HashMap::new(),
            next_id: 0,
            tombstones: HashSet::new(),
        }
    }

    /// Create with a capacity hint (avoids HNSW resizing)
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            hnsw: OnceLock::new(),
            metadata: HashMap::with_capacity(capacity),
            vectors: HashMap::with_capacity(capacity),
            next_id: 0,
            tombstones: HashSet::new(),
        }
    }

    /// The search graph over the live vectors, built on first use.
    fn search_graph(&self) -> &Hnsw<'static, f32, DistCosine> {
        self.hnsw.get_or_init(|| {
            let data: Vec<(&Vec<f32>, usize)> = self.vectors.iter()
                .filter(|(id, _)| !self.tombstones.contains(id))
                .map(|(&id, vec)| (vec, id))
                .collect();
            let hnsw = make_hnsw(data.len());
            if !data.is_empty() {
                hnsw.parallel_insert(&data);
            }
            hnsw
        })
    }

    /// Build the search graph now instead of on the first search (`serve`, before it reports
    /// ready). Up to FLAT_SEARCH_MAX vectors there is none to build.
    pub fn warm(&self) {
        if self.vectors.len() > FLAT_SEARCH_MAX {
            self.search_graph();
        }
    }

    /// The `n` live vectors nearest to `query`, as (id, cosine distance), nearest first.
    fn nearest(&self, query: &[f32], n: usize, ef_search: usize) -> Vec<(usize, f32)> {
        self.nearest_with(query, n, ef_search, FLAT_SEARCH_MAX)
    }

    /// `nearest`, comparing every live vector up to `flat_max` vectors (exact) and asking the
    /// HNSW graph above (approximate).
    fn nearest_with(&self, query: &[f32], n: usize, ef_search: usize, flat_max: usize) -> Vec<(usize, f32)> {
        if self.vectors.len() > flat_max {
            return self.search_graph().search(query, n, ef_search)
                .into_iter()
                .map(|nb| (nb.d_id, nb.distance))
                .collect();
        }
        if n == 0 {
            return Vec::new();
        }
        let query_norm = norm(query);
        let mut scored: Vec<(usize, f32)> = self.vectors.par_iter()
            .filter(|(id, _)| !self.tombstones.contains(id))
            .map(|(&id, v)| (id, cosine_distance(query, query_norm, v)))
            .collect();
        let by_distance = |a: &(usize, f32), b: &(usize, f32)| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0));
        if scored.len() > n {
            scored.select_nth_unstable_by(n - 1, by_distance);
            scored.truncate(n);
        }
        scored.sort_unstable_by(by_distance);
        scored
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
                        match keep_incompatible_aside(path) {
                            Some(dest) => tracing::warn!(
                                "Database at {:?} could not be read. Kept as {:?} — re-index required.",
                                path, dest
                            ),
                            None => tracing::warn!(
                                "Database at {:?} could not be read and could not be moved aside — re-index required.",
                                path
                            ),
                        }
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
                    match keep_incompatible_aside(path) {
                        Some(dest) => tracing::warn!(
                            "Legacy database format incompatible. Kept as {:?} — re-index required.",
                            dest
                        ),
                        None => tracing::warn!(
                            "Legacy database format incompatible and could not be moved aside — re-index required."
                        ),
                    }
                    return Ok(Self::new());
                }
            }
        }

        Ok(Self::new())
    }

    /// Load database from a bincode file (V2 with tombstones, V1 fallback).
    /// Returns `Err` with `FormatChanged` context if the schema is incompatible.
    pub(crate) fn load(path: &Path) -> Result<Self> {
        match read_persisted(path)? {
            Persisted::Empty => Ok(Self::new()),
            Persisted::V2(state) => Self::from_state_v2(state),
            Persisted::V1(state) => Self::from_state(state),
        }
    }

    /// Number of live vectors in the database file at `path`, as `VectorDB::open(path)?.len()`
    /// reports it, but without building the HNSW graph, which is most of the cost of opening
    /// a large index. A missing file counts as empty, like `open`; unlike `open`, this never
    /// migrates or moves a file, and a file that cannot be read or decoded is an `Err`.
    pub(crate) fn persisted_len(path: &Path) -> Result<usize> {
        if !path.exists() {
            return Ok(0);
        }
        Ok(match read_persisted(path)? {
            Persisted::Empty => 0,
            Persisted::V1(state) => {
                let invalid = invalid_vector_ids(&state.vectors, &HashSet::new()).len();
                state.metadata.len().saturating_sub(invalid)
            }
            Persisted::V2(mut state) => {
                let invalid = invalid_vector_ids(&state.vectors, &state.tombstones);
                state.tombstones.extend(invalid);
                state.metadata.len().saturating_sub(state.tombstones.len())
            }
        })
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
            bincode::serde::decode_from_slice::<PersistedStateV2, _>(&bytes[1..], bincode::config::standard()).is_ok()
        } else {
            bincode::serde::decode_from_slice::<PersistedState, _>(&bytes, bincode::config::standard()).is_ok()
        }
    }

    /// Load persisted V1 state (the search graph is built on first use)
    fn from_state(state: PersistedState) -> Result<Self> {
        // Tombstone any invalid vectors, and keep them out of the HNSW graph they would corrupt
        let tombstones: HashSet<usize> =
            invalid_vector_ids(&state.vectors, &HashSet::new()).into_iter().collect();
        if !tombstones.is_empty() {
            tracing::warn!("V1 load: skipped {} invalid vectors (NaN/Inf/zero)", tombstones.len());
        }

        Ok(Self {
            hnsw: OnceLock::new(),
            metadata: state.metadata,
            vectors: state.vectors,
            next_id: state.next_id,
            tombstones,
        })
    }

    /// Load persisted V2 state (the search graph is built on first use, without tombstones)
    fn from_state_v2(state: PersistedStateV2) -> Result<Self> {
        // Only insert non-tombstoned AND valid vectors
        let mut tombstones = state.tombstones;
        for id in invalid_vector_ids(&state.vectors, &tombstones) {
            tracing::warn!("V2 load: tombstoning invalid vector id={}", id);
            tombstones.insert(id);
        }

        Ok(Self {
            hnsw: OnceLock::new(),
            metadata: state.metadata,
            vectors: state.vectors,
            next_id: state.next_id,
            tombstones,
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
        bincode::serde::encode_into_std_write(&state, &mut writer, bincode::config::standard())
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

    /// Crash-safe save: write to a temp file, then atomic rename.
    /// If the process dies mid-write, the original DB file remains intact.
    pub fn save_atomic(&self, path: &Path) -> Result<()> {
        fs::create_dir_all(path.parent().unwrap_or(Path::new(".")))?;

        let tmp_path = path.with_extension("db.tmp");

        let state = PersistedStateV2 {
            metadata: self.metadata.clone(),
            vectors: self.vectors.clone(),
            next_id: self.next_id,
            tombstones: self.tombstones.clone(),
        };

        {
            let file = File::create(&tmp_path)?;
            let mut writer = BufWriter::with_capacity(1 << 20, file);
            use std::io::Write;
            writer.write_all(&[PERSIST_VERSION_V2])?;
            bincode::serde::encode_into_std_write(&state, &mut writer, bincode::config::standard())
                .context("Failed to serialize database")?;
            writer.flush()?;
        }

        // Atomic rename — either fully replaces or doesn't change the file
        fs::rename(&tmp_path, path)
            .context("Failed to atomically rename temp DB")?;

        Ok(())
    }

    /// Insert a vector with metadata.
    /// Returns None if the vector is invalid (NaN/Inf/zero).
    pub fn insert(&mut self, vector: &[f32], metadata: IndexMetadata) -> usize {
        assert_eq!(vector.len(), EMBEDDING_DIM);

        if !is_valid_vector(vector) {
            tracing::warn!("Skipping invalid vector for {}: NaN/Inf/zero", metadata.path);
            // Still assign an ID and store metadata (for stats accuracy),
            // but tombstone it immediately so it's excluded from search.
            let id = self.next_id;
            self.next_id += 1;
            self.metadata.insert(id, metadata);
            self.tombstones.insert(id);
            return id;
        }

        let id = self.next_id;
        self.next_id += 1;

        let vec = vector.to_vec();
        // Not built yet: the first search builds it from `vectors`, this one included.
        if let Some(hnsw) = self.hnsw.get() {
            hnsw.insert((&vec, id));
        }
        self.vectors.insert(id, vec);
        self.metadata.insert(id, metadata);

        id
    }

    /// Batch insert vectors with metadata (uses parallel HNSW insert).
    /// Invalid vectors (NaN/Inf/zero) are silently skipped from HNSW insertion.
    pub fn insert_batch(&mut self, items: Vec<(Vec<f32>, IndexMetadata)>) {
        if items.is_empty() {
            return;
        }

        let start_id = self.next_id;
        let mut skipped = 0usize;

        // Assign IDs and store metadata + vectors, filtering invalid ones
        for (i, (vec, meta)) in items.iter().enumerate() {
            let id = start_id + i;
            if !is_valid_vector(vec) {
                tracing::warn!("Skipping invalid vector for {}: NaN/Inf/zero", meta.path);
                self.metadata.insert(id, meta.clone());
                self.tombstones.insert(id);
                skipped += 1;
            } else {
                self.vectors.insert(id, vec.clone());
                self.metadata.insert(id, meta.clone());
            }
        }

        if skipped > 0 {
            tracing::warn!("Batch insert: skipped {} invalid vectors", skipped);
        }

        // Build references for parallel HNSW insert (only valid vectors)
        let data: Vec<(&Vec<f32>, usize)> = (0..items.len())
            .filter_map(|i| {
                let id = start_id + i;
                self.vectors.get(&id).map(|vec| (vec, id))
            })
            .collect();

        if let (false, Some(hnsw)) = (data.is_empty(), self.hnsw.get()) {
            hnsw.parallel_insert(&data);
        }
        self.next_id = start_id + items.len();
    }

    /// Search for similar vectors (pure semantic), filtering tombstoned IDs
    pub fn search(&self, query: &[f32], k: usize) -> Vec<SearchResult> {
        assert_eq!(query.len(), EMBEDDING_DIM);

        // Fetch extra candidates to compensate for tombstoned entries
        let extra = if self.tombstones.is_empty() { 0 } else { self.tombstones.len().min(k) };
        let fetch = k + extra;
        let ef_search = (fetch * 2).max(50);
        let results = self.nearest(query, fetch, ef_search);

        results
            .into_iter()
            .filter(|(id, _)| !self.tombstones.contains(id))
            .filter_map(|(id, distance)| {
                self.metadata.get(&id).map(|meta| SearchResult {
                    id,
                    score: 1.0 - distance,
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
        let results = self.nearest(query, candidates, ef_search);

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
        let wants_resolver = query_terms.contains(&"resolver");
        let wants_graphql = query_terms.contains(&"graphql");

        let mut scored: Vec<SearchResult> = results
            .into_iter()
            .filter(|(id, _)| !self.tombstones.contains(id))
            .filter_map(|(id, distance)| {
                self.metadata.get(&id).map(|meta| {
                    let semantic_score = 1.0 - distance;

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
                    if wants_resolver && (mtype == "graphql_resolver" || meta.is_resolver) {
                        keyword_bonus += 0.15;
                    }
                    if wants_graphql && (mtype == "graphql_resolver" || mtype == "graphql_schema" || path_lower.contains("graph-ql") || path_lower.contains("graphql")) {
                        keyword_bonus += 0.10;
                    }

                    // Multi-term bonus: reward results matching many query terms
                    if matched_terms >= 3 {
                        keyword_bonus += 0.05;
                    }

                    // Deprioritize framework abstractions (interfaces, abstract
                    // base classes) when the query asks for concrete features.
                    // Users searching for "cart resolver" want Cart.php, not
                    // ResolverInterface.php.
                    if path_lower.contains("/framework/") {
                        let class_lower = meta.class_name.as_deref().unwrap_or("").to_lowercase();
                        if class_lower.ends_with("interface") || class_lower.starts_with("abstract") {
                            keyword_bonus -= 0.12;
                        }
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

        self.tombstones.clear();

        // Drop the graph; rebuild it now only if it was in use (`serve`), so a search there
        // does not pay for the rebuild — `index` never needs it.
        let was_built = self.hnsw.take().is_some();
        if was_built {
            self.warm();
        }
    }

    /// Iterate over `(id, metadata)` pairs for all non-tombstoned vectors.
    /// Used by resume mode to collect already-indexed file paths.
    pub fn metadata_iter(&self) -> impl Iterator<Item = (usize, &IndexMetadata)> {
        self.metadata
            .iter()
            .filter(|(id, _)| !self.tombstones.contains(id))
            .map(|(&id, meta)| (id, meta))
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
        self.hnsw = OnceLock::new();
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

/// Re-read a just-saved index and confirm its live vector count matches what
/// was in memory before the save. A decode can succeed (no `FormatChanged`
/// error) while still yielding an empty or partial DB — e.g. if the file was
/// overwritten by a concurrent writer between the atomic rename and this
/// check. An index costs hours of CPU to build, so that must surface as a
/// loud error, not a silent "Indexing complete". The vectors are counted from
/// the decoded file (`persisted_len`), not by opening it: opening rebuilds the
/// whole HNSW graph, which took about a minute on a 42k-vector index.
pub fn verify_vector_count(path: &Path, expected: usize) -> Result<()> {
    let found = VectorDB::persisted_len(path).context("Failed to read the saved index for verification")?;
    if found != expected {
        anyhow::bail!(
            "Index verification failed after save: expected {} vectors, found {} in {:?}. \
             The saved index is corrupt (likely clobbered by a concurrent process writing \
             the same path) — do not trust it; re-run indexing.",
            expected,
            found,
            path
        );
    }
    Ok(())
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
    fn test_load_leaves_unreadable_db_in_place() {
        // `serve` reloads an index.db another process replaced with `load`: a file it cannot
        // read may be a newer magector's index, so unlike `open` it must not move it aside.
        let dir = std::env::temp_dir().join(format!("magector_test_load_unreadable_{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let db_path = dir.join("index.db");
        let bytes = [2u8, 0xff, 0xff, 0xff, 0xff];
        fs::write(&db_path, bytes).unwrap();

        assert!(VectorDB::load(&db_path).is_err());
        assert_eq!(fs::read(&db_path).unwrap(), bytes, "the file stays as it was");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_open_preserves_incompatible_db() {
        let dir = std::env::temp_dir().join("magector_test_incompatible");
        let _ = fs::create_dir_all(&dir);
        let db_path = dir.join("index.db");

        // Pre-bincode-2.0 layout: a version byte the current decoder rejects,
        // followed by a payload it cannot parse.
        let bytes = [2u8, 0xff, 0xff, 0xff, 0xff];
        fs::write(&db_path, bytes).unwrap();

        let db = VectorDB::open(&db_path).unwrap();
        assert_eq!(db.len(), 0);

        let kept: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with("index.db.incompatible-"))
            .collect();
        assert_eq!(kept.len(), 1, "incompatible index must be kept, not deleted");
        assert_eq!(fs::read(dir.join(&kept[0])).unwrap(), bytes);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_flat_search_is_exact_and_builds_no_graph() {
        let mut db = VectorDB::new();
        let mut seed = 7u64;
        let mut next = || { seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); ((seed >> 33) as f32 / u32::MAX as f32) - 0.25 };
        let vectors: Vec<Vec<f32>> = (0..300).map(|_| (0..EMBEDDING_DIM).map(|_| next()).collect()).collect();
        for (i, v) in vectors.iter().enumerate() {
            db.insert(v, make_test_meta(&format!("f{i}.php")));
        }
        let query: Vec<f32> = vectors[37].iter().enumerate().map(|(i, x)| if i % 50 == 0 { x + 0.05 } else { *x }).collect();

        // every vector compared: the ten nearest by brute force, in order
        let mut expected: Vec<(usize, f32)> = vectors.iter().enumerate()
            .map(|(i, v)| (i, cosine_distance(&query, norm(&query), v))).collect();
        expected.sort_by(|a, b| a.1.total_cmp(&b.1));
        let got: Vec<usize> = db.nearest(&query, 10, 50).into_iter().map(|(id, _)| id).collect();
        assert_eq!(got, expected.iter().take(10).map(|(i, _)| *i).collect::<Vec<_>>());
        assert_eq!(db.search(&query, 1)[0].id, 37);

        db.warm();
        assert!(db.hnsw.get().is_none(), "no graph is built up to FLAT_SEARCH_MAX vectors");

        // the graph agrees on the nearest one
        assert_eq!(db.nearest_with(&query, 1, 50, 0)[0].0, 37);

        db.tombstone(37);
        let got = db.nearest(&query, 10, 50);
        assert!(got.iter().all(|(id, _)| *id != 37), "a tombstoned vector is not compared");
        assert_eq!(got.len(), 10);
        assert!(db.nearest(&query, 0, 50).is_empty());
    }

    #[test]
    fn test_batch_insert() {
        let mut db = VectorDB::with_capacity(10);

        // Start from 1 to avoid zero vectors (which are now tombstoned as invalid)
        let items: Vec<(Vec<f32>, IndexMetadata)> = (1..6)
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

        let mut query = vec![0.0f32; EMBEDDING_DIM];
        query[0] = 0.1; // non-zero query vector
        let results = db.search(&query, 3);
        assert!(results.len() <= 3);
    }

    #[test]
    fn test_save_atomic_roundtrip() {
        let dir = std::env::temp_dir().join("magector_test_atomic");
        let _ = fs::create_dir_all(&dir);
        let db_path = dir.join("atomic_test.db");

        // Create DB with some vectors and save atomically
        {
            let mut db = VectorDB::new();
            let v1 = vec![0.1f32; EMBEDDING_DIM];
            let v2 = vec![0.2f32; EMBEDDING_DIM];
            db.insert(&v1, make_test_meta("a.php"));
            db.insert(&v2, make_test_meta("b.php"));
            db.save_atomic(&db_path).unwrap();
        }

        // Verify file exists and has data
        assert!(db_path.exists());
        let file_size = fs::metadata(&db_path).unwrap().len();
        assert!(file_size > 100, "DB file should have substantial data, got {} bytes", file_size);

        // Reload and verify
        let db = VectorDB::open(&db_path).unwrap();
        assert_eq!(db.len(), 2, "Expected 2 vectors after save_atomic roundtrip");

        // Verify no temp file left
        assert!(!db_path.with_extension("db.tmp").exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_verify_vector_count_passes_on_match() {
        let dir = std::env::temp_dir().join("magector_test_verify_match");
        let _ = fs::create_dir_all(&dir);
        let db_path = dir.join("verify_match.db");

        let mut db = VectorDB::new();
        db.insert(&vec![0.1f32; EMBEDDING_DIM], make_test_meta("a.php"));
        db.insert(&vec![0.2f32; EMBEDDING_DIM], make_test_meta("b.php"));
        db.save_atomic(&db_path).unwrap();

        assert!(verify_vector_count(&db_path, 2).is_ok());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_verify_vector_count_fails_on_mismatch() {
        // Simulates the exact failure mode this guards against: a save that
        // reported N vectors created, but the file on disk (e.g. clobbered by
        // a concurrent writer after the atomic rename) decodes to fewer.
        let dir = std::env::temp_dir().join("magector_test_verify_mismatch");
        let _ = fs::create_dir_all(&dir);
        let db_path = dir.join("verify_mismatch.db");

        let mut db = VectorDB::new();
        db.insert(&vec![0.1f32; EMBEDDING_DIM], make_test_meta("a.php"));
        db.save_atomic(&db_path).unwrap();

        let err = verify_vector_count(&db_path, 110_314).unwrap_err();
        assert!(err.to_string().contains("Index verification failed"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_persisted_len_matches_open_with_tombstones() {
        // `verify_vector_count` counts the decoded file instead of opening it (which
        // rebuilds the HNSW graph); the count must be the one `open` reports.
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("count.db");

        let mut db = VectorDB::new();
        for i in 0..6 {
            let mut v = vec![0.1f32; EMBEDDING_DIM];
            v[i] = 1.0;
            db.insert(&v, make_test_meta(&format!("f{i}.php")));
        }
        db.remove_by_path("f1.php");
        db.remove_by_path("f4.php");
        db.insert(&vec![0.0f32; EMBEDDING_DIM], make_test_meta("zero.php")); // invalid: stored tombstoned
        db.save_atomic(&db_path).unwrap();

        let opened = VectorDB::open(&db_path).unwrap().len();
        assert_eq!(opened, 4, "6 inserted - 2 removed; the zero vector is tombstoned");
        assert_eq!(VectorDB::persisted_len(&db_path).unwrap(), opened);
        assert!(verify_vector_count(&db_path, opened).is_ok());
        assert!(verify_vector_count(&db_path, opened + 1).is_err());
    }

    #[test]
    fn test_persisted_len_applies_the_load_time_rules() {
        // `open` also tombstones vectors that are invalid for cosine distance, whether or
        // not the file says so; the count must do the same, for the V2 and the V1 format.
        let dir = tempfile::tempdir().unwrap();
        let cfg = bincode::config::standard();
        let metadata: HashMap<usize, IndexMetadata> =
            (0..4).map(|i| (i, make_test_meta(&format!("f{i}.php")))).collect();
        let vectors: HashMap<usize, Vec<f32>> = [0.1f32, 0.2, 0.0, 0.3]
            .into_iter()
            .enumerate()
            .map(|(i, x)| (i, vec![x; EMBEDDING_DIM]))
            .collect(); // id 2 is a zero vector

        // V2: id 3 tombstoned in the file, id 2 invalid but not tombstoned
        let v2 = PersistedStateV2 {
            metadata: metadata.clone(),
            vectors: vectors.clone(),
            next_id: 4,
            tombstones: HashSet::from([3]),
        };
        let mut bytes = vec![PERSIST_VERSION_V2];
        bytes.extend(bincode::serde::encode_to_vec(&v2, cfg).unwrap());
        let v2_path = dir.path().join("v2.db");
        fs::write(&v2_path, bytes).unwrap();
        assert_eq!(VectorDB::open(&v2_path).unwrap().len(), 2);
        assert_eq!(VectorDB::persisted_len(&v2_path).unwrap(), 2);

        // V1: no tombstones and no version byte; only the zero vector is dropped
        let v1 = PersistedState { metadata, vectors, next_id: 4 };
        let v1_path = dir.path().join("v1.db");
        fs::write(&v1_path, bincode::serde::encode_to_vec(&v1, cfg).unwrap()).unwrap();
        assert_eq!(VectorDB::open(&v1_path).unwrap().len(), 3);
        assert_eq!(VectorDB::persisted_len(&v1_path).unwrap(), 3);
    }

    #[test]
    fn test_persisted_len_of_missing_empty_and_undecodable_files() {
        let dir = tempfile::tempdir().unwrap();

        let missing = dir.path().join("missing.db");
        assert_eq!(VectorDB::persisted_len(&missing).unwrap(), 0);

        let empty = dir.path().join("empty.db");
        fs::write(&empty, b"").unwrap();
        assert_eq!(VectorDB::persisted_len(&empty).unwrap(), 0);

        // Undecodable: an error (`open` would move the file aside and start empty); the
        // file stays where it is, and verification fails rather than passing on 0.
        let junk = dir.path().join("junk.db");
        fs::write(&junk, [PERSIST_VERSION_V2, 0xff, 0xff]).unwrap();
        assert!(VectorDB::persisted_len(&junk).is_err());
        assert!(junk.exists());
        assert!(verify_vector_count(&junk, 1).is_err());
    }
}
