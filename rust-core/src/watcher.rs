//! File watcher for incremental re-indexing
//!
//! Polls the Magento root directory for changed files and incrementally
//! updates the HNSW index without requiring a restart.

use anyhow::Result;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use walkdir::WalkDir;

use crate::indexer::{Indexer, INCLUDE_EXTENSIONS, MAX_FILE_SIZE};

/// Tracked state for a single file
#[derive(Debug, Clone)]
pub struct FileRecord {
    pub mtime: SystemTime,
    pub size: u64,
    pub vector_ids: Vec<usize>,
}

/// Manifest of all indexed files and their metadata
#[derive(Debug, Default)]
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

    /// Build initial manifest from the current index metadata.
    /// This scans the filesystem to populate mtime/size for files already in the index.
    pub fn from_existing_index(magento_root: &Path, indexer: &Indexer) -> Self {
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

        let _ = indexer; // used conceptually for the magento_root
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
        let idx = indexer.lock().unwrap();
        FileManifest::from_existing_index(&magento_root, &idx)
    };

    {
        let mut s = status.lock().unwrap();
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

        // Acquire indexer lock for the update
        let mut idx = indexer.lock().unwrap();

        // 1. Tombstone modified and deleted files
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

        // 2. Index added and modified files
        let files_to_index: Vec<PathBuf> = changes
            .added
            .iter()
            .chain(changes.modified.iter())
            .cloned()
            .collect();

        if !files_to_index.is_empty() {
            match idx.index_files(&files_to_index) {
                Ok(indexed) => {
                    manifest.apply_indexed(&magento_root, &indexed);
                    tracing::info!("Indexed {} files ({} entries)", files_to_index.len(), indexed.len());
                }
                Err(e) => {
                    tracing::error!("Incremental index error: {}", e);
                }
            }
        }

        // 3. Update manifest for deleted files
        manifest.apply_deleted(&changes.deleted);

        // 4. Compact if tombstone ratio is high
        if idx.vectordb_tombstone_ratio() > COMPACT_THRESHOLD {
            tracing::info!("Compacting vector DB (tombstone ratio > {}%)", (COMPACT_THRESHOLD * 100.0) as u32);
            idx.compact_vectordb();
        }

        // 5. Save to disk
        if let Err(e) = idx.save(&db_path) {
            tracing::error!("Failed to save index after watcher update: {}", e);
        }

        // 6. Update status
        {
            let mut s = status.lock().unwrap();
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
}
