//! File watcher for incremental re-indexing
//!
//! Polls the Magento root directory for changed files and incrementally
//! updates the HNSW index without requiring a restart.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime};
use walkdir::WalkDir;
use sha2::{Digest, Sha256};

use crate::indexer::{is_indexed_file, Indexer, MAX_FILE_SIZE};

/// Path to the cross-entrypoint reindex lock, shared with the JS side
/// (`src/index-lock.js`) — the same file both `npx magector index` and this
/// watcher loop check before writing to `index.db`.
fn reindex_lock_path(magento_root: &Path) -> PathBuf {
    magento_root.join(".magector").join("reindex.pid")
}

/// Check whether the PID in `.magector/reindex.pid` belongs to a still-running
/// process. Mirrors `getRunningIndexPid()` in `src/index-lock.js` — signal 0 /
/// `kill -0` is an existence check, it does not actually send a signal.
fn is_pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        std::process::Command::new("kill")
            .arg("-0")
            .arg(pid.to_string())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}")])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
}

/// Returns the PID of an external indexer (a manually-invoked `npx magector
/// index`, or another MCP instance's background reindex) currently holding
/// the reindex lock for this root, or `None` if the lock is absent or stale.
/// A stale lock (dead PID) is removed so it doesn't block forever.
fn external_reindex_pid(magento_root: &Path) -> Option<u32> {
    let lock_path = reindex_lock_path(magento_root);
    let contents = std::fs::read_to_string(&lock_path).ok()?;
    let pid: u32 = contents.trim().parse().ok()?;
    if is_pid_alive(pid) {
        Some(pid)
    } else {
        let _ = std::fs::remove_file(&lock_path);
        None
    }
}

/// Lock a mutex, recovering from poisoning instead of propagating the panic.
///
/// A poisoned mutex means another thread panicked while holding the lock
/// (for example, the `feedback` handler panicking inside `update_fisher`).
/// The watcher thread must keep running so that incremental re-indexing
/// resumes as soon as the offending call path is patched — otherwise a
/// single transient panic takes the watcher offline until the MCP server
/// is restarted.
fn lock_recover<'a, T>(mutex: &'a Mutex<T>, label: &str) -> MutexGuard<'a, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            tracing::warn!(
                "Watcher: {} mutex was poisoned by a prior panic — recovering and continuing",
                label
            );
            poisoned.into_inner()
        }
    }
}

/// Tracked state for a single file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileRecord {
    pub mtime: SystemTime,
    pub size: u64,
    /// SHA-256 of the content when the file was last indexed or verified. `None` for
    /// records migrated from a v1 manifest or built from an existing index, until
    /// `backfill_hashes` or the next index of that file fills it.
    pub sha256: Option<[u8; 32]>,
    pub vector_ids: Vec<usize>,
}

impl FileRecord {
    /// A record `index` always re-embeds: no real file has this size, and without a
    /// hash it can never be classified touched; `backfill_hashes` skips it because the
    /// stat never matches. For a path that is gone, `index` still reports it deleted.
    pub fn stale() -> Self {
        FileRecord { mtime: SystemTime::UNIX_EPOCH, size: u64::MAX, sha256: None, vector_ids: Vec::new() }
    }

    /// Whether this is the sentinel `stale()` builds.
    pub fn is_stale(&self) -> bool {
        self.size == u64::MAX && self.mtime == SystemTime::UNIX_EPOCH && self.sha256.is_none()
    }
}

/// On-disk record before 2.17.0 (mtime + size only), decoded for migration.
#[derive(Deserialize)]
struct FileRecordV1 {
    mtime: SystemTime,
    size: u64,
    vector_ids: Vec<usize>,
}

#[derive(Deserialize)]
struct FileManifestV1 {
    files: HashMap<String, FileRecordV1>,
}

/// Prefix of a v2 manifest file. A v1 file (bincode varint map length, then a path string)
/// can start with "MGMF" only with exactly 77 entries and a 71-byte first path starting with
/// "MF". `load` then returns None (a rebuild), except for a first path starting "MF\x02\0",
/// which would read as an empty v2 manifest — no path can contain NUL.
const MANIFEST_MAGIC: &[u8] = b"MGMF\x02";

/// SHA-256 of a file's content; `None` when the file cannot be read.
pub(crate) fn file_sha256(path: &Path) -> Option<[u8; 32]> {
    let data = std::fs::read(path).ok()?;
    let mut out = [0u8; 32];
    out.copy_from_slice(&Sha256::digest(&data));
    Some(out)
}

/// Whether `path` currently has this mtime and size.
fn stat_matches(path: &Path, mtime: SystemTime, size: u64) -> bool {
    std::fs::metadata(path)
        .map(|m| m.modified().unwrap_or(SystemTime::UNIX_EPOCH) == mtime && m.len() == size)
        .unwrap_or(false)
}

/// Manifest of all indexed files and their metadata
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct FileManifest {
    pub files: HashMap<String, FileRecord>,
}

/// Set of changes detected in a scan
#[derive(Debug, Default)]
pub struct ChangeSet {
    pub added: Vec<PathBuf>,
    pub modified: Vec<PathBuf>,
    pub deleted: Vec<String>,
    /// mtime or size changed but the content hash is identical: the manifest takes
    /// the new stat, nothing is re-embedded. (relative path, mtime, size)
    pub touched: Vec<(String, SystemTime, u64)>,
}

impl ChangeSet {
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.modified.is_empty() && self.deleted.is_empty()
    }

    pub fn total(&self) -> usize {
        self.added.len() + self.modified.len() + self.deleted.len()
    }
}

impl FileManifest {
    pub fn new() -> Self {
        Self {
            files: HashMap::new(),
        }
    }

    /// Load manifest from a sidecar file next to the index DB. Reads v2 (content
    /// hashes) and migrates v1 (mtime + size only; `sha256 = None`).
    /// Returns None if the file doesn't exist or can't be parsed.
    pub fn load(path: &Path) -> Option<Self> {
        let data = std::fs::read(path).ok()?;
        let cfg = bincode::config::standard();
        if let Some(body) = data.strip_prefix(MANIFEST_MAGIC) {
            return bincode::serde::decode_from_slice(body, cfg).map(|(val, _)| val).ok();
        }
        if data.starts_with(&MANIFEST_MAGIC[..4]) {
            return None; // a newer manifest version: rebuild rather than misread it
        }
        let (v1, _): (FileManifestV1, usize) = bincode::serde::decode_from_slice(&data, cfg).ok()?;
        Some(Self {
            files: v1
                .files
                .into_iter()
                .map(|(path, r)| {
                    (path, FileRecord { mtime: r.mtime, size: r.size, sha256: None, vector_ids: r.vector_ids })
                })
                .collect(),
        })
    }

    /// Save manifest (v2) to a sidecar file next to the index DB.
    pub fn save(&self, path: &Path) -> Result<()> {
        let mut data = MANIFEST_MAGIC.to_vec();
        data.extend(bincode::serde::encode_to_vec(self, bincode::config::standard())?);
        // Atomic write: write to temp, then rename
        let tmp = path.with_extension("manifest.tmp");
        std::fs::write(&tmp, &data)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    /// Derive the manifest sidecar path from the index DB path.
    /// e.g. `.magector/index.db` → `.magector/index.manifest`
    pub fn sidecar_path(db_path: &Path) -> PathBuf {
        db_path.with_extension("manifest")
    }

    /// Before 2.17.0 the MCP background re-index swapped `index.db.new` into place but left
    /// its manifest behind as `index.db.manifest`, so the live index had none and `index`
    /// treated every indexed file as current, however stale. When the live sidecar is
    /// missing, that orphan is moved into its place — it describes the index now live —
    /// unless a temp DB it may belong to is still there. The names mirror the JS side
    /// (`tempDbPathFor`, `manifestPath`); a DB path without an extension never had an
    /// orphan. Returns the adopted file.
    pub fn adopt_orphan(db_path: &Path) -> Option<PathBuf> {
        db_path.extension()?;
        let with_suffix = |suffix: &str| {
            let mut name = db_path.as_os_str().to_owned();
            name.push(suffix);
            PathBuf::from(name)
        };
        let (orphan, temp_db) = (with_suffix(".manifest"), with_suffix(".new"));
        let sidecar = Self::sidecar_path(db_path);
        if sidecar.exists() || temp_db.exists() || !orphan.exists() || !db_path.exists() {
            return None;
        }
        std::fs::rename(&orphan, &sidecar).ok()?;
        Some(orphan)
    }

    /// Mark `paths` stale in the sidecar manifest at `sidecar`: its records stop claiming
    /// that index.db holds their content, so the next `index` re-embeds them (or reports
    /// them deleted) instead of trusting an old hash. Only an existing, readable sidecar
    /// is updated — without one, `index` rebuilds it from the index anyway, and a partial
    /// one would make `index` re-add every other file. Returns whether it was updated.
    /// A sidecar that exists but cannot be loaded (corrupt, or written by a newer
    /// magector) is an `Err`, and left in place: a magector that can parse it would trust
    /// claims the caller is about to make false, so the caller must remove it.
    pub fn mark_stale_in_sidecar(sidecar: &Path, paths: &[String]) -> Result<bool> {
        if paths.is_empty() {
            return Ok(false);
        }
        // The watcher thread and the serve `describe` command both mark paths here: one
        // read-modify-write of the sidecar at a time, or one's marks could be lost.
        static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());
        let _one_at_a_time = ONE_AT_A_TIME.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(mut manifest) = Self::load(sidecar) else {
            if matches!(sidecar.try_exists(), Ok(false)) {
                return Ok(false);
            }
            anyhow::bail!("the sidecar exists but cannot be read");
        };
        for path in paths {
            manifest.files.insert(path.clone(), FileRecord::stale());
        }
        manifest.save(sidecar)?;
        Ok(true)
    }

    /// Build initial manifest from the current index metadata.
    /// This scans the filesystem to populate mtime/size for files already in the index.
    /// Only includes files that are in `indexed_paths` (have vectors in the DB).
    pub fn from_existing_index(magento_root: &Path, indexed_paths: &std::collections::HashSet<String>) -> Self {
        let mut manifest = Self::new();
        // Walk the filesystem and record current mtimes for files we'd index
        let ignore = Indexer::load_ignore_file(magento_root);
        let walker = WalkDir::new(magento_root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| !Indexer::should_skip_entry(e, magento_root, &ignore));

        for entry in walker.flatten() {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            if !is_indexed_file(path, magento_root) {
                continue;
            }
            if let Ok(meta) = entry.metadata() {
                if meta.len() > MAX_FILE_SIZE {
                    continue;
                }
                let relative = path
                    .strip_prefix(magento_root)
                    .unwrap_or(path)
                    .to_string_lossy()
                    .to_string();

                // Only include files that actually have vectors in the DB
                if !indexed_paths.contains(&relative) {
                    continue;
                }

                let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                manifest.files.insert(
                    relative,
                    FileRecord {
                        mtime,
                        size: meta.len(),
                        sha256: None, // filled by backfill_hashes (index) or apply_indexed
                        vector_ids: Vec::new(), // IDs unknown for pre-existing index
                    },
                );
            }
        }

        manifest
    }

    /// Adopt the sidecar's record for every path this manifest tracks, when that record
    /// carries a content hash or is a stale sentinel. `from_existing_index` cannot know
    /// hashes; the sidecar describes the index.db a `serve` just loaded, so its hashes let
    /// a checkout that only rewrites mtimes be classified touched instead of re-embedded,
    /// and its stale sentinels keep forcing the re-embed they demand. A sidecar record with
    /// neither (v1, or an unreadable hash) adds nothing over the current stat and is skipped.
    /// Paths the index does not hold are never added.
    pub fn seed_from(&mut self, sidecar: &FileManifest) {
        for (path, rec) in self.files.iter_mut() {
            if let Some(from) = sidecar.files.get(path) {
                if from.sha256.is_some() || from.is_stale() {
                    *rec = from.clone();
                }
            }
        }
    }

    /// Track every indexed path this manifest has no record of as stale. `detect_changes`
    /// only reports paths it tracks, so without this the vectors of an indexed file that is
    /// gone (or now excluded) would stay in the index for good — a manifest rebuilt with
    /// `from_existing_index` only records files the walk still finds. A tracked stale path
    /// the walk finds is re-embedded, one it does not is reported deleted. Returns how many
    /// were added.
    pub fn track_indexed(&mut self, indexed_paths: &std::collections::HashSet<String>) -> usize {
        let mut added = 0;
        for path in indexed_paths {
            if !self.files.contains_key(path) {
                self.files.insert(path.clone(), FileRecord::stale());
                added += 1;
            }
        }
        added
    }

    /// Scan the filesystem and detect changes against the manifest
    pub fn detect_changes(&self, magento_root: &Path) -> Result<ChangeSet> {
        let mut changes = ChangeSet::default();
        let mut seen = std::collections::HashSet::new();

        let ignore = Indexer::load_ignore_file(magento_root);
        let walker = WalkDir::new(magento_root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| !Indexer::should_skip_entry(e, magento_root, &ignore));

        for entry in walker.flatten() {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            if !is_indexed_file(path, magento_root) {
                continue;
            }
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.len() > MAX_FILE_SIZE {
                continue;
            }

            let relative = path
                .strip_prefix(magento_root)
                .unwrap_or(path)
                .to_string_lossy()
                .to_string();

            seen.insert(relative.clone());

            match self.files.get(&relative) {
                None => {
                    // New file
                    changes.added.push(path.to_path_buf());
                }
                Some(record) => {
                    let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                    if mtime != record.mtime || meta.len() != record.size {
                        // Stat changed. A checkout, `COPY` or `docker cp` rewrites the mtime
                        // of files whose content is identical — compare content first.
                        match record.sha256 {
                            Some(old) if file_sha256(path) == Some(old) => {
                                changes.touched.push((relative.clone(), mtime, meta.len()));
                            }
                            _ => changes.modified.push(path.to_path_buf()),
                        }
                    }
                }
            }
        }

        // Detect deleted files
        for key in self.files.keys() {
            if !seen.contains(key) {
                changes.deleted.push(key.clone());
            }
        }

        Ok(changes)
    }

    /// Update manifest after indexing new/modified files
    pub fn apply_indexed(
        &mut self,
        magento_root: &Path,
        indexed: &[(String, Vec<usize>)],
    ) {
        for (rel_path, vector_ids) in indexed {
            let abs_path = magento_root.join(rel_path);
            // Hash first, stat second: an edit landing between the two is then recorded as
            // {new stat, old hash}, which a later stat change re-checks — never as
            // {old stat, new hash}, which would pass that edit off as "touched" for good.
            let sha256 = file_sha256(&abs_path);
            let (mtime, size) = match std::fs::metadata(&abs_path) {
                Ok(m) => (m.modified().unwrap_or(SystemTime::UNIX_EPOCH), m.len()),
                Err(_) => (SystemTime::UNIX_EPOCH, 0),
            };
            self.files.insert(
                rel_path.clone(),
                FileRecord {
                    mtime,
                    size,
                    sha256,
                    vector_ids: vector_ids.clone(),
                },
            );
        }
    }

    /// Remove deleted files from manifest
    pub fn apply_deleted(&mut self, deleted: &[String]) {
        for path in deleted {
            self.files.remove(path);
        }
    }

    /// Record the new stat of files whose content did not change.
    pub fn apply_touched(&mut self, touched: &[(String, SystemTime, u64)]) {
        for (rel, mtime, size) in touched {
            if let Some(rec) = self.files.get_mut(rel) {
                rec.mtime = *mtime;
                rec.size = *size;
            }
        }
    }

    /// Fill in missing content hashes for files that are unchanged on disk (mtime and
    /// size still match the record), so the next environment can tell a touched file
    /// from a modified one. A record whose file changed is left alone: it is
    /// re-indexed, and apply_indexed records its hash then. Returns how many were filled.
    pub fn backfill_hashes(&mut self, magento_root: &Path) -> usize {
        let mut filled = 0;
        for (rel, rec) in self.files.iter_mut() {
            if rec.sha256.is_some() {
                continue;
            }
            let abs = magento_root.join(rel);
            if !stat_matches(&abs, rec.mtime, rec.size) {
                continue;
            }
            // Keep the hash only if the file did not change while it was read: the hash of
            // newer content next to the old stat would pass a later edit off as "touched".
            if let Some(hash) = file_sha256(&abs).filter(|_| stat_matches(&abs, rec.mtime, rec.size)) {
                rec.sha256 = Some(hash);
                filled += 1;
            }
        }
        filled
    }
}

/// Threshold for automatic compaction (when >20% vectors are tombstoned)
const COMPACT_THRESHOLD: f64 = 0.20;

/// Maximum files indexed per chunk inside the watcher's incremental update.
///
/// The watcher persists (`save_atomic`) and releases the indexer lock after
/// each chunk. This matters when a large backlog accumulates (e.g. after a big
/// dependency install, or the first run against an index that predates many new
/// files): indexing the whole backlog in one locked call can take far longer
/// than the process stays alive, so without chunked persistence the partial
/// work is never written to disk and the same files are re-detected as "added"
/// on every restart — the index never converges. Saving per chunk makes the
/// progress durable, and releasing the lock between chunks keeps search queries
/// responsive instead of timing out for the entire run.
const WATCHER_INDEX_CHUNK: usize = 512;

/// Watcher status reported via serve protocol
#[derive(Debug, Clone, serde::Serialize)]
pub struct WatcherStatus {
    pub running: bool,
    pub tracked_files: usize,
    pub last_scan_changes: usize,
    pub interval_secs: u64,
}

/// Paths of `chunk` (relative to `magento_root`) that produced no vectors,
/// paired with empty vector ids, for recording in the manifest.
fn zero_entry_paths(
    magento_root: &Path,
    chunk: &[PathBuf],
    indexed: &[(String, Vec<usize>)],
) -> Vec<(String, Vec<usize>)> {
    let produced: std::collections::HashSet<&str> =
        indexed.iter().map(|(p, _)| p.as_str()).collect();
    chunk
        .iter()
        .map(|p| p.strip_prefix(magento_root).unwrap_or(p).to_string_lossy().to_string())
        .filter(|rel| !produced.contains(rel.as_str()))
        .map(|rel| (rel, Vec::new()))
        .collect()
}

/// The watcher's manifest for the index `idx` holds: the files it has vectors for with their
/// current stat, the content hashes and stale sentinels of the sidecar that describes that
/// index.db, and every indexed file the walk no longer finds tracked stale, so the first scan
/// drops its vectors.
fn manifest_for(idx: &Indexer, magento_root: &Path, db_path: &Path) -> FileManifest {
    let paths = idx.indexed_paths();
    let mut manifest = FileManifest::from_existing_index(magento_root, &paths);
    // The sidecar describes the index.db this serve just loaded: take its content hashes
    // (and stale sentinels) so a checkout during serve is "touched", not re-embedded.
    if let Some(sidecar) = FileManifest::load(&FileManifest::sidecar_path(db_path)) {
        manifest.seed_from(&sidecar);
    }
    manifest.track_indexed(&paths);
    manifest
}

/// Run the file watcher loop in a background thread.
///
/// Sleeps for `interval`, then detects changes and incrementally re-indexes.
/// Acquires the indexer mutex only during the index update.
pub fn watcher_loop(
    indexer: Arc<Mutex<Indexer>>,
    magento_root: PathBuf,
    db_path: PathBuf,
    interval: Duration,
    status: Arc<Mutex<WatcherStatus>>,
) {
    tracing::info!(
        "File watcher started: root={:?}, interval={}s",
        magento_root,
        interval.as_secs()
    );

    // Build initial manifest
    let mut manifest = {
        let idx = lock_recover(&indexer, "indexer");
        manifest_for(&idx, &magento_root, &db_path)
    };

    {
        let mut s = lock_recover(&status, "status");
        s.tracked_files = manifest.files.len();
    }

    tracing::info!("Initial manifest: {} files tracked", manifest.files.len());

    loop {
        std::thread::sleep(interval);

        // Another process may have replaced index.db since this serve loaded or last saved
        // it: `magector index`, the `magento_index` tool, another MCP instance's re-index.
        // Load that index before anything else — answering from the old copy is stale, and
        // this loop's next save would write it back over the new one. Not while an indexer
        // holds the lock: it is still writing.
        if external_reindex_pid(&magento_root).is_none() {
            let mut idx = lock_recover(&indexer, "indexer");
            match idx.reload_if_replaced() {
                Ok(false) => {}
                Ok(true) => {
                    idx.warm_search();
                    manifest = manifest_for(&idx, &magento_root, &db_path);
                    lock_recover(&status, "status").tracked_files = manifest.files.len();
                    tracing::info!(
                        "index.db was replaced by another process — reloaded {} vectors, {} files tracked",
                        idx.stats().vectors_created,
                        manifest.files.len()
                    );
                }
                Err(e) => {
                    tracing::warn!(
                        "index.db was replaced by another process but could not be loaded ({:#}); keeping the loaded index and not writing index.db",
                        e
                    );
                    continue;
                }
            }
        }

        // Detect changes
        let changes = match manifest.detect_changes(&magento_root) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("Watcher scan error: {}", e);
                continue;
            }
        };

        // Record the new stat of files whose content is unchanged before the empty check:
        // a touched-only scan needs no indexing, but must not be re-reported every tick.
        manifest.apply_touched(&changes.touched);

        if changes.is_empty() {
            continue;
        }

        let total = changes.total();
        tracing::info!(
            "Watcher detected {} changes: {} added, {} modified, {} deleted",
            total,
            changes.added.len(),
            changes.modified.len(),
            changes.deleted.len()
        );

        // Defer to an external indexer (a manually-invoked `npx magector index`,
        // or another MCP instance's background reindex) holding the same
        // reindex.pid lock this watcher never used to check. Without this, the
        // two could concurrently save_atomic() the same index.db and clobber
        // each other's write — the exact failure mode that prompted the lock
        // in the first place. Skip this cycle without touching index.db or the
        // sidecar; the same changes are re-detected and retried next tick.
        if let Some(pid) = external_reindex_pid(&magento_root) {
            tracing::warn!(
                "Watcher: external indexer (PID {}) holds the reindex lock — deferring this cycle",
                pid
            );
            continue;
        }

        // `index` trusts the sidecar manifest to describe index.db: a matching content
        // hash there means "these vectors are current". This loop is about to change
        // index.db without rewriting those records, so mark every path it touches stale
        // there first (a stale record only withdraws a claim, so doing it before the DB
        // write is safe at any crash point). If that fails — including a sidecar it cannot
        // read, which a newer magector might still trust — remove the sidecar: `index`
        // rebuilds a missing one; if even that fails, leave index.db alone this tick.
        let sidecar = FileManifest::sidecar_path(&db_path);
        let changing: Vec<String> = changes
            .added
            .iter()
            .chain(changes.modified.iter())
            .map(|p| p.strip_prefix(&magento_root).unwrap_or(p).to_string_lossy().to_string())
            .chain(changes.deleted.iter().cloned())
            .collect();
        if let Err(e) = FileManifest::mark_stale_in_sidecar(&sidecar, &changing) {
            tracing::warn!("Watcher: could not mark changed files stale in {:?} ({}); removing it", sidecar, e);
            if let Err(e) = std::fs::remove_file(&sidecar) {
                if sidecar.exists() {
                    tracing::error!("Watcher: could not remove stale sidecar {:?} ({}); skipping this cycle", sidecar, e);
                    continue;
                }
            }
        }

        // 1. Tombstone modified and deleted files under a short-lived lock.
        let mut removed_any = false;
        {
            let mut idx = lock_recover(&indexer, "indexer");
            for path in &changes.modified {
                let relative = path
                    .strip_prefix(&magento_root)
                    .unwrap_or(path)
                    .to_string_lossy()
                    .to_string();
                if !idx.remove_vectors_for_path(&relative).is_empty() {
                    removed_any = true;
                }
            }
            for path in &changes.deleted {
                if !idx.remove_vectors_for_path(path).is_empty() {
                    removed_any = true;
                }
            }
        }
        manifest.apply_deleted(&changes.deleted);

        // Unsaved vector DB changes (tombstones, inserts). A tick that touched
        // nothing — e.g. only re-attempted zero-entry files — must not rewrite
        // the whole index.db.
        let mut dirty = removed_any;

        // 2. Index added and modified files in bounded chunks. After each chunk
        //    we persist to disk (so an interrupted process keeps its progress
        //    and the same files are not re-detected forever) and release the
        //    indexer lock (so search queries are not starved while a large
        //    backlog is processed). See WATCHER_INDEX_CHUNK.
        let files_to_index: Vec<PathBuf> = changes
            .added
            .iter()
            .chain(changes.modified.iter())
            .cloned()
            .collect();

        if !files_to_index.is_empty() {
            let mut indexed_files = 0usize;
            let mut indexed_entries = 0usize;
            for chunk in files_to_index.chunks(WATCHER_INDEX_CHUNK) {
                let mut idx = lock_recover(&indexer, "indexer");
                match idx.index_files(chunk) {
                    Ok(indexed) => {
                        manifest.apply_indexed(&magento_root, &indexed);
                        indexed_files += chunk.len();
                        indexed_entries += indexed.len();

                        // A file that matched INCLUDE_EXTENSIONS/size limits but
                        // produced zero vectors (empty, unparseable, ...) is not
                        // in `indexed` — index_files only returns paths that got
                        // at least one vector. Record it in the manifest anyway
                        // (empty vector_ids) so detect_changes stops reporting
                        // it as "added" on every tick; a later edit still
                        // re-triggers it via the mtime/size check.
                        let zero_entry = zero_entry_paths(&magento_root, chunk, &indexed);
                        if !zero_entry.is_empty() {
                            manifest.apply_indexed(&magento_root, &zero_entry);
                        }

                        if !indexed.is_empty() {
                            dirty = true;
                            // Persist progress for this chunk (crash-safe).
                            if let Err(e) = idx.save_atomic_unless_replaced(&db_path) {
                                tracing::error!("Failed to persist index during watcher update: {}", e);
                            } else {
                                dirty = false;
                            }
                        }
                    }
                    Err(e) => {
                        tracing::error!("Incremental index error: {}", e);
                        // The whole chunk failed to index (not a per-file zero
                        // result). Record it as attempted anyway so it isn't
                        // hot-looped every tick forever; a modification (mtime/
                        // size change) will re-detect and retry it.
                        // Earlier embedding batches of this chunk may already be in memory.
                        dirty = true;
                        let attempted = zero_entry_paths(&magento_root, chunk, &[]);
                        manifest.apply_indexed(&magento_root, &attempted);
                        // Nothing was embedded, so no hash: a later stat change must retry
                        // these files, not pass them off as "touched".
                        for (rel, _) in &attempted {
                            if let Some(rec) = manifest.files.get_mut(rel) {
                                rec.sha256 = None;
                            }
                        }
                    }
                }
                // Lock dropped here at end of scope, before the next chunk.
            }
            tracing::info!("Indexed {} files ({} entries)", indexed_files, indexed_entries);
        }

        // 3. Compact if the tombstone ratio is high, and persist the final
        //    state only if something is actually dirty: the chunk loop above
        //    already saved after any chunk that added vectors, so a further
        //    save here is needed only for unsaved tombstones from step 1
        //    (e.g. a delete/modify-only tick) or for compaction. A tick where
        //    every change turned out to be a zero-entry add leaves `dirty`
        //    false and skips this save entirely.
        {
            let mut idx = lock_recover(&indexer, "indexer");
            let mut needs_save = dirty;
            if idx.vectordb_tombstone_ratio() > COMPACT_THRESHOLD {
                tracing::info!("Compacting vector DB (tombstone ratio > {}%)", (COMPACT_THRESHOLD * 100.0) as u32);
                idx.compact_vectordb();
                needs_save = true;
            }
            if needs_save {
                if let Err(e) = idx.save_atomic_unless_replaced(&db_path) {
                    tracing::error!("Failed to save index after watcher update: {}", e);
                }
            }
        }

        // 4. Update status
        {
            let mut s = lock_recover(&status, "status");
            s.tracked_files = manifest.files.len();
            s.last_scan_changes = total;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    use std::sync::atomic::{AtomicU32, Ordering};

    static TEST_COUNTER: AtomicU32 = AtomicU32::new(0);

    fn make_temp_dir() -> PathBuf {
        let n = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "magector_watcher_{}_{}_{}",
            std::process::id(),
            n,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn record_for(path: &Path, vector_ids: Vec<usize>) -> FileRecord {
        let meta = fs::metadata(path).unwrap();
        FileRecord {
            mtime: meta.modified().unwrap(),
            size: meta.len(),
            sha256: file_sha256(path),
            vector_ids,
        }
    }

    /// A manifest tracking `rel` with its current stat and no hash (what
    /// `from_existing_index` builds), plus a sidecar whose record for `rel` is `sidecar_rec`.
    fn seeded(dir: &Path, rel: &str, sidecar_rec: Option<FileRecord>) -> FileManifest {
        let indexed: std::collections::HashSet<String> = [rel.to_string()].into();
        let mut watcher = FileManifest::from_existing_index(dir, &indexed);
        let mut sidecar = FileManifest::new();
        if let Some(rec) = sidecar_rec {
            sidecar.files.insert(rel.to_string(), rec);
        }
        // a path the sidecar knows but the index does not must not be added
        sidecar.files.insert("not-in-index.php".to_string(), FileRecord::stale());
        watcher.seed_from(&sidecar);
        assert!(!watcher.files.contains_key("not-in-index.php"));
        watcher
    }

    #[test]
    fn test_seed_from_sidecar_hash_makes_a_checkout_touched() {
        // serve starts from the index, whose records have no hash. After a checkout rewrites
        // the mtime, the sidecar's hash is what tells "touched" from "modified".
        let dir = make_temp_dir();
        let php = dir.join("same.php");
        fs::write(&php, "<?php echo 'same';").unwrap();
        let mut rec = record_for(&php, vec![7]);
        rec.mtime = SystemTime::UNIX_EPOCH; // the sidecar has the stat from index time
        let watcher = seeded(&dir, "same.php", Some(rec));
        let changes = watcher.detect_changes(&dir).unwrap();
        assert!(changes.modified.is_empty(), "identical content must not be re-embedded");
        assert_eq!(changes.touched.len(), 1);

        // a sidecar record without a hash (v1, or a hash that could not be read) says nothing
        // the watcher's current-stat record does not: it is not copied
        let mut unhashed = record_for(&php, vec![7]);
        unhashed.mtime = SystemTime::UNIX_EPOCH;
        unhashed.sha256 = None;
        let watcher = seeded(&dir, "same.php", Some(unhashed));
        assert_ne!(watcher.files["same.php"].mtime, SystemTime::UNIX_EPOCH);
        assert!(watcher.detect_changes(&dir).unwrap().is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_seed_from_sidecar_edit_while_down_is_modified() {
        // the file changed after it was indexed (serve was not running): the sidecar's hash
        // differs from the disk, so the watcher re-embeds it instead of trusting the stat.
        let dir = make_temp_dir();
        let php = dir.join("edit.php");
        fs::write(&php, "<?php echo 'old';").unwrap();
        let mut rec = record_for(&php, vec![1]);
        rec.mtime = SystemTime::UNIX_EPOCH;
        fs::write(&php, "<?php echo 'new content';").unwrap();
        let changes = seeded(&dir, "edit.php", Some(rec)).detect_changes(&dir).unwrap();
        assert_eq!(rel_paths(&dir, &changes.modified), vec!["edit.php"]);
        assert!(changes.touched.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_seed_from_sidecar_stale_sentinel_is_modified() {
        // a path the sidecar withdrew its claim on keeps forcing a re-embed
        let dir = make_temp_dir();
        let php = dir.join("stale.php");
        fs::write(&php, "<?php echo 'x';").unwrap();
        let watcher = seeded(&dir, "stale.php", Some(FileRecord::stale()));
        let changes = watcher.detect_changes(&dir).unwrap();
        assert_eq!(rel_paths(&dir, &changes.modified), vec!["stale.php"]);
        assert!(changes.touched.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_touched_file_is_not_modified() {
        // A checkout, `COPY` or `docker cp` rewrites mtimes of files whose content is
        // identical (a real project saw ~4.8k false "modified"). Those must not be re-embedded.
        let dir = make_temp_dir();
        let php = dir.join("same.php");
        fs::write(&php, "<?php echo 'same';").unwrap();
        let mut manifest = FileManifest::new();
        let mut rec = record_for(&php, vec![0]);
        rec.mtime = SystemTime::UNIX_EPOCH; // stat differs from disk, content does not
        manifest.files.insert("same.php".to_string(), rec);

        let changes = manifest.detect_changes(&dir).unwrap();
        assert!(changes.modified.is_empty(), "identical content must not be re-embedded");
        assert_eq!(changes.touched.len(), 1);
        assert!(changes.is_empty(), "a touched-only scan needs no indexing");

        manifest.apply_touched(&changes.touched);
        let again = manifest.detect_changes(&dir).unwrap();
        assert!(again.touched.is_empty(), "the new stat is recorded");
        assert!(again.modified.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_changed_content_is_modified_even_with_hash() {
        let dir = make_temp_dir();
        let php = dir.join("edit.php");
        fs::write(&php, "<?php echo 'v1';").unwrap();
        let mut manifest = FileManifest::new();
        manifest.files.insert("edit.php".to_string(), record_for(&php, vec![0]));
        fs::write(&php, "<?php echo 'v2 is longer';").unwrap();

        let changes = manifest.detect_changes(&dir).unwrap();
        assert_eq!(changes.modified.len(), 1);
        assert!(changes.touched.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_missing_hash_with_changed_stat_is_modified() {
        // Records without a hash (v1 manifest) keep the old rule: a stat change re-embeds.
        let dir = make_temp_dir();
        let php = dir.join("old.php");
        fs::write(&php, "<?php echo 'old';").unwrap();
        let mut manifest = FileManifest::new();
        let mut rec = record_for(&php, vec![0]);
        rec.sha256 = None;
        rec.mtime = SystemTime::UNIX_EPOCH;
        manifest.files.insert("old.php".to_string(), rec);

        let changes = manifest.detect_changes(&dir).unwrap();
        assert_eq!(changes.modified.len(), 1);
        assert!(changes.touched.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_backfill_hashes_only_unchanged_files() {
        let dir = make_temp_dir();
        let same = dir.join("same.php");
        let changed = dir.join("changed.php");
        fs::write(&same, "<?php // same").unwrap();
        fs::write(&changed, "<?php // changed").unwrap();
        let mut manifest = FileManifest::new();
        let mut a = record_for(&same, vec![0]);
        a.sha256 = None;
        let mut b = record_for(&changed, vec![1]);
        b.sha256 = None;
        b.mtime = SystemTime::UNIX_EPOCH; // changed since it was indexed
        manifest.files.insert("same.php".to_string(), a);
        manifest.files.insert("changed.php".to_string(), b);

        assert_eq!(manifest.backfill_hashes(&dir), 1);
        assert!(manifest.files["same.php"].sha256.is_some());
        assert!(
            manifest.files["changed.php"].sha256.is_none(),
            "a changed file must stay modified — never hashed into 'touched'"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// Manifest keys of `paths` (relative to `root`), sorted.
    fn rel_paths(root: &Path, paths: &[PathBuf]) -> Vec<String> {
        let mut rel: Vec<String> = paths
            .iter()
            .map(|p| p.strip_prefix(root).unwrap().to_string_lossy().to_string())
            .collect();
        rel.sort();
        rel
    }

    #[test]
    fn test_mark_stale_defeats_unchanged_and_touched() {
        // The serve watcher changes index.db without rewriting the sidecar, and `index`
        // trusts a matching hash there. Once a path is marked stale, neither an equal stat
        // ("unchanged") nor an equal hash ("touched") may pass for "index.db holds this".
        let dir = make_temp_dir();
        let same = dir.join("same.php");
        let restored = dir.join("restored.php");
        fs::write(&same, "<?php echo 'same';").unwrap();
        fs::write(&restored, "<?php echo 'restored';").unwrap();
        let mut manifest = FileManifest::new();
        manifest.files.insert("same.php".to_string(), record_for(&same, vec![0]));
        let mut rec = record_for(&restored, vec![1]);
        rec.mtime = SystemTime::UNIX_EPOCH; // a checkout rewrote the mtime; content is C1 again
        manifest.files.insert("restored.php".to_string(), rec);
        let sidecar = dir.join("index.manifest");
        manifest.save(&sidecar).unwrap();

        let before = FileManifest::load(&sidecar).unwrap().detect_changes(&dir).unwrap();
        assert!(before.modified.is_empty() && before.added.is_empty(), "precondition: both records are trusted");
        assert_eq!(before.touched.len(), 1, "precondition: the restored file passes for touched");

        let paths = vec!["same.php".to_string(), "restored.php".to_string()];
        assert!(FileManifest::mark_stale_in_sidecar(&sidecar, &paths).unwrap());

        let after = FileManifest::load(&sidecar).unwrap().detect_changes(&dir).unwrap();
        assert_eq!(
            rel_paths(&dir, &after.modified),
            vec!["restored.php", "same.php"],
            "stale records are re-embedded, never trusted"
        );
        assert!(after.touched.is_empty());
        assert!(after.added.is_empty() && after.deleted.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_mark_stale_covers_added_and_deleted_paths() {
        // Added paths (no record yet) get one; deleted paths must not keep their old one.
        let dir = make_temp_dir();
        let kept = dir.join("kept.php");
        let gone = dir.join("gone.php");
        fs::write(&kept, "<?php // kept").unwrap();
        fs::write(&gone, "<?php // gone").unwrap();
        fs::write(dir.join("added.php"), "<?php // added").unwrap(); // on disk, not in the manifest
        let mut manifest = FileManifest::new();
        manifest.files.insert("kept.php".to_string(), record_for(&kept, vec![0]));
        manifest.files.insert("gone.php".to_string(), record_for(&gone, vec![1]));
        fs::remove_file(&gone).unwrap();
        let sidecar = dir.join("index.manifest");
        manifest.save(&sidecar).unwrap();

        let paths = vec!["added.php".to_string(), "gone.php".to_string()];
        assert!(FileManifest::mark_stale_in_sidecar(&sidecar, &paths).unwrap());

        let updated = FileManifest::load(&sidecar).unwrap();
        for rel in ["added.php", "gone.php"] {
            let rec = &updated.files[rel];
            assert_eq!((rec.size, rec.sha256), (u64::MAX, None), "{rel} must hold a stale record");
        }
        assert!(updated.files["kept.php"].sha256.is_some(), "an unmarked path keeps its claim");

        let changes = updated.detect_changes(&dir).unwrap();
        assert_eq!(changes.deleted, vec!["gone.php".to_string()], "index still reports it deleted");
        assert_eq!(rel_paths(&dir, &changes.modified), vec!["added.php"]);
        assert!(changes.added.is_empty() && changes.touched.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_mark_stale_without_a_usable_sidecar_writes_nothing() {
        let dir = make_temp_dir();
        let sidecar = dir.join("index.manifest");
        let paths = vec!["a.php".to_string()];

        // No sidecar: `index` rebuilds it from the index, a partial one would make it
        // re-add every other file.
        assert!(!FileManifest::mark_stale_in_sidecar(&sidecar, &paths).unwrap());
        assert!(!sidecar.exists());

        // A sidecar that exists but cannot be loaded (a newer format, or garbage) is an
        // error, not a skip: a magector that can parse it would trust claims the caller is
        // about to make false, so the caller must remove it. It is left as it is here.
        for junk in [&b"MGMF\x09junk"[..], &b"not a manifest"[..]] {
            fs::write(&sidecar, junk).unwrap();
            assert!(FileManifest::mark_stale_in_sidecar(&sidecar, &paths).is_err());
            assert_eq!(fs::read(&sidecar).unwrap(), junk);
        }
        fs::remove_file(&sidecar).unwrap();

        // Nothing to mark: no rewrite of a good sidecar either.
        let mut manifest = FileManifest::new();
        manifest.files.insert("a.php".to_string(), FileRecord::stale());
        manifest.save(&sidecar).unwrap();
        let bytes = fs::read(&sidecar).unwrap();
        assert!(!FileManifest::mark_stale_in_sidecar(&sidecar, &[]).unwrap());
        assert_eq!(fs::read(&sidecar).unwrap(), bytes);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_concurrent_marks_do_not_lose_each_other() {
        // The watcher thread and the serve `describe` command both mark paths stale, and each
        // mark is a read-modify-write of the same sidecar: unserialized, they lose updates.
        let dir = make_temp_dir();
        let sidecar = dir.join("index.manifest");
        FileManifest::new().save(&sidecar).unwrap();

        let threads: Vec<_> = (0..8)
            .map(|t| {
                let sidecar = sidecar.clone();
                std::thread::spawn(move || {
                    for i in 0..25 {
                        let paths = vec![format!("t{t}/f{i}.php")];
                        assert!(FileManifest::mark_stale_in_sidecar(&sidecar, &paths).unwrap());
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().expect("a mark failed while another was writing");
        }

        assert_eq!(FileManifest::load(&sidecar).unwrap().files.len(), 8 * 25, "a mark was lost");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_backfill_never_fills_a_stale_record() {
        // backfill_hashes would otherwise hash the current file into the stale record and
        // hand `index` a matching hash for content the DB does not hold.
        let dir = make_temp_dir();
        fs::write(dir.join("f.php"), "<?php // f").unwrap();
        let mut manifest = FileManifest::new();
        manifest.files.insert("f.php".to_string(), FileRecord::stale());

        assert_eq!(manifest.backfill_hashes(&dir), 0);
        assert!(manifest.files["f.php"].sha256.is_none());
        assert_eq!(manifest.detect_changes(&dir).unwrap().modified.len(), 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_v1_manifest_loads_and_migrates() {
        #[derive(Serialize)]
        struct V1Record {
            mtime: SystemTime,
            size: u64,
            vector_ids: Vec<usize>,
        }
        #[derive(Serialize)]
        struct V1Manifest {
            files: HashMap<String, V1Record>,
        }

        let dir = make_temp_dir();
        let path = dir.join("index.manifest");
        let mut files = HashMap::new();
        files.insert(
            "a.php".to_string(),
            V1Record {
                mtime: SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000),
                size: 42,
                vector_ids: vec![3],
            },
        );
        let bytes =
            bincode::serde::encode_to_vec(&V1Manifest { files }, bincode::config::standard()).unwrap();
        fs::write(&path, bytes).unwrap();

        let loaded = FileManifest::load(&path).expect("a v1 manifest must still load");
        let a = &loaded.files["a.php"];
        assert_eq!(a.size, 42);
        assert_eq!(a.vector_ids, vec![3]);
        assert!(a.sha256.is_none());

        loaded.save(&path).unwrap();
        assert!(fs::read(&path).unwrap().starts_with(MANIFEST_MAGIC), "saves write v2");
        assert_eq!(FileManifest::load(&path).unwrap().files["a.php"].size, 42);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_v2_manifest_byte_layout_is_pinned() {
        // This literal pins the released 2.17.0 on-disk format. Any change to the record
        // layout (field, type, order) changes these bytes: it needs a new version byte and
        // a migration in `load`, or sidecars written by 2.17.0 are misread.
        const V2_HEX: &str = "4d474d46020105612e706870fc00f15365002a0107070707070707070707070707070707070707070707070707070707070707070103";

        let hex = |bytes: &[u8]| bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let record = FileRecord {
            mtime: SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000),
            size: 42,
            sha256: Some([7u8; 32]),
            vector_ids: vec![3],
        };
        let mut manifest = FileManifest::new();
        manifest.files.insert("a.php".to_string(), record.clone());

        let dir = make_temp_dir();
        let path = dir.join("index.manifest");
        manifest.save(&path).unwrap();
        assert_eq!(hex(&fs::read(&path).unwrap()), V2_HEX, "the v2 byte layout changed");

        // ... and the pinned bytes load back to the same record.
        let bytes: Vec<u8> = (0..V2_HEX.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&V2_HEX[i..i + 2], 16).unwrap())
            .collect();
        fs::write(&path, bytes).unwrap();
        let loaded = FileManifest::load(&path).expect("the pinned v2 bytes must load");
        assert_eq!(loaded.files.len(), 1);
        let got = &loaded.files["a.php"];
        assert_eq!(got.mtime, record.mtime);
        assert_eq!(got.size, record.size);
        assert_eq!(got.sha256, record.sha256);
        assert_eq!(got.vector_ids, record.vector_ids);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_unknown_manifest_version_is_rejected() {
        // `MGMF` + an unknown version byte is a newer format: rebuild, never misread it.
        // The payload is deliberately also a well-formed v1 file (77 entries; the first has
        // the 71-byte key `MF\x03` + zeros; every other field is zero), so only the explicit
        // check stops `load` from returning a bogus manifest.
        let mut bytes = b"MGMF\x03".to_vec();
        bytes.resize(bytes.len() + 68 + 4 + 76 * 5, 0);

        let dir = make_temp_dir();
        let path = dir.join("index.manifest");
        fs::write(&path, &bytes).unwrap();
        assert!(FileManifest::load(&path).is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_lock_recover_from_poisoned_mutex() {
        // Reproduces Bug 2: a panic in another thread while holding the lock
        // poisons it. The watcher used to crash on `lock().unwrap()` and stop
        // all incremental indexing. After the fix, `lock_recover` must return
        // the inner guard so the watcher thread can keep running.
        let m: Arc<Mutex<u32>> = Arc::new(Mutex::new(0));
        let m2 = m.clone();

        let handle = std::thread::spawn(move || {
            let _guard = m2.lock().unwrap();
            panic!("simulated panic while holding lock");
        });
        let _ = handle.join(); // swallow the panic

        assert!(m.is_poisoned(), "precondition: mutex must be poisoned");

        // This is the call-site that matters — it must not panic.
        let guard = lock_recover(&m, "test");
        assert_eq!(*guard, 0);
    }

    #[test]
    fn test_detect_no_changes() {
        let dir = make_temp_dir();
        let php = dir.join("test.php");
        fs::write(&php, "<?php echo 'hello';").unwrap();

        let meta = fs::metadata(&php).unwrap();
        let mut manifest = FileManifest::new();
        manifest.files.insert(
            "test.php".to_string(),
            FileRecord {
                mtime: meta.modified().unwrap(),
                size: meta.len(),
                sha256: None,
                vector_ids: vec![0],
            },
        );

        let changes = manifest.detect_changes(&dir).unwrap();
        assert!(
            changes.is_empty(),
            "Expected no changes but got: added={}, modified={}, deleted={}",
            changes.added.len(), changes.modified.len(), changes.deleted.len()
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_detect_new_file() {
        let dir = make_temp_dir();
        let php = dir.join("new.php");
        fs::write(&php, "<?php echo 'new';").unwrap();

        let manifest = FileManifest::new();
        let changes = manifest.detect_changes(&dir).unwrap();
        assert_eq!(changes.added.len(), 1);
        assert!(changes.modified.is_empty());
        assert!(changes.deleted.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_detect_modified_file() {
        let dir = make_temp_dir();
        let php = dir.join("mod.php");
        fs::write(&php, "<?php echo 'v1';").unwrap();

        let mut manifest = FileManifest::new();
        manifest.files.insert(
            "mod.php".to_string(),
            FileRecord {
                mtime: SystemTime::UNIX_EPOCH,
                size: 0,
                sha256: None,
                vector_ids: vec![0],
            },
        );

        let changes = manifest.detect_changes(&dir).unwrap();
        assert!(changes.added.is_empty());
        assert_eq!(changes.modified.len(), 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_detect_deleted_file() {
        let dir = make_temp_dir();
        let mut manifest = FileManifest::new();
        manifest.files.insert(
            "gone.php".to_string(),
            FileRecord {
                mtime: SystemTime::UNIX_EPOCH,
                size: 100,
                sha256: None,
                vector_ids: vec![0],
            },
        );

        let changes = manifest.detect_changes(&dir).unwrap();
        assert!(changes.added.is_empty());
        assert!(changes.modified.is_empty());
        assert_eq!(changes.deleted.len(), 1);
        assert_eq!(changes.deleted[0], "gone.php");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_scans_skip_what_a_full_index_skips() {
        // `discover_files` honours EXCLUDE_PATHS and .magectorignore; the resume and serve
        // scans must too. Otherwise they index files a full index never saw (every Magento
        // root has dev/tools/**/*.js) and `files_found - to_process.len()` underflows.
        let dir = make_temp_dir();
        let all = [
            "app/code/X/Y.php", "pub/static/a.js", "dev/tools/b.js", "vendor/bin/c.php", "custom/d.php",
            // Markdown: only a module README is indexed.
            "app/code/X/Z/README.md", "app/code/X/Z/docs/e.md", "vendor/x/module-z/README.md",
        ];
        for rel in all {
            let path = dir.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "// x").unwrap();
        }
        fs::write(dir.join(".magectorignore"), "# not indexed\ncustom\n").unwrap();

        let want = vec!["app/code/X/Y.php", "app/code/X/Z/README.md"];
        let changes = FileManifest::new().detect_changes(&dir).unwrap();
        assert_eq!(rel_paths(&dir, &changes.added), want);

        let indexed: std::collections::HashSet<String> = all.iter().map(|p| p.to_string()).collect();
        let manifest = FileManifest::from_existing_index(&dir, &indexed);
        let mut tracked: Vec<String> = manifest.files.keys().cloned().collect();
        tracked.sort();
        assert_eq!(tracked, want);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_chunked_apply_persists_partial_progress() {
        // Models the watcher's chunked incremental update: each chunk's
        // apply_indexed is followed by a save, so if the process is interrupted
        // after chunk N, the files from the first N chunks stay tracked (their
        // vectors were written to disk) and are NOT re-detected as "added" on
        // restart, while the remaining files are simply retried next tick.
        //
        // The old all-or-nothing behavior (index the whole changeset, then save
        // once at the very end) lost ALL progress on interruption, so a backlog
        // larger than one process lifetime never converged.
        let dir = make_temp_dir();
        for i in 0..5 {
            fs::write(dir.join(format!("f{i}.php")), "<?php\n").unwrap();
        }

        // Nothing indexed yet → all five files are "added".
        let mut manifest = FileManifest::new();
        let initial = manifest.detect_changes(&dir).unwrap();
        assert_eq!(initial.added.len(), 5);

        // Process only the first chunk of 2 files, then simulate a crash.
        let chunk: Vec<(String, Vec<usize>)> = initial
            .added
            .iter()
            .take(2)
            .map(|p| {
                (
                    p.strip_prefix(&dir).unwrap().to_string_lossy().to_string(),
                    vec![0usize],
                )
            })
            .collect();
        manifest.apply_indexed(&dir, &chunk);

        // After restart the two persisted files must be tracked; only the
        // remaining three are re-detected (durable partial progress).
        let after_crash = manifest.detect_changes(&dir).unwrap();
        assert_eq!(
            after_crash.added.len(),
            3,
            "partial progress must persist; only the unprocessed files are retried"
        );

        // Finishing the remainder converges to zero changes.
        let rest: Vec<(String, Vec<usize>)> = after_crash
            .added
            .iter()
            .map(|p| {
                (
                    p.strip_prefix(&dir).unwrap().to_string_lossy().to_string(),
                    vec![0usize],
                )
            })
            .collect();
        manifest.apply_indexed(&dir, &rest);
        assert!(
            manifest.detect_changes(&dir).unwrap().is_empty(),
            "after all chunks are applied the backlog must converge to empty"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_apply_indexed_records_content_hash() {
        let dir = make_temp_dir();
        let php = dir.join("hashed.php");
        fs::write(&php, "<?php echo 'hashed';").unwrap();

        let mut manifest = FileManifest::new();
        manifest.apply_indexed(&dir, &[("hashed.php".to_string(), vec![0])]);

        let recorded = manifest.files["hashed.php"].sha256;
        assert!(recorded.is_some(), "apply_indexed must record the content hash");
        assert_eq!(recorded, file_sha256(&php));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_zero_entry_paths_excludes_indexed_files() {
        let root = PathBuf::from("/m");
        let chunk = vec![
            root.join("app/code/Acme/A/Model/Foo.php"),
            root.join("app/code/Acme/A/etc/empty.xml"),
        ];
        let indexed = vec![("app/code/Acme/A/Model/Foo.php".to_string(), vec![1, 2])];
        let zero = zero_entry_paths(&root, &chunk, &indexed);
        assert_eq!(zero, vec![("app/code/Acme/A/etc/empty.xml".to_string(), Vec::new())]);
        assert_eq!(zero_entry_paths(&root, &chunk, &[]).len(), 2);
    }

    #[test]
    fn test_zero_entry_file_not_reported_after_apply() {
        // Reproduces the production bug: a file that matches INCLUDE_EXTENSIONS
        // but yields 0 index entries (empty, unparseable, ...) must still be
        // recorded in the manifest (with empty vector_ids) once the watcher has
        // attempted it, otherwise detect_changes reports it as "added" forever.
        let dir = make_temp_dir();
        let php = dir.join("empty.php");
        fs::write(&php, "").unwrap();

        let mut manifest = FileManifest::new();
        let changes = manifest.detect_changes(&dir).unwrap();
        assert_eq!(changes.added.len(), 1, "empty file should be detected as added the first time");

        // Simulate the watcher recording the attempted file with no vectors
        // (what apply_indexed now does for zero-entry results).
        manifest.apply_indexed(&dir, &[("empty.php".to_string(), Vec::new())]);

        let changes_after = manifest.detect_changes(&dir).unwrap();
        assert!(
            changes_after.is_empty(),
            "zero-entry file must not be re-reported once tracked in the manifest"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_zero_entry_file_retried_after_modification() {
        // A zero-entry file that is later modified (mtime/size changes) must be
        // re-detected and retried — being tracked with empty vector_ids does not
        // permanently exempt it from future scans.
        let dir = make_temp_dir();
        let php = dir.join("empty.php");
        fs::write(&php, "").unwrap();

        let mut manifest = FileManifest::new();
        manifest.apply_indexed(&dir, &[("empty.php".to_string(), Vec::new())]);
        assert!(manifest.detect_changes(&dir).unwrap().is_empty());

        // Modify the file so its size/mtime changes.
        std::thread::sleep(Duration::from_millis(10));
        fs::write(&php, "<?php echo 'now has content';").unwrap();

        let changes = manifest.detect_changes(&dir).unwrap();
        assert_eq!(
            changes.modified.len(),
            1,
            "modified zero-entry file must be re-detected for retry"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_manifest_save_load_roundtrip() {
        let dir = make_temp_dir();
        let manifest_path = dir.join("test.manifest");

        let mut manifest = FileManifest::new();
        manifest.files.insert(
            "app/code/Vendor/Module/Model/Foo.php".to_string(),
            FileRecord {
                mtime: SystemTime::UNIX_EPOCH + Duration::from_secs(1700000000),
                size: 4096,
                sha256: Some([7u8; 32]),
                vector_ids: vec![10, 11, 12],
            },
        );
        manifest.files.insert(
            "vendor/magento/module-catalog/etc/di.xml".to_string(),
            FileRecord {
                mtime: SystemTime::UNIX_EPOCH + Duration::from_secs(1600000000),
                size: 2048,
                sha256: None,
                vector_ids: vec![20],
            },
        );

        // Save
        manifest.save(&manifest_path).unwrap();
        assert!(manifest_path.exists());
        assert!(
            fs::read(&manifest_path).unwrap().starts_with(MANIFEST_MAGIC),
            "saves write v2"
        );

        // Load
        let loaded = FileManifest::load(&manifest_path).unwrap();
        assert_eq!(loaded.files.len(), 2);

        let foo = loaded.files.get("app/code/Vendor/Module/Model/Foo.php").unwrap();
        assert_eq!(foo.size, 4096);
        assert_eq!(foo.sha256, Some([7u8; 32]));
        assert_eq!(foo.vector_ids, vec![10, 11, 12]);

        let di = loaded.files.get("vendor/magento/module-catalog/etc/di.xml").unwrap();
        assert_eq!(di.size, 2048);
        assert_eq!(di.sha256, None);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_sidecar_path() {
        let db_path = PathBuf::from("/data/.magector/index.db");
        let sidecar = FileManifest::sidecar_path(&db_path);
        assert_eq!(sidecar, PathBuf::from("/data/.magector/index.manifest"));
    }

    #[test]
    fn test_is_pid_alive_for_current_process() {
        assert!(is_pid_alive(std::process::id()));
    }

    #[test]
    fn test_is_pid_alive_false_for_impossible_pid() {
        // PIDs this large cannot exist on Linux (pid_max) or macOS.
        assert!(!is_pid_alive(999_999_999));
    }

    #[test]
    fn test_external_reindex_pid_none_without_lock_file() {
        let dir = make_temp_dir();
        assert_eq!(external_reindex_pid(&dir), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_external_reindex_pid_detects_live_process() {
        // Reproduces the bug: the watcher used to have no way to see the
        // reindex.pid lock at all, so it would race a concurrent `npx
        // magector index` writing the same index.db. Our own test process
        // PID stands in for "another indexer is running".
        let dir = make_temp_dir();
        let lock_path = reindex_lock_path(&dir);
        fs::create_dir_all(lock_path.parent().unwrap()).unwrap();
        fs::write(&lock_path, std::process::id().to_string()).unwrap();

        assert_eq!(external_reindex_pid(&dir), Some(std::process::id()));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_external_reindex_pid_cleans_up_stale_lock() {
        let dir = make_temp_dir();
        let lock_path = reindex_lock_path(&dir);
        fs::create_dir_all(lock_path.parent().unwrap()).unwrap();
        fs::write(&lock_path, "999999999").unwrap();

        assert_eq!(external_reindex_pid(&dir), None);
        assert!(!lock_path.exists(), "stale lock file should be removed");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_track_indexed_drops_gone_and_reembeds_untracked() {
        // A lost or rebuilt manifest: `from_existing_index` records only the indexed files the
        // walk still finds, so a deleted (or now excluded) one was never reported deleted and
        // its vectors stayed in the index for good.
        let dir = make_temp_dir();
        fs::write(dir.join("kept.php"), "<?php echo 'kept';").unwrap();
        fs::create_dir_all(dir.join("dev/tools")).unwrap();
        fs::write(dir.join("dev/tools/excluded.php"), "<?php echo 'excluded';").unwrap();
        let indexed: std::collections::HashSet<String> = ["kept.php", "gone.php", "dev/tools/excluded.php"]
            .iter()
            .map(|s| s.to_string())
            .collect();

        let mut manifest = FileManifest::from_existing_index(&dir, &indexed);
        assert_eq!(manifest.files.len(), 1, "only the file the walk finds is recorded");
        assert_eq!(manifest.track_indexed(&indexed), 2);
        let changes = manifest.detect_changes(&dir).unwrap();
        let mut deleted = changes.deleted.clone();
        deleted.sort();
        assert_eq!(deleted, vec!["dev/tools/excluded.php".to_string(), "gone.php".to_string()]);
        assert!(changes.added.is_empty() && changes.modified.is_empty(), "the recorded file is unchanged");

        // A recorded path keeps its record
        let before = manifest.files["kept.php"].clone();
        assert_eq!(manifest.track_indexed(&indexed), 0);
        assert_eq!(manifest.files["kept.php"].mtime, before.mtime);

        // An indexed file still on disk that a loaded manifest has no record of is
        // re-embedded (modified), not embedded again on top of its vectors as new.
        let mut manifest = FileManifest::new();
        assert_eq!(manifest.track_indexed(&["kept.php".to_string()].into_iter().collect()), 1);
        let changes = manifest.detect_changes(&dir).unwrap();
        assert_eq!(changes.modified, vec![dir.join("kept.php")]);
        assert!(changes.added.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_adopt_orphan_moves_the_pre_2_17_manifest_into_place() {
        let dir = make_temp_dir();
        let db = dir.join("index.db");
        let orphan = dir.join("index.db.manifest");
        let sidecar = dir.join("index.manifest");
        fs::write(&db, "db").unwrap();
        fs::write(&orphan, "orphan").unwrap();

        // A temp DB it may belong to is still there: leave it
        fs::write(dir.join("index.db.new"), "temp").unwrap();
        assert_eq!(FileManifest::adopt_orphan(&db), None);
        fs::remove_file(dir.join("index.db.new")).unwrap();

        assert_eq!(FileManifest::adopt_orphan(&db), Some(orphan.clone()));
        assert_eq!(fs::read_to_string(&sidecar).unwrap(), "orphan");
        assert!(!orphan.exists());

        // A live sidecar is never replaced
        fs::write(&orphan, "orphan 2").unwrap();
        assert_eq!(FileManifest::adopt_orphan(&db), None);
        assert_eq!(fs::read_to_string(&sidecar).unwrap(), "orphan");

        // No live DB, or a DB path without an extension (its temp never had its own sidecar)
        fs::remove_file(&sidecar).unwrap();
        fs::remove_file(&db).unwrap();
        assert_eq!(FileManifest::adopt_orphan(&db), None);
        assert_eq!(FileManifest::adopt_orphan(&dir.join("index")), None);

        let _ = fs::remove_dir_all(&dir);
    }
}
