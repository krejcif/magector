//! Magento code indexer - orchestrates file discovery, parsing, and embedding

use anyhow::{Context, Result};
use indicatif::{ProgressBar, ProgressStyle};
use rayon::prelude::*;
use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use walkdir::WalkDir;

use crate::ast::{PhpAstAnalyzer, JsAstAnalyzer, PhpAstMetadata, JsAstMetadata};
use crate::embedder::Embedder;
use crate::magento::{
    detect_area, detect_file_type, extract_module_info, split_camel_case,
    XmlAnalyzer, SetupAnalyzer, SqlReferenceAnalyzer,
};
use crate::vectordb::{IndexMetadata, VectorDB};

use std::collections::HashSet;

/// File patterns to index
pub(crate) const INCLUDE_EXTENSIONS: &[&str] = &["php", "xml", "phtml", "js", "graphqls"];

/// Directories to always skip (matched against directory name, not path)
pub(crate) const EXCLUDE_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "var",
    "generated",
    "Test",
    "Tests",
    "test",
    "tests",
    "_files",
    "fixtures",
    "performance-toolkit",
];

/// Additional directories to skip by relative path prefix.
/// These handle cases where the directory name alone is too generic (e.g., "static").
pub(crate) const EXCLUDE_PATHS: &[&str] = &[
    "vendor/bin",
    "pub/static",
    "dev/tests",
    "dev/tools",
];

/// Maximum file size to index (100KB)
pub(crate) const MAX_FILE_SIZE: u64 = 100_000;

/// Longest text of one README vector. The embedder reads only the first 256 tokens of a
/// text, so a longer section is split at line boundaries to keep all of it searchable.
const README_CHUNK_CHARS: usize = 800;

/// Markdown is indexed only as a module README: `app/code/<Vendor>/<Module>/README.md`.
/// That is the project's own documentation, written next to its code and trusted like the
/// code's comments. Markdown anywhere else (`vendor/` packages, docs folders, nested
/// READMEs) stays out: it is third-party text an agent could take as instructions.
pub(crate) fn is_module_readme(relative: &Path) -> bool {
    let parts: Vec<_> = relative.components().map(|c| c.as_os_str().to_string_lossy()).collect();
    parts.len() == 5 && parts[0] == "app" && parts[1] == "code" && parts[4].eq_ignore_ascii_case("README.md")
}

/// Whether a file is indexed (size aside): a source file by extension, or a module README.
/// `discover_files` and the watcher's two scans must agree on this.
pub(crate) fn is_indexed_file(path: &Path, root: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) if INCLUDE_EXTENSIONS.contains(&ext) => true,
        Some(ext) if ext.eq_ignore_ascii_case("md") => {
            path.strip_prefix(root).is_ok_and(is_module_readme)
        }
        _ => false,
    }
}

/// Splits a module README into `(heading, text)` chunks of at most `README_CHUNK_CHARS`
/// (a single longer line stays whole). Text before the first `## ` is "Summary", a `### X`
/// under `## Y` is "Y > X", `# ` titles are dropped and headings inside code fences are text.
/// Sections that say nothing are dropped: empty, or the module README template's
/// placeholders `None.` and `Not documented yet.`.
pub(crate) fn readme_sections(content: &str) -> Vec<(String, String)> {
    fn push(chunks: &mut Vec<(String, String)>, heading: String, body: &str) {
        let text = body.trim();
        let said = text.trim_end_matches('.').to_ascii_lowercase();
        if text.is_empty() || said == "none" || said == "not documented yet" {
            return;
        }
        let mut piece = String::new();
        for line in text.lines() {
            if !piece.is_empty() && piece.len() + line.len() + 1 > README_CHUNK_CHARS {
                chunks.push((heading.clone(), piece.trim().to_string()));
                piece.clear();
            }
            piece.push_str(line);
            piece.push('\n');
        }
        if !piece.trim().is_empty() {
            chunks.push((heading, piece.trim().to_string()));
        }
    }

    let mut chunks = Vec::new();
    let mut section = "Summary".to_string();
    let mut sub: Option<String> = None;
    let mut body = String::new();
    let mut in_fence = false;
    let heading = |section: &str, sub: &Option<String>| match sub {
        Some(s) => format!("{} > {}", section, s),
        None => section.to_string(),
    };

    for line in content.lines() {
        let fence = line.trim_start();
        if fence.starts_with("```") || fence.starts_with("~~~") {
            in_fence = !in_fence;
        } else if !in_fence {
            if let Some(h) = line.strip_prefix("## ") {
                push(&mut chunks, heading(&section, &sub), &body);
                body.clear();
                section = h.trim().to_string();
                sub = None;
                continue;
            }
            if let Some(h) = line.strip_prefix("### ") {
                push(&mut chunks, heading(&section, &sub), &body);
                body.clear();
                sub = Some(h.trim().to_string());
                continue;
            }
            if line.starts_with("# ") {
                continue;
            }
        }
        body.push_str(line);
        body.push('\n');
    }
    push(&mut chunks, heading(&section, &sub), &body);
    chunks
}

/// Indexing statistics
#[derive(Debug, Default)]
pub struct IndexStats {
    pub files_found: usize,
    pub files_indexed: usize,
    pub files_skipped: usize,
    pub vectors_created: usize,
    pub errors: usize,
    pub php_files: usize,
    pub js_files: usize,
    pub xml_files: usize,
    pub other_files: usize,
    /// Whether the caller must write index.db: always after a full index, on resume only
    /// if a vector was tombstoned or embedded or the DB was compacted. Otherwise the file
    /// on disk is exactly the one this run loaded.
    pub db_changed: bool,
}

/// Intermediate result from parsing (before embedding)
pub(crate) struct ParsedFile {
    embed_text: String,
    metadata: IndexMetadata,
}

/// Default embedding batch size — larger batches amortize ONNX overhead.
/// Override via MAGECTOR_BATCH_SIZE env var or --batch-size CLI flag.
const DEFAULT_EMBED_BATCH_SIZE: usize = 256;

/// Save index to disk every N batches during PHASE 2 (crash recovery)
const SAVE_INTERVAL_BATCHES: usize = 50;

/// Log progress every N batches
const LOG_INTERVAL_BATCHES: usize = 10;

// Thread-local AST analyzers (avoids mutex contention in parallel parsing)
thread_local! {
    static TL_PHP_ANALYZER: RefCell<Option<PhpAstAnalyzer>> = RefCell::new(PhpAstAnalyzer::new().ok());
    static TL_JS_ANALYZER: RefCell<Option<JsAstAnalyzer>> = RefCell::new(JsAstAnalyzer::new().ok());
}

/// Whether AST analyzers are available (checked once at init)
struct AstAvailability {
    php: bool,
    js: bool,
}

/// Main indexer
pub struct Indexer {
    embedder: Embedder,
    vectordb: VectorDB,
    xml_analyzer: XmlAnalyzer,
    magento_root: PathBuf,
    ast_available: AstAvailability,
    pub sona: Option<crate::sona::SonaEngine>,
    pub db_path: Option<PathBuf>,
    descriptions_db: Option<PathBuf>,
    /// Custom ignore patterns loaded from .magectorignore
    ignore_patterns: Vec<String>,
    /// Embedding batch size (configurable)
    batch_size: usize,
    /// The manifest `index_with_options` prepared for the sidecar next to index.db. Held
    /// back so it is written only after index.db is: see `save_manifest`.
    pending_manifest: Option<crate::watcher::FileManifest>,
    /// Set by a full rebuild: the old sidecar is removed just before index.db is first
    /// written (`withdraw_old_sidecar`). Never set by the serve watcher.
    withdraw_sidecar: bool,
    /// Size and mtime of index.db when this indexer last loaded or wrote it (`None`: there
    /// was no file). Tells that another process replaced it since: see
    /// `save_atomic_unless_replaced`.
    db_stamp: Option<(u64, std::time::SystemTime)>,
}

/// Size and mtime of `path`, or `None` when there is no such file.
fn file_stamp(path: &Path) -> Option<(u64, std::time::SystemTime)> {
    let meta = fs::metadata(path).ok()?;
    Some((meta.len(), meta.modified().unwrap_or(std::time::UNIX_EPOCH)))
}

/// Whether `path` now holds a different file than the one `stamp` describes. A file that is
/// gone does not count: writing it again undoes nobody's work.
fn replaced_since(path: &Path, stamp: Option<(u64, std::time::SystemTime)>) -> bool {
    file_stamp(path).is_some_and(|now| Some(now) != stamp)
}

impl Indexer {
    /// Create new indexer with default settings
    pub fn new(magento_root: &Path, model_cache_dir: &Path, db_path: &Path) -> Result<Self> {
        Self::with_options(magento_root, model_cache_dir, db_path, None, None)
    }

    /// Create new indexer with configurable threads and batch size
    pub fn with_options(
        magento_root: &Path,
        model_cache_dir: &Path,
        db_path: &Path,
        max_threads: Option<usize>,
        batch_size: Option<usize>,
    ) -> Result<Self> {
        tracing::info!("Initializing embedder...");
        let embedder = Embedder::from_pretrained_with_threads(model_cache_dir, max_threads)?;

        let batch_size = batch_size
            .or_else(|| std::env::var("MAGECTOR_BATCH_SIZE").ok().and_then(|v| v.parse().ok()))
            .unwrap_or(DEFAULT_EMBED_BATCH_SIZE);

        tracing::info!("Opening vector database...");
        let vectordb = VectorDB::open(db_path)?;
        // After `open`: a file it moved aside is no longer this index.
        let db_stamp = file_stamp(db_path);

        // Check AST analyzer availability (thread-local instances created per-thread)
        let php_ok = PhpAstAnalyzer::new().is_ok();
        let js_ok = JsAstAnalyzer::new().is_ok();
        if php_ok && js_ok {
            tracing::info!("AST analyzers available (PHP + JavaScript, thread-local)");
        } else {
            if !php_ok { tracing::warn!("PHP AST analyzer not available"); }
            if !js_ok { tracing::warn!("JS AST analyzer not available"); }
        }

        let sona = {
            let sona_path = db_path.with_extension("sona");
            crate::sona::SonaEngine::open(&sona_path).ok()
        };

        // Load .magectorignore patterns
        let ignore_patterns = Self::load_ignore_file(magento_root);

        tracing::info!("Embedding batch size: {}", batch_size);

        Ok(Self {
            embedder,
            vectordb,
            xml_analyzer: XmlAnalyzer::new(),
            magento_root: magento_root.to_path_buf(),
            ast_available: AstAvailability { php: php_ok, js: js_ok },
            sona: sona.or_else(|| Some(crate::sona::SonaEngine::new())),
            db_path: Some(db_path.to_path_buf()),
            descriptions_db: None,
            ignore_patterns,
            batch_size,
            pending_manifest: None,
            withdraw_sidecar: false,
            db_stamp,
        })
    }

    /// Set the descriptions database path for embedding enrichment.
    pub fn set_descriptions_db(&mut self, path: PathBuf) {
        self.descriptions_db = Some(path);
    }

    /// Collect paths (relative to magento_root, as stored in IndexMetadata)
    /// of files that already have at least one vector in the current DB.
    /// Used by resume mode to avoid re-embedding work from a previous run.
    pub fn indexed_paths(&self) -> HashSet<String> {
        // IndexMetadata.path stores the path relative to magento_root, so it is
        // directly comparable with parse_file's output. Multiple vectors per
        // file all share the same path — HashSet naturally dedupes them.
        self.vectordb
            .metadata_iter()
            .map(|(_, meta)| meta.path.clone())
            .collect()
    }

    /// Index the Magento codebase.
    ///
    /// If a previous run left a partial index on disk, this auto-resumes:
    /// already-embedded files are skipped, the existing HNSW state is
    /// preserved, and only the remaining files are parsed and embedded.
    /// Pass `force=true` (or use the `--force` CLI flag) to clear the old
    /// index and rebuild from scratch.
    ///
    /// Like `index_with_options`, this does not save the finished index: see there.
    pub fn index(&mut self) -> Result<IndexStats> {
        self.index_with_options(false)
    }

    /// Index with explicit control over resume behavior.
    ///
    /// `force=true` clears the existing index and re-embeds everything.
    /// `force=false` (the default) auto-resumes from any partial index saved
    /// by a previous run — files already present in the DB are skipped during
    /// both PHASE 1 parsing and PHASE 2 embedding, and the existing HNSW is
    /// preserved rather than thrown away.
    ///
    /// Apart from the periodic crash-safety saves of PHASE 2, this writes neither
    /// index.db nor the manifest. The caller saves index.db (if `stats.db_changed`),
    /// verifies it, and only then calls `save_manifest`: the manifest must never claim
    /// content that index.db on disk does not hold. (For the same reason a resume first
    /// marks the paths it is about to change stale in the existing sidecar, and a full
    /// rebuild removes it when it first writes index.db, so a run that dies after a
    /// periodic save leaves no old hash claiming them.)
    pub fn index_with_options(&mut self, force: bool) -> Result<IndexStats> {
        let mut stats = IndexStats::default();
        self.pending_manifest = None;

        println!();
        println!("  __  __    _    ____ _____ ____ _____ ___  ____  ");
        println!(" |  \\/  |  / \\  / ___| ____/ ___|_   _/ _ \\|  _ \\ ");
        println!(" | |\\/| | / _ \\| |  _|  _|| |     | || | | | |_) |");
        println!(" | |  | |/ ___ \\ |_| | |__| |___  | || |_| |  _ < ");
        println!(" |_|  |_/_/   \\_\\____|_____\\____| |_| \\___/|_| \\_\\");
        println!();
        println!("  Semantic code search for Magento 2");
        println!();

        println!("📁 Source: {:?}", self.magento_root);
        if !self.ignore_patterns.is_empty() {
            println!("📋 .magectorignore: {} custom patterns loaded", self.ignore_patterns.len());
        }

        // Decide resume vs full rebuild. Build the already-indexed path set
        // *before* clearing anything, so we can filter file discovery below.
        let preexisting_vectors = self.vectordb.len();
        let resume = !force && preexisting_vectors > 0;
        // A full index always writes index.db; a resume only if it changes something below.
        stats.db_changed = !resume;
        // A full rebuild replaces index.db piece by piece, and the old sidecar would keep
        // claiming every file. It goes when index.db is first written, and not before: a run
        // that dies earlier leaves the old index and its sidecar as they were.
        self.withdraw_sidecar = !resume;
        let already_indexed: HashSet<String> = if resume {
            self.indexed_paths()
        } else {
            HashSet::new()
        };

        if force && preexisting_vectors > 0 {
            println!("🗑  --force specified — clearing existing index ({} vectors)", preexisting_vectors);
            tracing::info!("--force: clearing existing index ({} vectors)", preexisting_vectors);
            self.vectordb.clear();
        } else if resume {
            println!(
                "♻️  Resuming from previous run: {} vectors across {} files already indexed",
                preexisting_vectors,
                already_indexed.len()
            );
            println!("   (use --force to rebuild from scratch)");
            tracing::info!(
                "Resume mode: {} vectors / {} files already indexed",
                preexisting_vectors,
                already_indexed.len()
            );
        } else {
            // No existing index — nothing to clear, nothing to resume.
            self.vectordb.clear();
        }

        println!("🔍 Discovering files...");

        let all_files = self.discover_files()?;
        stats.files_found = all_files.len();

        // In resume mode, use FileManifest for true incremental indexing:
        // detect added/modified/deleted files via mtime+size comparison,
        // not just "is path in DB".
        let manifest_path = self.db_path.as_ref()
            .map(|p| crate::watcher::FileManifest::sidecar_path(p));
        if resume {
            if let Some(orphan) = self.db_path.as_deref().and_then(crate::watcher::FileManifest::adopt_orphan) {
                println!("♻️  Adopted {:?}, the manifest a pre-2.17 background re-index left behind", orphan);
            }
        }
        // Whether the sidecar needs writing: always after a full run or a rebuilt manifest,
        // after a resume only when a record changed (set below).
        let mut manifest_changed = true;
        let mut manifest = if resume {
            match manifest_path.as_ref().and_then(|p| crate::watcher::FileManifest::load(p)) {
                Some(loaded) => {
                    manifest_changed = false;
                    loaded
                }
                None => {
                    // No usable manifest: missing (first run after upgrade), or present but
                    // unreadable. Build from filesystem (treats all indexed files as current).
                    let present = manifest_path.as_ref().is_some_and(|p| !matches!(p.try_exists(), Ok(false)));
                    println!(
                        "⚠️  {} — treating the {} indexed files as current (run with --force to rebuild from scratch)",
                        if present { "No usable manifest (unreadable, or written by a newer magector)" } else { "No manifest found" },
                        already_indexed.len()
                    );
                    crate::watcher::FileManifest::from_existing_index(&self.magento_root, &already_indexed)
                }
            }
        } else {
            crate::watcher::FileManifest::new()
        };

        let (files, skipped_resume): (Vec<PathBuf>, usize) = if resume {
            // An indexed file the manifest has no record of — a manifest rebuilt from the
            // index, a lost record, a crash after an incremental save — is re-embedded if it
            // is still there, and dropped if it is gone or now excluded. Untracked, it would
            // never be reported deleted, and embedding it as new would list it twice.
            let untracked = manifest.track_indexed(&already_indexed);
            if untracked > 0 {
                println!("🔎 {} indexed files have no manifest record — re-embedding the ones still there, dropping the rest", untracked);
            }

            // Detect changes against manifest
            let changes = manifest.detect_changes(&self.magento_root)?;
            manifest.apply_touched(&changes.touched);
            let touched_count = changes.touched.len();
            let modified_count = changes.modified.len();
            let deleted_count = changes.deleted.len();
            let added_count = changes.added.len();

            // The periodic saves of PHASE 2 write index.db, tombstones included, long before
            // the manifest reaches disk, and `index` trusts a matching hash in the on-disk
            // sidecar. So before anything is tombstoned, withdraw the sidecar's claims on
            // every path this run is about to change — as the serve watcher does: if the run
            // dies mid-way, the next one re-embeds those files instead of taking a file
            // restored to its old content for "touched". `save_manifest` replaces the
            // sentinels with real records. Touched files change nothing in index.db.
            if let Some(ref mp) = manifest_path {
                let root = &self.magento_root;
                let changing: Vec<String> = changes
                    .modified
                    .iter()
                    .chain(changes.added.iter())
                    .map(|p| p.strip_prefix(root).unwrap_or(p).to_string_lossy().to_string())
                    .chain(changes.deleted.iter().cloned())
                    .collect();
                match crate::watcher::FileManifest::mark_stale_in_sidecar(mp, &changing) {
                    Ok(true) => tracing::info!("Marked {} changing files stale in {:?} until index.db is saved", changing.len(), mp),
                    Ok(false) => {}
                    Err(e) => {
                        println!("⚠️  Could not mark the changing files stale in {:?} ({}) — removing it", mp, e);
                        if let Err(e) = fs::remove_file(mp) {
                            if mp.exists() {
                                anyhow::bail!(
                                    "Could not remove {:?} ({}); not changing index.db while that file may claim content this run drops",
                                    mp, e
                                );
                            }
                        }
                    }
                }
            }

            // Tombstone vectors for modified files (will be re-indexed)
            for path in &changes.modified {
                let relative = path
                    .strip_prefix(&self.magento_root)
                    .unwrap_or(path)
                    .to_string_lossy()
                    .to_string();
                if !self.remove_vectors_for_path(&relative).is_empty() {
                    stats.db_changed = true;
                }
            }

            // Tombstone vectors for deleted files
            for path in &changes.deleted {
                if !self.remove_vectors_for_path(path).is_empty() {
                    stats.db_changed = true;
                }
            }
            manifest.apply_deleted(&changes.deleted);

            // Record content hashes for unchanged files that have none yet (v1 manifest,
            // or a manifest built from an existing index), so the next environment — a
            // checkout, `docker cp` — can tell a touched file from a modified one.
            let backfilled = manifest.backfill_hashes(&self.magento_root);
            manifest_changed |= untracked > 0 || !changes.is_empty() || touched_count > 0 || backfilled > 0;

            // Compact if many tombstones
            if self.vectordb_tombstone_ratio() > 0.20 {
                tracing::info!("Compacting vector DB after removing modified/deleted file vectors");
                self.compact_vectordb();
                stats.db_changed = true;
            }

            // Files to process = new + modified
            let to_process: Vec<PathBuf> = changes.added
                .into_iter()
                .chain(changes.modified.into_iter())
                .collect();

            // Deleted files were never discovered, so they are not part of files_found.
            // A file can appear between the two walks, hence the saturating subtraction.
            let skipped = stats.files_found.saturating_sub(to_process.len());

            if modified_count > 0 || deleted_count > 0 || added_count > 0 || touched_count > 0 {
                println!(
                    "📊 Incremental: {} new, {} modified, {} deleted, {} unchanged ({} touched: mtime changed, content identical)",
                    added_count, modified_count, deleted_count, skipped, touched_count
                );
            }
            if backfilled > 0 {
                println!("🔐 Recorded content hashes for {} unchanged files", backfilled);
            }

            (to_process, skipped)
        } else {
            (all_files, 0)
        };

        if resume {
            println!(
                "✓ Found {} total files; {} unchanged, {} to process\n",
                stats.files_found, skipped_resume, files.len()
            );
        } else {
            println!("✓ Found {} files to index\n", files.len());
        }

        // Show file type breakdown (of the files we'll actually process)
        let mut php_files = 0;
        let mut js_files = 0;
        let mut xml_files = 0;
        let mut other_files = 0;
        for f in &files {
            match f.extension().and_then(|e| e.to_str()).unwrap_or("") {
                "php" | "phtml" => php_files += 1,
                "js" => js_files += 1,
                "xml" => xml_files += 1,
                _ => other_files += 1,
            }
        }
        println!("File breakdown:");
        println!("  PHP/PHTML: {} files", php_files);
        println!("  JavaScript: {} files", js_files);
        println!("  XML: {} files", xml_files);
        println!("  Other: {} files\n", other_files);

        // Early-out: nothing to do. A previous run finished (or all discovered
        // files are already embedded) — just report stats and return.
        if files.is_empty() {
            println!("✓ Nothing to index — all discovered files already have vectors.\n");
            stats.vectors_created = self.vectordb.len();
            // The manifest can still change (deleted files, new stats of touched ones,
            // backfilled hashes); the caller saves it after index.db, and saves index.db only
            // if stats.db_changed says the vectors did. A run that changed no record leaves
            // it alone, as it does index.db.
            if manifest_path.is_some() && manifest_changed {
                if !resume {
                    manifest = crate::watcher::FileManifest::from_existing_index(&self.magento_root, &self.indexed_paths());
                    manifest.backfill_hashes(&self.magento_root);
                }
                self.pending_manifest = Some(manifest);
            }
            return Ok(stats);
        }

        // Phase 1: Parse files in parallel (no embedding needed)
        println!("════════════════════════════════════════════════════════════");
        println!("PHASE 1: Parsing files with AST analyzers");
        println!("════════════════════════════════════════════════════════════\n");

        let pb = ProgressBar::new(files.len() as u64);
        pb.set_style(
            ProgressStyle::default_bar()
                .template("{spinner:.green} [{elapsed_precise}] [{bar:40.cyan/blue}] {pos}/{len} ({percent}%) ~{eta} remaining")
                .unwrap()
                .progress_chars("█▓░"),
        );
        pb.enable_steady_tick(std::time::Duration::from_millis(100));

        let indexed = AtomicUsize::new(0);
        let skipped = AtomicUsize::new(0);
        let errors = AtomicUsize::new(0);
        let php_count = AtomicUsize::new(0);
        let js_count = AtomicUsize::new(0);
        let xml_count = AtomicUsize::new(0);
        let other_count = AtomicUsize::new(0);

        // Clone refs needed for parallel processing
        let magento_root = self.magento_root.clone();
        let xml_analyzer = &self.xml_analyzer;
        let ast_php = self.ast_available.php;
        let ast_js = self.ast_available.js;

        let parsed_results: Vec<_> = files
            .par_iter()
            .filter_map(|file_path| {
                pb.inc(1);

                let ext = file_path.extension().and_then(|e| e.to_str()).unwrap_or("");
                match ext {
                    "php" | "phtml" => php_count.fetch_add(1, Ordering::Relaxed),
                    "js" => js_count.fetch_add(1, Ordering::Relaxed),
                    "xml" => xml_count.fetch_add(1, Ordering::Relaxed),
                    _ => other_count.fetch_add(1, Ordering::Relaxed),
                };

                match Self::parse_file(file_path, &magento_root, xml_analyzer, ast_php, ast_js) {
                    Ok(Some(items)) => {
                        indexed.fetch_add(1, Ordering::Relaxed);
                        Some(items)
                    }
                    Ok(None) => {
                        skipped.fetch_add(1, Ordering::Relaxed);
                        None
                    }
                    Err(e) => {
                        tracing::warn!("Error processing {:?}: {:#}", file_path, e);
                        errors.fetch_add(1, Ordering::Relaxed);
                        None
                    }
                }
            })
            .flatten()
            .collect();

        pb.finish_with_message("✓ Parsing complete");

        stats.files_indexed = indexed.load(Ordering::Relaxed);
        stats.files_skipped = skipped.load(Ordering::Relaxed);
        stats.errors = errors.load(Ordering::Relaxed);
        stats.php_files = php_count.load(Ordering::Relaxed);
        stats.js_files = js_count.load(Ordering::Relaxed);
        stats.xml_files = xml_count.load(Ordering::Relaxed);
        stats.other_files = other_count.load(Ordering::Relaxed);

        println!("\n✓ Parsing complete:");
        println!("  Files parsed: {}", stats.files_indexed);
        println!("  Files skipped: {}", stats.files_skipped);
        println!("  Errors: {}", stats.errors);
        println!("  Items to embed: {}\n", parsed_results.len());

        // Inject LLM descriptions into embedding text (prepend before raw content)
        let mut parsed_results = parsed_results;
        if let Some(ref desc_db_path) = self.descriptions_db {
            if desc_db_path.exists() {
                match crate::describe::DescriptionDb::open_readonly(desc_db_path) {
                    Ok(desc_db) => {
                        let mut enriched = 0usize;
                        for item in &mut parsed_results {
                            if let Some(desc) = desc_db.get(&item.metadata.path) {
                                // Prepend description to embed_text
                                let prefix = format!("Description: {}\n\n", desc.description);
                                item.embed_text.insert_str(0, &prefix);
                                enriched += 1;
                            }
                        }
                        if enriched > 0 {
                            println!("✓ Enriched {} items with LLM descriptions\n", enriched);
                        }
                    }
                    Err(e) => {
                        tracing::warn!("Could not open descriptions DB: {}", e);
                    }
                }
            }
        }

        // Phase 2: Generate embeddings in batches
        let batch_size = self.batch_size;
        println!("════════════════════════════════════════════════════════════");
        println!("PHASE 2: Generating semantic embeddings (ONNX, batch={})", batch_size);
        println!("════════════════════════════════════════════════════════════\n");

        // In non-resume mode we previously replaced vectordb entirely with a
        // fresh capacity-tuned instance. In resume mode that would wipe the
        // state we just loaded from disk. Only do the reset on a fresh run.
        // (On a resume the HNSW will be slightly oversized relative to what a
        // fresh-capacity allocation would give, but correctness beats
        // micro-optimization here.)
        if !resume && preexisting_vectors == 0 {
            self.vectordb = VectorDB::with_capacity(parsed_results.len());
        }

        let total_items = parsed_results.len();
        let total_batches = (total_items + batch_size - 1) / batch_size;
        let pb = ProgressBar::new(total_items as u64);
        pb.set_style(
            ProgressStyle::default_bar()
                .template("{spinner:.green} [{elapsed_precise}] [{bar:40.cyan/blue}] {pos}/{len} ({percent}%) ~{eta} remaining")
                .unwrap()
                .progress_chars("█▓░"),
        );
        pb.enable_steady_tick(std::time::Duration::from_millis(100));

        let mut embedded = 0;
        let mut batch_num = 0;
        let phase2_start = std::time::Instant::now();

        // Process in batches with incremental saves and progress logging
        for chunk in parsed_results.chunks(batch_size) {
            let texts: Vec<&str> = chunk.iter().map(|p| p.embed_text.as_str()).collect();

            let embeddings = self.embedder.embed_batch(&texts)?;

            let batch_items: Vec<(Vec<f32>, IndexMetadata)> = embeddings
                .into_iter()
                .zip(chunk.iter())
                .map(|(emb, parsed)| (emb, parsed.metadata.clone()))
                .collect();

            let batch_len = batch_items.len();
            self.vectordb.insert_batch(batch_items);

            embedded += batch_len;
            batch_num += 1;
            pb.inc(batch_len as u64);
            pb.set_message(format!("Embedded {} vectors", embedded));

            // Log progress periodically — use pb.println() so indicatif doesn't overwrite,
            // and tracing::info! so it also appears in the log file when piped
            if batch_num % LOG_INTERVAL_BATCHES == 0 || batch_num == total_batches {
                let elapsed = phase2_start.elapsed();
                let rate = embedded as f64 / elapsed.as_secs_f64();
                let remaining = total_items - embedded;
                let eta_secs = if rate > 0.0 { remaining as f64 / rate } else { 0.0 };
                let msg = format!(
                    "[PHASE 2] {}/{} ({:.1}%) batch {}/{} elapsed={:.0}s eta={:.0}s rate={:.0} items/s",
                    embedded, total_items,
                    (embedded as f64 / total_items as f64) * 100.0,
                    batch_num, total_batches,
                    elapsed.as_secs_f64(), eta_secs, rate,
                );
                pb.println(&msg);
                tracing::info!("{}", msg);
            }

            // Incremental save to disk — enables partial recovery on crash/restart
            if batch_num % SAVE_INTERVAL_BATCHES == 0 {
                if let Some(db_path) = self.db_path.clone() {
                    self.withdraw_old_sidecar()?;
                    if let Err(e) = self.write_db(&db_path, true) {
                        tracing::warn!("Incremental save failed (non-fatal): {e}");
                    } else {
                        let msg = format!("Incremental save: {} vectors written to disk", embedded);
                        pb.println(&msg);
                        tracing::info!("{}", msg);
                    }
                }
            }
        }

        pb.finish_with_message(format!("✓ Generated {} embeddings", embedded));

        stats.vectors_created = self.vectordb.len();

        println!("\n════════════════════════════════════════════════════════════");
        println!("                    INDEXING COMPLETE                       ");
        println!("════════════════════════════════════════════════════════════\n");

        // Build the manifest for future incremental runs, and hold it back for
        // `save_manifest` — it must not reach disk before index.db does.
        // On a full (non-resume) run, build a fresh manifest from all discovered files.
        // On a resume run, update the existing manifest with newly indexed files.
        if manifest_path.is_some() {
            if !resume {
                // Full index — build manifest from filesystem, with content hashes
                manifest = crate::watcher::FileManifest::from_existing_index(&self.magento_root, &self.indexed_paths());
                manifest.backfill_hashes(&self.magento_root);
            } else {
                // Incremental — update manifest entries for the files we just processed
                let root = &self.magento_root;
                for f in &files {
                    let rel = f.strip_prefix(root).unwrap_or(f).to_string_lossy().to_string();
                    // Hash first, stat second (as `apply_indexed` does): an edit landing between
                    // the two is then {new stat, old hash}, re-checked on the next stat change,
                    // never {old stat, new hash}, which would pass that edit off as "touched".
                    let sha256 = crate::watcher::file_sha256(f);
                    if let Ok(meta) = std::fs::metadata(f) {
                        let mtime = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                        manifest.files.insert(rel, crate::watcher::FileRecord {
                            mtime,
                            size: meta.len(),
                            sha256,
                            vector_ids: Vec::new(),
                        });
                    }
                }
            }
            self.pending_manifest = Some(manifest);
        }

        stats.db_changed |= embedded > 0;
        Ok(stats)
    }

    /// Remove the old sidecar if a full rebuild is about to write index.db for the first
    /// time: from then on index.db holds a partial new index, which that sidecar would
    /// misdescribe. Called before every index.db write; does nothing once done, or when the
    /// flag was never set (the serve watcher). A file that is not there is fine; any other
    /// error stops the write.
    fn withdraw_old_sidecar(&mut self) -> Result<()> {
        if !self.withdraw_sidecar {
            return Ok(());
        }
        if let Some(sidecar) = self.db_path.as_deref().map(crate::watcher::FileManifest::sidecar_path) {
            match fs::remove_file(&sidecar) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => anyhow::bail!(
                    "Could not remove {:?} ({}); not writing index.db while it still claims the old content",
                    sidecar, e
                ),
            }
        }
        self.withdraw_sidecar = false;
        Ok(())
    }

    /// Write the manifest the last `index_with_options` prepared to the sidecar next to
    /// index.db. Call it only after index.db itself has been saved (and verified): the
    /// sidecar must never claim content that the index on disk does not hold, so a save
    /// that fails or is interrupted leaves the previous manifest and the next run embeds
    /// again what this one did not persist. Does nothing without a database path or a
    /// prepared manifest.
    pub fn save_manifest(&mut self) -> Result<()> {
        let (Some(db_path), Some(manifest)) = (&self.db_path, &self.pending_manifest) else {
            return Ok(());
        };
        let sidecar = crate::watcher::FileManifest::sidecar_path(db_path);
        manifest
            .save(&sidecar)
            .with_context(|| format!("Failed to save manifest {:?}", sidecar))?;
        tracing::info!("Saved manifest ({} files) to {:?}", manifest.files.len(), sidecar);
        self.pending_manifest = None;
        Ok(())
    }

    /// Discover files to index (no symlink following for speed)
    pub(crate) fn discover_files(&self) -> Result<Vec<PathBuf>> {
        let mut files = Vec::new();
        let root = &self.magento_root;
        let ignore = &self.ignore_patterns;

        for entry in WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| !Self::should_skip_entry(e, root, ignore))
        {
            let entry = entry?;
            if entry.file_type().is_file() {
                let path = entry.path();

                // Check the name first (cheap), then file size
                if is_indexed_file(path, root) {
                    // Use entry metadata (already cached from DirEntry)
                    if let Ok(meta) = entry.metadata() {
                        if meta.len() <= MAX_FILE_SIZE {
                            files.push(path.to_path_buf());
                        }
                    }
                }
            }
        }

        Ok(files)
    }

    /// Check if a directory entry should be skipped during traversal.
    ///
    /// Checks (in order, cheapest first):
    /// 1. Directory name against EXCLUDE_DIRS (O(1) per entry)
    /// 2. Relative path prefix against EXCLUDE_PATHS (for nested paths like pub/static)
    /// 3. .magectorignore patterns (directory prefix matching)
    pub(crate) fn should_skip_entry(
        entry: &walkdir::DirEntry,
        root: &Path,
        ignore_patterns: &[String],
    ) -> bool {
        if !entry.file_type().is_dir() {
            return false;
        }

        let name = entry.file_name().to_string_lossy();

        // 1. Fast: exact directory name match
        if EXCLUDE_DIRS.iter().any(|&d| name == *d) {
            return true;
        }

        // 2. Relative path prefix match (for paths like pub/static, dev/tools)
        if let Ok(relative) = entry.path().strip_prefix(root) {
            let rel_str = relative.to_string_lossy();

            // Check built-in path exclusions
            if EXCLUDE_PATHS.iter().any(|&p| rel_str == p || rel_str.starts_with(&format!("{}/", p))) {
                return true;
            }

            // 3. .magectorignore patterns (directory prefix matching)
            if !ignore_patterns.is_empty() {
                for pattern in ignore_patterns {
                    let trimmed = pattern.trim_end_matches('/');
                    // Exact match: "some/dir" matches "some/dir"
                    // Prefix match: "some/dir" matches "some/dir/subdir"
                    // Name match: "dirname" matches any directory with that name
                    if rel_str == trimmed
                        || rel_str.starts_with(&format!("{}/", trimmed))
                        || (!trimmed.contains('/') && name == *trimmed)
                    {
                        return true;
                    }
                }
            }
        }

        false
    }

    /// Load .magectorignore file from the project root.
    /// Returns a list of directory patterns to exclude.
    ///
    /// Format (one pattern per line, similar to .gitignore):
    ///   - Lines starting with # are comments
    ///   - Empty lines are ignored
    ///   - Trailing slashes are stripped
    ///   - Patterns without / match directory names anywhere
    ///   - Patterns with / match relative paths from project root
    pub(crate) fn load_ignore_file(root: &Path) -> Vec<String> {
        let ignore_path = root.join(".magectorignore");
        match fs::read_to_string(&ignore_path) {
            Ok(content) => content
                .lines()
                .map(|line| line.trim())
                .filter(|line| !line.is_empty() && !line.starts_with('#'))
                .map(|line| line.trim_end_matches('/').to_string())
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    /// Parse a single file (no embedding, can be parallelized with thread-local AST)
    pub(crate) fn parse_file(
        path: &Path,
        magento_root: &Path,
        xml_analyzer: &XmlAnalyzer,
        ast_php: bool,
        ast_js: bool,
    ) -> Result<Option<Vec<ParsedFile>>> {
        // Lossy: PHP allows bytes 0x80-0xff in names (Symfony's ValueWrapper declares
        // `class ©` as one Latin-1 byte) and old modules are often Latin-1 throughout, so
        // strict UTF-8 would drop such files from the index entirely.
        let content = String::from_utf8_lossy(&fs::read(path).context("Failed to read file")?).into_owned();

        if content.is_empty() {
            return Ok(None);
        }

        let relative_path = path
            .strip_prefix(magento_root)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();

        if path.strip_prefix(magento_root).is_ok_and(is_module_readme) {
            let parsed = Self::parse_module_readme(&content, relative_path);
            return Ok((!parsed.is_empty()).then_some(parsed));
        }

        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");

        let file_type = match ext {
            "php" => "php",
            "xml" => "xml",
            "phtml" => "template",
            "js" => "javascript",
            "graphqls" => "graphql",
            _ => "other",
        };

        let magento_type = detect_file_type(&relative_path);
        let module_info = extract_module_info(&relative_path);
        let area = detect_area(&relative_path);

        // Parse with thread-local AST analyzers (no mutex contention)
        let (php_ast, js_ast, xml_meta) = match ext {
            "php" | "phtml" if ast_php => {
                let php_meta = TL_PHP_ANALYZER.with(|cell| {
                    let mut opt = cell.borrow_mut();
                    opt.as_mut().map(|analyzer| analyzer.analyze(&content))
                });
                (php_meta, None, None)
            }
            "js" if ast_js => {
                let js_meta = TL_JS_ANALYZER.with(|cell| {
                    let mut opt = cell.borrow_mut();
                    opt.as_mut().map(|analyzer| analyzer.analyze(&content))
                });
                (None, js_meta, None)
            }
            "xml" => (None, None, Some(xml_analyzer.analyze(&content))),
            _ => (None, None, None),
        };

        // Analyze Setup scripts and inline SQL in PHP files
        let mut extra_search_terms = String::new();
        if ext == "php" {
            // Run SQL reference analyzer on all PHP files
            let sql_analyzer = SqlReferenceAnalyzer::new();
            let sql_tables = sql_analyzer.extract_table_references(&content);
            for table in &sql_tables {
                extra_search_terms.push_str(&format!(" sql_table {} table {} database {}", table, table, table.replace('_', " ")));
            }

            // Run Setup analyzer on Setup files
            let is_setup_file = relative_path.contains("/Setup/")
                || relative_path.contains("InstallSchema")
                || relative_path.contains("UpgradeSchema")
                || relative_path.contains("InstallData")
                || relative_path.contains("UpgradeData")
                || relative_path.contains("/Patch/");
            if is_setup_file {
                let setup_analyzer = SetupAnalyzer::new();
                let setup_meta = setup_analyzer.analyze(&content);

                for table in &setup_meta.tables_created {
                    extra_search_terms.push_str(&format!(
                        " create_table {} table_created {} legacy_schema {} declarative {}",
                        table, table, table, table.replace('_', " ")
                    ));
                }
                for trigger in &setup_meta.triggers {
                    extra_search_terms.push_str(&format!(
                        " db_trigger {} trigger {} create_trigger {} {} {} database_trigger sql_trigger",
                        trigger.name, trigger.name, trigger.name, trigger.event, trigger.timing
                    ));
                }
                for table in &setup_meta.table_references {
                    if !setup_meta.tables_created.contains(table) {
                        extra_search_terms.push_str(&format!(" table_reference {} {}", table, table.replace('_', " ")));
                    }
                }
            }
        }

        // Generate search text
        let mut search_text = Self::generate_search_text_from_ast(
            &content,
            &relative_path,
            php_ast.as_ref(),
            js_ast.as_ref(),
            xml_meta.as_ref(),
        );
        if !extra_search_terms.is_empty() {
            search_text.push_str(&extra_search_terms);
        }

        // Create embedding text (description injected later in index/index_files)
        let embed_text = Self::create_embedding_text(
            &content,
            &relative_path,
            php_ast.as_ref(),
            js_ast.as_ref(),
            &search_text,
            None,
        );

        // Build metadata
        let metadata = Self::build_metadata(
            relative_path,
            file_type,
            magento_type,
            module_info,
            area,
            php_ast,
            js_ast,
            search_text,
        );

        Ok(Some(vec![ParsedFile { embed_text, metadata }]))
    }

    /// One vector per README chunk (`readme_sections`), each led by the module name and the
    /// section heading so a hit names both. `file_type` "markdown", `magento_type` "readme";
    /// no class or method, so `find_class` / `find_method` never return a README.
    fn parse_module_readme(content: &str, relative_path: String) -> Vec<ParsedFile> {
        let module_info = extract_module_info(&relative_path);
        let module = module_info.as_ref().map(|m| m.full.clone()).unwrap_or_default();
        readme_sections(content)
            .into_iter()
            .map(|(heading, text)| {
                let embed_text = format!("{} module README, {}:\n{}", module, heading, text);
                let search_text = format!("{} README {}: {}", module, heading, text);
                let mut metadata = Self::build_metadata(
                    relative_path.clone(),
                    "markdown",
                    crate::magento::MagentoFileType::Other,
                    module_info.clone(),
                    None,
                    None,
                    None,
                    search_text,
                );
                metadata.magento_type = Some("readme".to_string());
                ParsedFile { embed_text, metadata }
            })
            .collect()
    }

    fn generate_search_text_from_ast(
        content: &str,
        path: &str,
        php_ast: Option<&PhpAstMetadata>,
        js_ast: Option<&JsAstMetadata>,
        xml_meta: Option<&crate::magento::XmlMetadata>,
    ) -> String {
        let mut terms = Vec::new();
        let path_lower = path.to_lowercase();

        // PHP AST terms
        if let Some(php) = php_ast {
            if let Some(ref class) = php.class_name {
                terms.push(class.clone());
                terms.push(split_camel_case(class));
            }
            if let Some(ref ns) = php.namespace {
                terms.push(ns.replace("\\", " "));
            }
            for method in &php.methods {
                terms.push(method.name.clone());
                terms.push(split_camel_case(&method.name));
            }
            if php.is_controller {
                // Add strong controller signals
                terms.push("controller action execute http request response".to_string());
                terms.push("controller controller controller".to_string()); // Weight boost
            }
            if php.is_repository {
                terms.push("repository data persistence save load get delete getList getById".to_string());
                terms.push("repository repository repository interface".to_string()); // Weight boost
            }
            if php.is_plugin {
                terms.push("plugin interceptor before after around".to_string());
                terms.push("plugin plugin plugin".to_string()); // Weight boost
                for pm in &php.plugin_methods {
                    terms.push(format!("{} {}", pm.method_type, pm.target_method));
                }
            }
            if php.is_observer {
                terms.push("observer event listener dispatch".to_string());
            }
            if php.is_model {
                terms.push("model entity data resource collection".to_string());
            }
            if php.is_block {
                terms.push("block template view render toHtml".to_string());
            }
            if php.is_resolver {
                terms.push("graphql resolver query mutation field".to_string());
            }
            if php.is_helper {
                terms.push("helper utility data helper helper helper".to_string()); // Weight boost
                terms.push("helper class data output".to_string());
            }
            if php.is_setup {
                terms.push("setup install schema data patch upgrade".to_string());
                terms.push("setup setup setup".to_string()); // Weight boost
            }
        }

        // Path-based fallbacks (ensure detection even if AST misses it)
        if path_lower.contains("/controller/") {
            terms.push("controller action execute http request".to_string());
            terms.push("controller controller controller".to_string());
        }
        if path_lower.contains("/helper/") {
            terms.push("helper utility data helper helper helper".to_string());
            terms.push("helper class data output abstract".to_string());
        }
        if path_lower.contains("/plugin/") {
            terms.push("plugin interceptor before after around".to_string());
            terms.push("plugin plugin plugin".to_string());
        }
        if path_lower.contains("/model/") && path_lower.contains("repository") {
            terms.push("repository data persistence save load get delete getList getById".to_string());
            terms.push("repository repository repository interface".to_string());
        }
        if path_lower.contains("/setup/") || path_lower.contains("installschema")
            || path_lower.contains("installdata") || path_lower.contains("upgradeschema")
            || path_lower.contains("upgradedata") || path_lower.contains("/patch")
        {
            terms.push("setup install schema data patch upgrade".to_string());
            terms.push("setup setup setup".to_string());
        }

        // Path-based inventory detection
        if path_lower.contains("inventory") || path_lower.contains("cataloginventory") {
            terms.push("inventory stock qty source reservation".to_string());
        }

        // JS AST terms
        if let Some(js) = js_ast {
            for class in &js.classes {
                terms.push(class.name.clone());
                terms.push(split_camel_case(&class.name));
            }
            for func in &js.functions {
                terms.push(func.name.clone());
            }
            if js.is_ui_component {
                terms.push("ui component knockout observable".to_string());
            }
            if js.is_widget {
                terms.push("jquery widget $.widget".to_string());
            }
            if js.is_mixin {
                terms.push("mixin extend override requirejs".to_string());
                if let Some(ref target) = js.mixin_target {
                    terms.push(target.clone());
                }
            }
            for dep in &js.dependencies {
                terms.push(dep.clone());
            }
        }

        // XML terms - ENHANCED
        if let Some(xml) = xml_meta {
            for pref in &xml.preferences {
                terms.push(pref.0.clone());
                terms.push(pref.1.clone());
            }
            for plugin in &xml.plugins {
                terms.push(plugin.target_class.clone());
                terms.push(plugin.name.clone());
                terms.push(plugin.plugin_class.clone());
                if plugin.disabled {
                    terms.push(format!("disabled plugin {}", plugin.name));
                }
            }
            for event in &xml.events {
                terms.push(event.clone());
            }
        }

        // XML file-specific enrichment
        if path.ends_with(".xml") {
            let filename = path.split('/').last().unwrap_or("");

            // Add filename multiple times for weight
            terms.push(filename.to_string());
            terms.push(filename.to_string());

            match filename {
                "di.xml" => {
                    terms.push("di.xml dependency injection preference plugin type virtualType argument".to_string());
                    terms.push("di.xml di.xml di.xml di.xml configuration".to_string());
                    terms.push("dependency injection dependency injection".to_string());
                    terms.push("plugin type configuration di.xml preference".to_string());
                }
                "events.xml" => {
                    terms.push("events.xml observer event listener dispatch".to_string());
                }
                "routes.xml" => {
                    terms.push("routes.xml routing frontend adminhtml".to_string());
                }
                "webapi.xml" => {
                    terms.push("webapi.xml rest api endpoint method".to_string());
                }
                "db_schema.xml" => {
                    terms.push("db_schema.xml declarative schema table column constraint".to_string());
                    terms.push("db_schema db_schema db_schema".to_string());
                }
                "acl.xml" => {
                    terms.push("acl.xml access control permission resource".to_string());
                }
                "menu.xml" => {
                    terms.push("menu.xml admin navigation".to_string());
                }
                "system.xml" => {
                    terms.push("system.xml configuration admin settings".to_string());
                }
                "config.xml" => {
                    terms.push("config.xml default configuration values".to_string());
                }
                _ if filename.contains("layout") || path_lower.contains("/layout/") => {
                    terms.push("layout xml block handle container reference".to_string());
                    terms.push("layout layout layout".to_string());
                }
                _ if filename == "widget.xml" => {
                    terms.push("widget.xml cms widget parameter".to_string());
                }
                _ if filename == "crontab.xml" => {
                    terms.push("crontab.xml cron job schedule".to_string());
                }
                _ if filename == "email_templates.xml" => {
                    terms.push("email_templates.xml email template transactional".to_string());
                }
                _ => {}
            }

            // Extract root element from XML content
            if let Some(root_start) = content.find('<') {
                if let Some(root_end) = content[root_start..].find(|c| c == ' ' || c == '>' || c == '/') {
                    let root_tag = &content[root_start + 1..root_start + root_end];
                    if !root_tag.starts_with('?') && !root_tag.starts_with('!') {
                        terms.push(format!("xml {} configuration", root_tag));
                    }
                }
            }
        }

        // Path terms
        for part in path.split('/') {
            if part.len() > 2 {
                terms.push(part.to_string());
                // Add split version for compound names
                if part.contains('_') || part.chars().any(|c| c.is_uppercase()) {
                    terms.push(split_camel_case(part));
                }
            }
        }

        terms.join(" ")
    }

    /// Create embedding text with enrichments
    fn create_embedding_text(
        content: &str,
        path: &str,
        php_ast: Option<&PhpAstMetadata>,
        js_ast: Option<&JsAstMetadata>,
        search_text: &str,
        description: Option<&str>,
    ) -> String {
        let mut text = String::with_capacity(content.len() + 2000);

        // Prepend LLM description if available — places semantic terms within
        // the 256-token ONNX window before raw content gets truncated
        if let Some(desc) = description {
            text.push_str("Description: ");
            text.push_str(desc);
            text.push_str("\n\n");
        }

        // Add code content (truncated at char boundary)
        let content_limit = 6000;
        if content.len() > content_limit {
            // Find a valid char boundary
            let mut end = content_limit;
            while end > 0 && !content.is_char_boundary(end) {
                end -= 1;
            }
            text.push_str(&content[..end]);
        } else {
            text.push_str(content);
        }

        // PHP enrichment
        if let Some(php) = php_ast {
            if let Some(ref class) = php.class_name {
                text.push_str(&format!(" class {} {} {}", class, class, class));
            }
            if let Some(ref ns) = php.namespace {
                text.push_str(&format!(" namespace {}", ns.replace('\\', " ")));
            }
            if let Some(ref ext) = php.extends {
                text.push_str(&format!(" extends {}", ext));
            }
            for impl_name in &php.implements {
                text.push_str(&format!(" implements {}", impl_name));
            }
            // Add method names with emphasis
            for method in &php.methods {
                text.push_str(&format!(" method {}", method.name));
            }
            // Add type signals for better semantic matching
            if php.is_helper {
                text.push_str(" helper helper helper utility data");
            }
            if php.is_setup {
                text.push_str(" setup setup setup install schema patch upgrade");
            }
            if php.is_plugin {
                text.push_str(" plugin plugin interceptor before after around");
            }
            if php.is_repository {
                text.push_str(" repository repository interface persistence save load get");
            }
        }

        // JS enrichment
        if let Some(js) = js_ast {
            for class in &js.classes {
                text.push_str(&format!(" class {} {}", class.name, class.name));
            }
            for dep in &js.dependencies {
                text.push_str(&format!(" requires {}", dep));
            }
            if let Some(ref name) = js.component_name {
                text.push_str(&format!(" component {}", name));
            }
        }

        // Add path components
        for part in path.split('/') {
            if part.len() > 2 {
                text.push_str(&format!(" {}", part));
            }
        }

        // Add search text
        text.push_str(&format!(" {}", search_text));

        // Truncate if too long (at char boundary)
        if text.len() > 8000 {
            let mut end = 8000;
            while end > 0 && !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
        }

        text
    }

    fn build_metadata(
        path: String,
        file_type: &str,
        magento_type: crate::magento::MagentoFileType,
        module_info: Option<crate::magento::ModuleInfo>,
        area: Option<String>,
        php_ast: Option<PhpAstMetadata>,
        js_ast: Option<JsAstMetadata>,
        search_text: String,
    ) -> IndexMetadata {
        // Path-based type detection for fallback
        let path_lower = path.to_lowercase();
        let path_is_plugin = path_lower.contains("/plugin/");
        let path_is_repository = path_lower.contains("/model/") && path_lower.contains("repository");
        let path_is_controller = path_lower.contains("/controller/");
        let path_is_observer = path_lower.contains("/observer/");
        let path_is_block = path_lower.contains("/block/");

        let (
            class_name,
            class_type,
            namespace,
            extends,
            implements,
            methods,
            is_controller,
            is_repository,
            is_plugin,
            is_observer,
            is_model,
            is_block,
            is_resolver,
            is_api_interface,
        ) = if let Some(php) = php_ast {
            (
                php.class_name,
                php.class_type,
                php.namespace,
                php.extends,
                php.implements,
                php.methods.iter().map(|m| m.name.clone()).collect(),
                php.is_controller || path_is_controller,
                php.is_repository || path_is_repository,
                php.is_plugin || path_is_plugin,
                php.is_observer || path_is_observer,
                php.is_model,
                php.is_block || path_is_block,
                php.is_resolver,
                php.is_api_interface,
            )
        } else {
            // No AST — fall back to path-based detection
            (None, None, None, None, Vec::new(), Vec::new(),
             path_is_controller, path_is_repository, path_is_plugin, path_is_observer,
             false, path_is_block, false, false)
        };

        let (is_ui_component, is_widget, is_mixin, js_dependencies) = if let Some(js) = js_ast {
            (
                js.is_ui_component,
                js.is_widget,
                js.is_mixin,
                js.dependencies,
            )
        } else {
            (false, false, false, Vec::new())
        };

        IndexMetadata {
            path,
            file_type: file_type.to_string(),
            magento_type: Some(magento_type.as_str().to_string()),
            class_name,
            class_type,
            method_name: methods.first().cloned(),
            methods,
            namespace,
            module: module_info.as_ref().map(|m| m.full.clone()),
            area,
            extends,
            implements,
            is_controller,
            is_repository,
            is_plugin,
            is_observer,
            is_model,
            is_block,
            is_resolver,
            is_api_interface,
            is_ui_component,
            is_widget,
            is_mixin,
            js_dependencies,
            search_text,
        }
    }

    /// Incrementally index a specific set of files.
    /// Returns a list of (relative_path, vector_ids) for manifest tracking.
    pub fn index_files(&mut self, files: &[PathBuf]) -> Result<Vec<(String, Vec<usize>)>> {
        let magento_root = self.magento_root.clone();
        let xml_analyzer = &self.xml_analyzer;
        let ast_php = self.ast_available.php;
        let ast_js = self.ast_available.js;

        // Parse files in parallel
        let mut parsed_results: Vec<_> = files
            .par_iter()
            .filter_map(|file_path| {
                match Self::parse_file(file_path, &magento_root, xml_analyzer, ast_php, ast_js) {
                    Ok(Some(items)) => Some(items),
                    _ => None,
                }
            })
            .flatten()
            .collect();

        if parsed_results.is_empty() {
            return Ok(Vec::new());
        }

        // Inject LLM descriptions into embedding text
        if let Some(ref desc_db_path) = self.descriptions_db {
            if desc_db_path.exists() {
                if let Ok(desc_db) = crate::describe::DescriptionDb::open_readonly(desc_db_path) {
                    for item in &mut parsed_results {
                        if let Some(desc) = desc_db.get(&item.metadata.path) {
                            let prefix = format!("Description: {}\n\n", desc.description);
                            item.embed_text.insert_str(0, &prefix);
                        }
                    }
                }
            }
        }

        // Embed and insert
        let mut result = Vec::new();
        for chunk in parsed_results.chunks(self.batch_size) {
            let texts: Vec<&str> = chunk.iter().map(|p| p.embed_text.as_str()).collect();
            let embeddings = self.embedder.embed_batch(&texts)?;

            for (emb, parsed) in embeddings.into_iter().zip(chunk.iter()) {
                let path = parsed.metadata.path.clone();
                let id = self.vectordb.insert(&emb, parsed.metadata.clone());
                // Group by path
                if let Some(entry) = result.iter_mut().find(|(p, _): &&mut (String, Vec<usize>)| p == &path) {
                    entry.1.push(id);
                } else {
                    result.push((path, vec![id]));
                }
            }
        }

        Ok(result)
    }

    /// Remove all vectors associated with a file path (tombstone)
    pub fn remove_vectors_for_path(&mut self, path: &str) -> Vec<usize> {
        self.vectordb.remove_by_path(path)
    }

    /// Get the tombstone ratio of the vector DB
    pub(crate) fn vectordb_tombstone_ratio(&self) -> f64 {
        self.vectordb.tombstone_ratio()
    }

    /// Compact the vector DB (rebuild HNSW, purge tombstones)
    pub(crate) fn compact_vectordb(&mut self) {
        self.vectordb.compact();
    }

    /// Save the index to disk
    pub fn save(&mut self, path: &Path) -> Result<()> {
        self.write_db(path, false)
    }

    /// Crash-safe save: write to temp file, then atomic rename
    pub fn save_atomic(&mut self, path: &Path) -> Result<()> {
        self.write_db(path, true)
    }

    /// `save_atomic` for a long-lived `serve`: refused when another process replaced
    /// index.db since this indexer loaded or last wrote it (`magector index`, the
    /// `magento_index` tool, another MCP instance's re-index). This copy is then older than
    /// the file, and writing it would undo that work; the watcher loads the new file instead
    /// (`reload_if_replaced`). An `index` run holds the re-index lock and writes regardless.
    pub fn save_atomic_unless_replaced(&mut self, path: &Path) -> Result<()> {
        if self.db_path.as_deref() == Some(path) && replaced_since(path, self.db_stamp) {
            anyhow::bail!("{:?} was replaced by another process since it was loaded; not overwriting it", path);
        }
        self.write_db(path, true)
    }

    fn write_db(&mut self, path: &Path, atomic: bool) -> Result<()> {
        self.withdraw_old_sidecar()?;
        if atomic {
            self.vectordb.save_atomic(path)?;
        } else {
            self.vectordb.save(path)?;
        }
        if self.db_path.as_deref() == Some(path) {
            self.db_stamp = file_stamp(path);
        }
        Ok(())
    }

    /// Load index.db again if another process replaced it since this indexer loaded or
    /// last wrote it. Returns whether it did. A file that cannot be read is left in place
    /// (it may be a newer magector's index, so it is not moved aside as `open` would) and
    /// the index loaded before is kept.
    pub fn reload_if_replaced(&mut self) -> Result<bool> {
        let Some(path) = self.db_path.clone() else { return Ok(false) };
        if !replaced_since(&path, self.db_stamp) {
            return Ok(false);
        }
        // Stat before reading: a write landing in between makes the next check reload again.
        let stamp = file_stamp(&path);
        self.vectordb = VectorDB::load(&path)
            .with_context(|| format!("Failed to load {:?}", path))?;
        self.db_stamp = stamp;
        Ok(true)
    }

    /// Embed a query string with the retrieval prefix for bge-small-en-v1.5.
    /// The prefix improves retrieval accuracy by signaling the model that this
    /// is a search query, not a document to be indexed.
    pub fn embed_query(&mut self, query: &str) -> Result<Vec<f32>> {
        let prefixed = format!("Represent this sentence: {}", query);
        self.embedder.embed(&prefixed)
    }

    /// Search the index (hybrid: semantic + keyword re-ranking)
    pub fn search(&mut self, query: &str, k: usize) -> Result<Vec<crate::vectordb::SearchResult>> {
        let mut query_embedding = self.embed_query(query)?;
        // Apply MicroLoRA adjustment before HNSW search
        if let Some(ref sona) = self.sona {
            sona.adjust_query_embedding(&mut query_embedding);
        }
        Ok(self.vectordb.hybrid_search(
            &query_embedding,
            query,
            k,
            self.sona.as_ref(),
        ))
    }

    /// Build the search graph now rather than on the first search (see `VectorDB::warm`).
    pub fn warm_search(&self) {
        self.vectordb.warm();
    }

    /// Get index statistics
    pub fn stats(&self) -> IndexStats {
        IndexStats {
            vectors_created: self.vectordb.len(),
            ..Default::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_replaced_since() {
        let dir = std::env::temp_dir().join(format!("magector_replaced_since_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let db = dir.join("index.db");

        assert!(!replaced_since(&db, None), "no file, and none was loaded");
        fs::write(&db, b"loaded").unwrap();
        let stamp = file_stamp(&db);
        assert!(stamp.is_some());
        assert!(!replaced_since(&db, stamp), "the file this indexer loaded");
        assert!(replaced_since(&db, None), "a file another process created after none was loaded");

        // Another process writes index.db the way save_atomic does: temp file, then rename.
        let tmp = dir.join("index.db.tmp");
        fs::write(&tmp, b"written by magector index").unwrap();
        fs::rename(&tmp, &db).unwrap();
        assert!(replaced_since(&db, stamp), "a replaced file");

        fs::remove_file(&db).unwrap();
        assert!(!replaced_since(&db, stamp), "a file that is gone is not a newer one");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_only_module_readmes_are_indexed_markdown() {
        let root = Path::new("/m");
        for (rel, want) in [
            ("app/code/Acme/Foo/README.md", true),
            ("app/code/Acme/Foo/readme.md", true),
            ("app/code/Acme/Foo/Model/Bar.php", true),
            ("app/code/Acme/README.md", false),
            ("app/code/Acme/Foo/docs/README.md", false),
            ("app/code/Acme/Foo/CHANGELOG.md", false),
            ("vendor/acme/module-foo/README.md", false),
            ("README.md", false),
        ] {
            assert_eq!(is_indexed_file(&root.join(rel), root), want, "{}", rel);
        }
    }

    #[test]
    fn test_readme_sections() {
        let readme = "# Acme_Foo\n\nImports Helios customers.\n\n## Purpose\nNot documented yet.\n\n\
            ## How it works\n### Import\n1. Reads rows.\n```bash\n## not a heading\n```\n\n\
            ## Data\nNone.\n\n## Verification\n";
        let got = readme_sections(readme);
        assert_eq!(
            got,
            vec![
                ("Summary".to_string(), "Imports Helios customers.".to_string()),
                (
                    "How it works > Import".to_string(),
                    "1. Reads rows.\n```bash\n## not a heading\n```".to_string()
                ),
            ]
        );

        let long: String = (0..60).map(|i| format!("{}. step number {}\n", i, i)).collect();
        let chunks = readme_sections(&format!("## How it works\n{}", long));
        assert!(chunks.len() > 1, "a long section is split");
        assert!(chunks.iter().all(|(h, t)| h == "How it works" && t.len() <= README_CHUNK_CHARS));
        let rejoined: Vec<String> = chunks.iter().map(|(_, t)| t.clone()).collect();
        assert_eq!(rejoined.join("\n"), long.trim(), "nothing is lost at the cut");
    }

    #[test]
    fn test_parse_file_module_readme() {
        let dir = std::env::temp_dir().join(format!("magector_readme_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("app/code/Acme/Api/README.md");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "# Acme_Api\n\nREST API for orders.\n\n## Purpose\nOrders for SAP.\n").unwrap();

        let parsed = Indexer::parse_file(&path, &dir, &XmlAnalyzer::new(), false, false)
            .unwrap()
            .unwrap();
        assert_eq!(parsed.len(), 2);
        for p in &parsed {
            assert_eq!(p.metadata.path, "app/code/Acme/Api/README.md");
            assert_eq!(p.metadata.file_type, "markdown");
            // Not "api": the path rules of detect_file_type do not apply to a README.
            assert_eq!(p.metadata.magento_type.as_deref(), Some("readme"));
            assert_eq!(p.metadata.module.as_deref(), Some("Acme_Api"));
            assert!(p.metadata.class_name.is_none() && p.metadata.method_name.is_none());
        }
        assert_eq!(parsed[1].embed_text, "Acme_Api module README, Purpose:\nOrders for SAP.");
        assert!(parsed[1].metadata.search_text.starts_with("Acme_Api README Purpose: "));

        fs::write(&path, "# Acme_Api\n\n## Purpose\nNot documented yet.\n").unwrap();
        assert!(
            Indexer::parse_file(&path, &dir, &XmlAnalyzer::new(), false, false).unwrap().is_none(),
            "a README that says nothing gives no vector"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
