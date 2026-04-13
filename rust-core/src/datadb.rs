//! Unified SQLite database for Magector serve process.
//!
//! Provides a single `data.db` file (in `.magector/`) that consolidates:
//! - LLM descriptions (previously `sqlite.db`)
//! - Method-chain enrichment (previously `enrichment.db`)
//! - Process state (previously `serve.pid`, `reindex.pid`)
//! - Cache state (previously `format-ok.json`, `version-check.json`)
//!
//! Task 5 will migrate callers from `describe::DescriptionDb` to `DataDb`.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OpenFlags};
use serde_json;
use std::collections::HashMap;
use std::path::Path;

/// Unified SQLite database wrapping a single connection to `.magector/data.db`.
pub struct DataDb {
    conn: Connection,
}

impl DataDb {
    /// Open (or create) the unified database. Enables WAL mode and creates all
    /// tables + indexes if they don't exist yet.
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)
            .with_context(|| format!("Failed to open DataDb at {:?}", path))?;

        conn.execute_batch("PRAGMA journal_mode = WAL;")
            .context("Failed to set WAL journal mode")?;

        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS llm_descriptions (
                path TEXT PRIMARY KEY,
                hash TEXT NOT NULL,
                description TEXT NOT NULL,
                model TEXT NOT NULL,
                timestamp INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS enrichment_method_chains (
                file TEXT NOT NULL,
                line INTEGER NOT NULL,
                chain TEXT NOT NULL,
                first_method TEXT NOT NULL,
                second_method TEXT NOT NULL,
                has_null_guard INTEGER NOT NULL DEFAULT 0,
                indexed_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_enrichment_first
                ON enrichment_method_chains(first_method);

            CREATE TABLE IF NOT EXISTS state_processes (
                name TEXT PRIMARY KEY,
                pid INTEGER NOT NULL,
                version TEXT,
                started_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS state_cache (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            ",
        )
        .context("Failed to create DataDb tables")?;

        Ok(Self { conn })
    }

    /// Open read-only (for query-only callers).
    pub fn open_readonly(path: &Path) -> Result<Self> {
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .with_context(|| format!("Failed to open DataDb read-only at {:?}", path))?;
        Ok(Self { conn })
    }

    // ─── LLM Descriptions ──────────────────────────────────────────

    /// Get a single LLM description by path.
    /// Returns `(hash, description, model, timestamp)`.
    pub fn desc_get(&self, path: &str) -> Option<(String, String, String, u64)> {
        self.conn
            .query_row(
                "SELECT hash, description, model, timestamp FROM llm_descriptions WHERE path = ?1",
                params![path],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)? as u64,
                    ))
                },
            )
            .ok()
    }

    /// Insert or replace an LLM description.
    pub fn desc_upsert(
        &self,
        path: &str,
        hash: &str,
        description: &str,
        model: &str,
        ts: u64,
    ) -> Result<()> {
        self.conn
            .execute(
                "INSERT OR REPLACE INTO llm_descriptions (path, hash, description, model, timestamp)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![path, hash, description, model, ts as i64],
            )
            .context("Failed to upsert LLM description")?;
        Ok(())
    }

    /// Load all descriptions as a map of `path -> { hash, description, model, timestamp }`.
    pub fn desc_all(&self) -> Result<HashMap<String, serde_json::Value>> {
        let mut stmt = self.conn.prepare(
            "SELECT path, hash, description, model, timestamp FROM llm_descriptions",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?;

        let mut map = HashMap::new();
        for row in rows {
            let (path, hash, description, model, ts) = row?;
            map.insert(
                path,
                serde_json::json!({
                    "hash": hash,
                    "description": description,
                    "model": model,
                    "timestamp": ts,
                }),
            );
        }
        Ok(map)
    }

    // ─── Enrichment (method chains) ────────────────────────────────

    /// Delete all enrichment rows.
    pub fn enrich_clear(&self) -> Result<()> {
        self.conn
            .execute("DELETE FROM enrichment_method_chains", [])
            .context("Failed to clear enrichment table")?;
        Ok(())
    }

    /// Delete enrichment rows for a single file.
    pub fn enrich_delete_file(&self, file: &str) -> Result<()> {
        self.conn
            .execute(
                "DELETE FROM enrichment_method_chains WHERE file = ?1",
                params![file],
            )
            .context("Failed to delete enrichment rows for file")?;
        Ok(())
    }

    /// Insert a single enrichment row.
    pub fn enrich_insert(
        &self,
        file: &str,
        line: i64,
        chain: &str,
        first: &str,
        second: &str,
        has_guard: bool,
        ts: i64,
    ) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO enrichment_method_chains
                 (file, line, chain, first_method, second_method, has_null_guard, indexed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![file, line, chain, first, second, has_guard as i32, ts],
            )
            .context("Failed to insert enrichment row")?;
        Ok(())
    }

    /// Query enrichment rows that are null-risk (no null guard).
    /// Optionally filter by `first_method`. Returns up to `limit` rows.
    /// Each row: `(file, line, chain, first_method, second_method)`.
    pub fn enrich_query_null_risks(
        &self,
        first_method: Option<&str>,
        limit: usize,
    ) -> Result<Vec<(String, i64, String, String, String)>> {
        let mut results = Vec::new();

        match first_method {
            Some(fm) => {
                let mut stmt = self.conn.prepare(
                    "SELECT file, line, chain, first_method, second_method
                     FROM enrichment_method_chains
                     WHERE has_null_guard = 0 AND first_method = ?1
                     LIMIT ?2",
                )?;
                let rows = stmt.query_map(params![fm, limit as i64], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                })?;
                for row in rows {
                    results.push(row?);
                }
            }
            None => {
                let mut stmt = self.conn.prepare(
                    "SELECT file, line, chain, first_method, second_method
                     FROM enrichment_method_chains
                     WHERE has_null_guard = 0
                     LIMIT ?1",
                )?;
                let rows = stmt.query_map(params![limit as i64], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                })?;
                for row in rows {
                    results.push(row?);
                }
            }
        }

        Ok(results)
    }

    // ─── Transactions ──────────────────────────────────────────────

    /// Begin a transaction.
    pub fn begin(&self) -> Result<()> {
        self.conn
            .execute_batch("BEGIN")
            .context("Failed to begin transaction")?;
        Ok(())
    }

    /// Commit the current transaction.
    pub fn commit(&self) -> Result<()> {
        self.conn
            .execute_batch("COMMIT")
            .context("Failed to commit transaction")?;
        Ok(())
    }

    /// Rollback the current transaction.
    pub fn rollback(&self) -> Result<()> {
        self.conn
            .execute_batch("ROLLBACK")
            .context("Failed to rollback transaction")?;
        Ok(())
    }

    // ─── Process state ─────────────────────────────────────────────

    /// Set (upsert) a process entry.
    pub fn process_set(&self, name: &str, pid: u32, version: Option<&str>, ts: i64) -> Result<()> {
        self.conn
            .execute(
                "INSERT OR REPLACE INTO state_processes (name, pid, version, started_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![name, pid, version, ts],
            )
            .context("Failed to set process state")?;
        Ok(())
    }

    /// Get a process entry. Returns `(pid, version, started_at)`.
    pub fn process_get(&self, name: &str) -> Option<(u32, Option<String>, i64)> {
        self.conn
            .query_row(
                "SELECT pid, version, started_at FROM state_processes WHERE name = ?1",
                params![name],
                |row| {
                    Ok((
                        row.get::<_, u32>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .ok()
    }

    /// Remove a process entry.
    pub fn process_remove(&self, name: &str) -> Result<()> {
        self.conn
            .execute(
                "DELETE FROM state_processes WHERE name = ?1",
                params![name],
            )
            .context("Failed to remove process state")?;
        Ok(())
    }

    // ─── Cache state ───────────────────────────────────────────────

    /// Set (upsert) a cache entry.
    pub fn cache_set(&self, key: &str, value: &str, ts: i64) -> Result<()> {
        self.conn
            .execute(
                "INSERT OR REPLACE INTO state_cache (key, value, updated_at)
                 VALUES (?1, ?2, ?3)",
                params![key, value, ts],
            )
            .context("Failed to set cache entry")?;
        Ok(())
    }

    /// Get a cache entry. Returns `(value, updated_at)`.
    pub fn cache_get(&self, key: &str) -> Option<(String, i64)> {
        self.conn
            .query_row(
                "SELECT value, updated_at FROM state_cache WHERE key = ?1",
                params![key],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                    ))
                },
            )
            .ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_open_creates_tables_and_desc_roundtrip() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("data.db");

        let db = DataDb::open(&db_path).unwrap();

        // Upsert + get roundtrip
        db.desc_upsert("vendor/module/etc/di.xml", "abc123", "Configures plugins", "claude-sonnet-4-5", 1700000000)
            .unwrap();

        let (hash, desc, model, ts) = db.desc_get("vendor/module/etc/di.xml").unwrap();
        assert_eq!(hash, "abc123");
        assert_eq!(desc, "Configures plugins");
        assert_eq!(model, "claude-sonnet-4-5");
        assert_eq!(ts, 1700000000);

        // Upsert overwrites
        db.desc_upsert("vendor/module/etc/di.xml", "def456", "Updated desc", "claude-sonnet-4-5", 1700000001)
            .unwrap();
        let (hash, desc, _, _) = db.desc_get("vendor/module/etc/di.xml").unwrap();
        assert_eq!(hash, "def456");
        assert_eq!(desc, "Updated desc");

        // Missing key returns None
        assert!(db.desc_get("nonexistent").is_none());

        // desc_all returns all entries
        db.desc_upsert("other/di.xml", "ghi789", "Other desc", "claude-sonnet-4-5", 1700000002)
            .unwrap();
        let all = db.desc_all().unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.contains_key("vendor/module/etc/di.xml"));
        assert!(all.contains_key("other/di.xml"));
    }

    #[test]
    fn test_enrich_insert_and_query_null_risks() {
        let dir = tempdir().unwrap();
        let db = DataDb::open(&dir.path().join("data.db")).unwrap();

        // Insert rows: one with guard, two without
        db.enrich_insert("src/Model/Order.php", 42, "$order->getPayment()->getMethod()", "getPayment", "getMethod", false, 100)
            .unwrap();
        db.enrich_insert("src/Model/Order.php", 55, "$order->getShipping()->getAddress()", "getShipping", "getAddress", true, 100)
            .unwrap();
        db.enrich_insert("src/Model/Cart.php", 10, "$cart->getItems()->count()", "getItems", "count", false, 100)
            .unwrap();

        // Query all null risks (no filter)
        let risks = db.enrich_query_null_risks(None, 100).unwrap();
        assert_eq!(risks.len(), 2); // only rows without null guard

        // Query filtered by first_method
        let risks = db.enrich_query_null_risks(Some("getPayment"), 100).unwrap();
        assert_eq!(risks.len(), 1);
        assert_eq!(risks[0].0, "src/Model/Order.php");
        assert_eq!(risks[0].1, 42);
        assert_eq!(risks[0].3, "getPayment");
        assert_eq!(risks[0].4, "getMethod");

        // Query with limit
        let risks = db.enrich_query_null_risks(None, 1).unwrap();
        assert_eq!(risks.len(), 1);
    }

    #[test]
    fn test_process_lifecycle() {
        let dir = tempdir().unwrap();
        let db = DataDb::open(&dir.path().join("data.db")).unwrap();

        // Initially missing
        assert!(db.process_get("serve").is_none());

        // Set
        db.process_set("serve", 12345, Some("1.7.3"), 1700000000).unwrap();
        let (pid, version, ts) = db.process_get("serve").unwrap();
        assert_eq!(pid, 12345);
        assert_eq!(version.as_deref(), Some("1.7.3"));
        assert_eq!(ts, 1700000000);

        // Set without version
        db.process_set("reindex", 67890, None, 1700000001).unwrap();
        let (pid, version, _) = db.process_get("reindex").unwrap();
        assert_eq!(pid, 67890);
        assert!(version.is_none());

        // Remove
        db.process_remove("serve").unwrap();
        assert!(db.process_get("serve").is_none());

        // Other entry still exists
        assert!(db.process_get("reindex").is_some());
    }

    #[test]
    fn test_cache_roundtrip() {
        let dir = tempdir().unwrap();
        let db = DataDb::open(&dir.path().join("data.db")).unwrap();

        // Missing key
        assert!(db.cache_get("format-ok").is_none());

        // Set + get
        db.cache_set("format-ok", r#"{"version":"1.7.3"}"#, 1700000000).unwrap();
        let (value, ts) = db.cache_get("format-ok").unwrap();
        assert_eq!(value, r#"{"version":"1.7.3"}"#);
        assert_eq!(ts, 1700000000);

        // Upsert overwrites
        db.cache_set("format-ok", r#"{"version":"1.8.0"}"#, 1700000001).unwrap();
        let (value, ts) = db.cache_get("format-ok").unwrap();
        assert_eq!(value, r#"{"version":"1.8.0"}"#);
        assert_eq!(ts, 1700000001);
    }

    #[test]
    fn test_enrich_clear() {
        let dir = tempdir().unwrap();
        let db = DataDb::open(&dir.path().join("data.db")).unwrap();

        db.enrich_insert("a.php", 1, "chain1", "foo", "bar", false, 100).unwrap();
        db.enrich_insert("b.php", 2, "chain2", "baz", "qux", false, 100).unwrap();

        let risks = db.enrich_query_null_risks(None, 100).unwrap();
        assert_eq!(risks.len(), 2);

        db.enrich_clear().unwrap();

        let risks = db.enrich_query_null_risks(None, 100).unwrap();
        assert_eq!(risks.len(), 0);
    }

    #[test]
    fn test_enrich_delete_file() {
        let dir = tempdir().unwrap();
        let db = DataDb::open(&dir.path().join("data.db")).unwrap();

        db.enrich_insert("a.php", 1, "chain1", "foo", "bar", false, 100).unwrap();
        db.enrich_insert("a.php", 5, "chain2", "foo", "baz", false, 100).unwrap();
        db.enrich_insert("b.php", 2, "chain3", "qux", "quux", false, 100).unwrap();

        db.enrich_delete_file("a.php").unwrap();

        let risks = db.enrich_query_null_risks(None, 100).unwrap();
        assert_eq!(risks.len(), 1);
        assert_eq!(risks[0].0, "b.php");
    }

    #[test]
    fn test_open_readonly() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("data.db");

        // Create and populate
        {
            let db = DataDb::open(&db_path).unwrap();
            db.desc_upsert("test.xml", "hash1", "desc1", "model1", 100).unwrap();
        }

        // Open read-only and query
        let db = DataDb::open_readonly(&db_path).unwrap();
        let (hash, desc, _, _) = db.desc_get("test.xml").unwrap();
        assert_eq!(hash, "hash1");
        assert_eq!(desc, "desc1");
    }

    #[test]
    fn test_transaction_commit() {
        let dir = tempdir().unwrap();
        let db = DataDb::open(&dir.path().join("data.db")).unwrap();

        db.begin().unwrap();
        db.enrich_insert("a.php", 1, "chain", "foo", "bar", false, 100).unwrap();
        db.enrich_insert("b.php", 2, "chain", "baz", "qux", false, 100).unwrap();
        db.commit().unwrap();

        let risks = db.enrich_query_null_risks(None, 100).unwrap();
        assert_eq!(risks.len(), 2);
    }

    #[test]
    fn test_transaction_rollback() {
        let dir = tempdir().unwrap();
        let db = DataDb::open(&dir.path().join("data.db")).unwrap();

        db.begin().unwrap();
        db.enrich_insert("a.php", 1, "chain", "foo", "bar", false, 100).unwrap();
        db.rollback().unwrap();

        let risks = db.enrich_query_null_risks(None, 100).unwrap();
        assert_eq!(risks.len(), 0);
    }
}
