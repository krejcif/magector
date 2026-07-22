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

use crate::indexer::{Indexer, INCLUDE_EXTENSIONS, MAX_FILE_SIZE};

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
    pub vector_ids: Vec<usize>,
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

    /// Load manifest from a sidecar file next to the index DB.
    /// Returns None if the file doesn't exist or can't be parsed.
    pub fn load(path: &Path) -> Option<Self> {
        let data = std::fs::read(path).ok()?;
        bincode::serde::decode_from_slice(&data, bincode::config::standard())
            .map(|(val, _)| val)
            .ok()
    }

    /// Save manifest to a sidecar file next to the index DB.
    pub fn save(&self, path: &Path) -> Result<()> {
        let data = bincode::serde::encode_to_vec(self, bincode::config::standard())?;
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

    /// Build initial manifest from the current index metadata.
    /// This scans the filesystem to populate mtime/size for files already in the index.
    /// Only includes files that are in `indexed_paths` (have vectors in the DB).
    pub fn from_existing_index(magento_root: &Path, indexed_paths: &std::collections::HashSet<String>) -> Self {
        let mut manifest = Self::new();
        // Walk the filesystem and record current mtimes for files we'd index
        let walker = WalkDir::new(magento_root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| !Indexer::should_skip_dir(e));

        for entry in walker.flatten() {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let ext = match path.extension().and_then(|e| e.to_str()) {
                Some(e) => e,
                None => continue,
            };
            if !INCLUDE_EXTENSIONS.contains(&ext) {
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
                        vector_ids: Vec::new(), // IDs unknown for pre-existing index
                    },
                );
            }
        }

        manifest
    }

    /// Scan the filesystem and detect changes against the manifest
    pub fn detect_changes(&self, magento_root: &Path) -> Result<ChangeSet> {
        let mut changes = ChangeSet::default();
        let mut seen = std::collections::HashSet::new();

        let walker = WalkDir::new(magento_root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| !Indexer::should_skip_dir(e));

        for entry in walker.flatten() {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let ext = match path.extension().and_then(|e| e.to_str()) {
                Some(e) => e,
                None => continue,
            };
            if !INCLUDE_EXTENSIONS.contains(&ext) {
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
                    // Check if modified (mtime or size changed)
                    let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                    if mtime != record.mtime || meta.len() != record.size {
                        changes.modified.push(path.to_path_buf());
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
            let (mtime, size) = match std::fs::metadata(&abs_path) {
                Ok(m) => (
                    m.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    m.len(),
                ),
                Err(_) => (SystemTime::UNIX_EPOCH, 0),
            };
            self.files.insert(
                rel_path.clone(),
                FileRecord {
                    mtime,
                    size,
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
        let paths = idx.indexed_paths();
        FileManifest::from_existing_index(&magento_root, &paths)
    };

    {
        let mut s = lock_recover(&status, "status");
        s.tracked_files = manifest.files.len();
    }

    tracing::info!("Initial manifest: {} files tracked", manifest.files.len());

    loop {
        std::thread::sleep(interval);

        // Detect changes
        let changes = match manifest.detect_changes(&magento_root) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("Watcher scan error: {}", e);
                continue;
            }
        };

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

        // 1. Tombstone modified and deleted files under a short-lived lock.
        {
            let mut idx = lock_recover(&indexer, "indexer");
            for path in &changes.modified {
                let relative = path
                    .strip_prefix(&magento_root)
                    .unwrap_or(path)
                    .to_string_lossy()
                    .to_string();
                idx.remove_vectors_for_path(&relative);
            }
            for path in &changes.deleted {
                idx.remove_vectors_for_path(path);
            }
        }
        manifest.apply_deleted(&changes.deleted);

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
                        // Persist progress for this chunk (crash-safe).
                        if let Err(e) = idx.save_atomic(&db_path) {
                            tracing::error!("Failed to persist index during watcher update: {}", e);
                        }
                    }
                    Err(e) => {
                        tracing::error!("Incremental index error: {}", e);
                    }
                }
                // Lock dropped here at end of scope, before the next chunk.
            }
            tracing::info!("Indexed {} files ({} entries)", indexed_files, indexed_entries);
        }

        // 3. Compact if the tombstone ratio is high, and always persist the
        //    final state. The chunk loop above already saved after each chunk,
        //    so only write again when there is something the loop did not cover:
        //    a compaction, or a tick that only deleted files.
        {
            let mut idx = lock_recover(&indexer, "indexer");
            let mut needs_save = files_to_index.is_empty(); // delete-only tick
            if idx.vectordb_tombstone_ratio() > COMPACT_THRESHOLD {
                tracing::info!("Compacting vector DB (tombstone ratio > {}%)", (COMPACT_THRESHOLD * 100.0) as u32);
                idx.compact_vectordb();
                needs_save = true;
            }
            if needs_save {
                if let Err(e) = idx.save_atomic(&db_path) {
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
    fn test_manifest_save_load_roundtrip() {
        let dir = make_temp_dir();
        let manifest_path = dir.join("test.manifest");

        let mut manifest = FileManifest::new();
        manifest.files.insert(
            "app/code/Vendor/Module/Model/Foo.php".to_string(),
            FileRecord {
                mtime: SystemTime::UNIX_EPOCH + Duration::from_secs(1700000000),
                size: 4096,
                vector_ids: vec![10, 11, 12],
            },
        );
        manifest.files.insert(
            "vendor/magento/module-catalog/etc/di.xml".to_string(),
            FileRecord {
                mtime: SystemTime::UNIX_EPOCH + Duration::from_secs(1600000000),
                size: 2048,
                vector_ids: vec![20],
            },
        );

        // Save
        manifest.save(&manifest_path).unwrap();
        assert!(manifest_path.exists());

        // Load
        let loaded = FileManifest::load(&manifest_path).unwrap();
        assert_eq!(loaded.files.len(), 2);

        let foo = loaded.files.get("app/code/Vendor/Module/Model/Foo.php").unwrap();
        assert_eq!(foo.size, 4096);
        assert_eq!(foo.vector_ids, vec![10, 11, 12]);

        let di = loaded.files.get("vendor/magento/module-catalog/etc/di.xml").unwrap();
        assert_eq!(di.size, 2048);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_sidecar_path() {
        let db_path = PathBuf::from("/data/.magector/index.db");
        let sidecar = FileManifest::sidecar_path(&db_path);
        assert_eq!(sidecar, PathBuf::from("/data/.magector/index.manifest"));
    }
}
