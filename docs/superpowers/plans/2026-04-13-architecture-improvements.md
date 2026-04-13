# Magector Architecture Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate Magector's storage (3 SQLite → 1), replace external tool dependencies (semgrep → tree-sitter, GNU grep → Rust grep-searcher), upgrade embedding model (MiniLM → bge-small), and modernize serialization (bincode 2.0, ureq).

**Architecture:** Three phases — (1) Rust internals with no JS interface changes, (2) storage consolidation requiring both Rust + JS changes, (3) tool replacements that alter MCP tool behavior. Each phase produces a testable, releasable increment.

**Tech Stack:** Rust (ort, hnsw_rs, tree-sitter, grep-searcher, rusqlite, bincode 2, ureq), Node.js (MCP SDK), SQLite (WAL mode).

**Spec:** `docs/superpowers/specs/2026-04-13-architecture-improvements-design.md`

---

## Phase 1 — Rust Internals (no JS interface changes)

### Task 1: bincode 1.3 → 2.0

**Files:**
- Modify: `rust-core/Cargo.toml` (dependency version)
- Modify: `rust-core/src/vectordb.rs` (serialize/deserialize calls + Encode/Decode derives)
- Modify: `rust-core/src/sona.rs` (serialize/deserialize calls)
- Modify: `rust-core/src/watcher.rs` (serialize/deserialize calls)

**Context:** bincode 2.0 changes the API from `bincode::serialize`/`bincode::deserialize` to `bincode::encode_to_vec`/`bincode::decode_from_slice` with an explicit `Configuration`. Structs need `#[derive(Encode, Decode)]` instead of (or in addition to) `#[derive(Serialize, Deserialize)]`. The binary format itself changes, so old index.db files will be incompatible → existing format-check logic handles this (triggers re-index).

- [ ] **Step 1: Update Cargo.toml**

Change `bincode = "1.3"` to `bincode = "2"` in `rust-core/Cargo.toml`. Add the `serde` feature to keep `Serialize`/`Deserialize` compat for non-bincode uses:

```toml
bincode = { version = "2", features = ["serde"] }
```

- [ ] **Step 2: Update vectordb.rs serialization**

In `rust-core/src/vectordb.rs`, replace all `bincode::serialize_into` and `bincode::deserialize` calls with bincode 2 API. Key changes:

Replace:
```rust
bincode::serialize_into(writer, &state)
```
With:
```rust
bincode::serde::encode_into_std_write(&state, &mut writer, bincode::config::standard())
```

Replace:
```rust
bincode::deserialize::<PersistedStateV2>(&bytes[1..])
```
With:
```rust
bincode::serde::decode_from_slice::<PersistedStateV2, _>(&bytes[1..], bincode::config::standard()).map(|(state, _)| state)
```

Apply to all 4 call sites in `load()`, `check_format()`, `save()`, `save_atomic()`.

**Important:** Bump `PERSIST_VERSION_V2` constant by 1 (e.g., from `2` to `3`) so old bincode 1.x files trigger format-mismatch detection and re-index.

- [ ] **Step 3: Update sona.rs serialization**

In `rust-core/src/sona.rs`, replace 3 bincode call sites (lines ~328, ~337, ~352) with the same `bincode::serde::encode_to_vec` / `bincode::serde::decode_from_slice` pattern. The sona state file (`.sona`) will also become incompatible — the code already handles this gracefully (returns empty state on deserialization failure).

- [ ] **Step 4: Update watcher.rs serialization**

In `rust-core/src/watcher.rs`, replace the 2 bincode call sites (lines ~59, ~64) with bincode 2 API.

- [ ] **Step 5: Build and test**

```bash
cd /srv/magector/rust-core && cargo build 2>&1
cargo test 2>&1
```

Expected: builds clean, all Rust tests pass. Old index files will trigger re-index on next MCP server start (expected behavior).

- [ ] **Step 6: Commit**

```bash
cd /srv/magector && git add rust-core/Cargo.toml rust-core/src/vectordb.rs rust-core/src/sona.rs rust-core/src/watcher.rs
git commit -m "refactor: upgrade bincode 1.3 → 2.0

Uses bincode::serde::encode/decode with config::standard().
Bumps persist version → old indexes trigger auto re-index.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: reqwest → ureq

**Files:**
- Modify: `rust-core/Cargo.toml` (swap dependency)
- Modify: `rust-core/src/embedder.rs` (download_model function)

**Context:** `reqwest` is used only in `embedder.rs::download_model()` for two HTTP GETs (model + tokenizer). `ureq` is a synchronous HTTP client with no async runtime dependency (~150 KB vs ~1 MB).

- [ ] **Step 1: Update Cargo.toml**

Remove reqwest, add ureq:

Replace:
```toml
reqwest = { version = "0.12", default-features = false, features = ["blocking", "rustls-tls", "json"] }
```
With:
```toml
ureq = { version = "3", features = ["tls"] }
```

- [ ] **Step 2: Update download_model() in embedder.rs**

Replace the `reqwest::blocking::get` calls with `ureq::get`. In `rust-core/src/embedder.rs`, the `download_model` function (line ~90):

Replace:
```rust
let model_bytes = reqwest::blocking::get(model_url)
    .context("Failed to download model")?
    .bytes()
    .context("Failed to read model bytes")?;
```
With:
```rust
let model_resp = ureq::get(model_url).call()
    .map_err(|e| anyhow::anyhow!("Failed to download model: {}", e))?;
let mut model_bytes = Vec::new();
model_resp.into_body().into_reader()
    .read_to_end(&mut model_bytes)
    .context("Failed to read model bytes")?;
```

Add `use std::io::Read;` to the function scope (or top of file). Apply the same pattern to the tokenizer download below it.

- [ ] **Step 3: Remove any remaining reqwest imports**

Search for `use reqwest` or `reqwest::` anywhere in `rust-core/src/` and remove.

- [ ] **Step 4: Build and test**

```bash
cd /srv/magector/rust-core && cargo build 2>&1
cargo test 2>&1
```

- [ ] **Step 5: Commit**

```bash
cd /srv/magector && git add rust-core/Cargo.toml rust-core/src/embedder.rs
git commit -m "refactor: replace reqwest with ureq for model download

Synchronous HTTP client, no async runtime needed. ~850 KB smaller binary.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Embedding model upgrade (MiniLM → bge-small-en-v1.5)

**Files:**
- Modify: `rust-core/src/embedder.rs` (URLs, model filename, comments)

**Context:** bge-small-en-v1.5 is a drop-in replacement: same 384 dimensions, same ONNX format, better MTEB score (62.2 vs 58). `EMBEDDING_DIM` stays 384, no HNSW structural change. The tokenizer is different (bge uses its own), but the `tokenizers` crate handles both.

- [ ] **Step 1: Update model URLs and filenames**

In `rust-core/src/embedder.rs`, update `download_model()`:

Replace:
```rust
let model_url = "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx";
let tokenizer_url = "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/tokenizer.json";
```
With:
```rust
let model_url = "https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/main/onnx/model.onnx";
let tokenizer_url = "https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/main/tokenizer.json";
```

Update model filename:
```rust
let model_path = cache_dir.join("bge-small-en-v1.5.onnx");
```

- [ ] **Step 2: Update module doc comment and any references**

Replace `all-MiniLM-L6-v2` with `bge-small-en-v1.5` in the module doc comment (line 3), the `EMBEDDING_DIM` comment (line 13), and any other reference in the file.

- [ ] **Step 3: Update `from_cache()` to handle old model filename**

The `from_cache()` method (line ~75) looks for `all-MiniLM-L6-v2.onnx`. Update to look for `bge-small-en-v1.5.onnx`. Old model files in cache will simply trigger a re-download.

- [ ] **Step 4: Build and test**

```bash
cd /srv/magector/rust-core && cargo build 2>&1
cargo test 2>&1
```

Note: Full testing requires an actual model download. On CI, the model may already be cached. Verify embedding output is still [1, 384] shape.

- [ ] **Step 5: Commit**

```bash
cd /srv/magector && git add rust-core/src/embedder.rs
git commit -m "feat: upgrade embedding model to bge-small-en-v1.5

+4 MTEB points (58 → 62.2), same 384 dimensions (drop-in).
Old model cache ignored, new model downloaded on first use.
Existing indexes require re-indexing (different embeddings).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — Storage Consolidation

### Task 4: Unified SQLite database in Rust

**Files:**
- Create: `rust-core/src/datadb.rs` (new module — unified SQLite access)
- Modify: `rust-core/src/lib.rs` (add `pub mod datadb`)
- Modify: `rust-core/src/describe.rs` (use datadb instead of own Connection)
- Modify: `rust-core/src/main.rs` (open datadb on startup, pass to handlers)

**Context:** Create a new `datadb.rs` module that owns a single SQLite connection to `.magector/data.db`. It provides tables for: LLM descriptions (currently in `sqlite.db`), method-chain enrichment (currently in `enrichment.db` via Node.js), and process/cache state (currently in PID/JSON files). The HNSW binary data stays in `index.db` (bincode, not SQL).

- [ ] **Step 1: Create rust-core/src/datadb.rs with schema**

```rust
//! Unified SQLite database for all Magector metadata.
//!
//! Single `.magector/data.db` file replaces:
//! - `.magector/sqlite.db` (LLM descriptions)
//! - `.magector/enrichment.db` (method-chain null-risk)
//! - `.magector/serve.pid`, `reindex.pid`, `format-ok.json`, `version-check.json`

use anyhow::{Context, Result};
use rusqlite::{Connection, OpenFlags, params};
use std::path::Path;
use std::collections::HashMap;

pub struct DataDb {
    conn: Connection,
}

impl DataDb {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)
            .with_context(|| format!("Failed to open data.db at {:?}", path))?;
        conn.execute_batch("PRAGMA journal_mode = WAL;")?;
        let db = Self { conn };
        db.migrate()?;
        Ok(db)
    }

    pub fn open_readonly(path: &Path) -> Result<Self> {
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .with_context(|| format!("Failed to open data.db read-only at {:?}", path))?;
        Ok(Self { conn })
    }

    fn migrate(&self) -> Result<()> {
        self.conn.execute_batch("
            CREATE TABLE IF NOT EXISTS llm_descriptions (
                path        TEXT PRIMARY KEY,
                hash        TEXT NOT NULL,
                description TEXT NOT NULL,
                model       TEXT NOT NULL,
                timestamp   INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS enrichment_method_chains (
                file          TEXT NOT NULL,
                line          INTEGER NOT NULL,
                chain         TEXT NOT NULL,
                first_method  TEXT NOT NULL,
                second_method TEXT NOT NULL,
                has_null_guard INTEGER NOT NULL DEFAULT 0,
                indexed_at    INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_enrichment_first
                ON enrichment_method_chains(first_method);
            CREATE TABLE IF NOT EXISTS state_processes (
                name       TEXT PRIMARY KEY,
                pid        INTEGER NOT NULL,
                version    TEXT,
                started_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS state_cache (
                key        TEXT PRIMARY KEY,
                value      TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
        ")?;
        Ok(())
    }

    // ── LLM Descriptions ─────────────────────────────────────

    pub fn desc_get(&self, path: &str) -> Option<(String, String, String, u64)> {
        self.conn.query_row(
            "SELECT hash, description, model, timestamp FROM llm_descriptions WHERE path = ?1",
            params![path],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get::<_, i64>(3)? as u64)),
        ).ok()
    }

    pub fn desc_upsert(&self, path: &str, hash: &str, description: &str, model: &str, ts: u64) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO llm_descriptions (path, hash, description, model, timestamp) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![path, hash, description, model, ts as i64],
        )?;
        Ok(())
    }

    pub fn desc_all(&self) -> Result<HashMap<String, serde_json::Value>> {
        let mut stmt = self.conn.prepare(
            "SELECT path, hash, description, model, timestamp FROM llm_descriptions"
        )?;
        let rows = stmt.query_map([], |row| {
            let path: String = row.get(0)?;
            let hash: String = row.get(1)?;
            let desc: String = row.get(2)?;
            let model: String = row.get(3)?;
            let ts: i64 = row.get(4)?;
            Ok((path, serde_json::json!({"hash": hash, "description": desc, "model": model, "timestamp": ts})))
        })?;
        let mut map = HashMap::new();
        for row in rows {
            let (path, val) = row?;
            map.insert(path, val);
        }
        Ok(map)
    }

    // ── Enrichment Method Chains ─────────────────────────────

    pub fn enrich_clear(&self) -> Result<()> {
        self.conn.execute("DELETE FROM enrichment_method_chains", [])?;
        Ok(())
    }

    pub fn enrich_delete_file(&self, file: &str) -> Result<()> {
        self.conn.execute("DELETE FROM enrichment_method_chains WHERE file = ?", params![file])?;
        Ok(())
    }

    pub fn enrich_insert(&self, file: &str, line: i64, chain: &str, first: &str, second: &str, has_guard: bool, ts: i64) -> Result<()> {
        self.conn.execute(
            "INSERT INTO enrichment_method_chains (file, line, chain, first_method, second_method, has_null_guard, indexed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![file, line, chain, first, second, has_guard as i64, ts],
        )?;
        Ok(())
    }

    pub fn enrich_query_null_risks(&self, first_method: Option<&str>, limit: usize) -> Result<Vec<(String, i64, String, String, String)>> {
        let rows = if let Some(fm) = first_method {
            let mut stmt = self.conn.prepare(
                "SELECT file, line, chain, first_method, second_method FROM enrichment_method_chains WHERE has_null_guard = 0 AND first_method = ? ORDER BY file, line LIMIT ?"
            )?;
            stmt.query_map(params![fm, limit as i64], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
            })?.collect::<Result<Vec<_>, _>>()?
        } else {
            let mut stmt = self.conn.prepare(
                "SELECT file, line, chain, first_method, second_method FROM enrichment_method_chains WHERE has_null_guard = 0 ORDER BY first_method, file, line LIMIT ?"
            )?;
            stmt.query_map(params![limit as i64], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
            })?.collect::<Result<Vec<_>, _>>()?
        };
        Ok(rows)
    }

    pub fn begin(&self) -> Result<()> { self.conn.execute_batch("BEGIN")?; Ok(()) }
    pub fn commit(&self) -> Result<()> { self.conn.execute_batch("COMMIT")?; Ok(()) }
    pub fn rollback(&self) -> Result<()> { self.conn.execute_batch("ROLLBACK")?; Ok(()) }

    // ── State: Processes ─────────────────────────────────────

    pub fn process_set(&self, name: &str, pid: u32, version: Option<&str>, ts: i64) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO state_processes (name, pid, version, started_at) VALUES (?1, ?2, ?3, ?4)",
            params![name, pid, version, ts],
        )?;
        Ok(())
    }

    pub fn process_get(&self, name: &str) -> Option<(u32, Option<String>, i64)> {
        self.conn.query_row(
            "SELECT pid, version, started_at FROM state_processes WHERE name = ?1",
            params![name],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).ok()
    }

    pub fn process_remove(&self, name: &str) -> Result<()> {
        self.conn.execute("DELETE FROM state_processes WHERE name = ?1", params![name])?;
        Ok(())
    }

    // ── State: Cache ─────────────────────────────────────────

    pub fn cache_set(&self, key: &str, value: &str, ts: i64) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO state_cache (key, value, updated_at) VALUES (?1, ?2, ?3)",
            params![key, value, ts],
        )?;
        Ok(())
    }

    pub fn cache_get(&self, key: &str) -> Option<(String, i64)> {
        self.conn.query_row(
            "SELECT value, updated_at FROM state_cache WHERE key = ?1",
            params![key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).ok()
    }
}
```

- [ ] **Step 2: Register module in lib.rs**

Add `pub mod datadb;` to `rust-core/src/lib.rs`.

- [ ] **Step 3: Update describe.rs to use DataDb**

Replace `DescriptionDb` internal `Connection` with a reference to `DataDb` methods. The `describe_di_xml_files()` function should accept a `&DataDb` parameter instead of opening its own `Connection`. Callers in `main.rs` will pass the shared `DataDb` instance.

- [ ] **Step 4: Add DataDb to serve process startup in main.rs**

In `run_serve()`, open `DataDb` at `.magector/data.db` and pass `Arc<Mutex<DataDb>>` to `handle_serve_request`. Add new serve commands:
- `enrich_query {first_method, limit}` → calls `datadb.enrich_query_null_risks()`
- `enrich_insert_batch {rows}` → batch insert into enrichment table
- `descriptions` command uses `datadb.desc_all()` instead of `DescriptionDb::open_readonly()`

- [ ] **Step 5: Build and run Rust tests**

```bash
cd /srv/magector/rust-core && cargo build 2>&1
cargo test 2>&1
```

- [ ] **Step 6: Commit**

```bash
cd /srv/magector && git add rust-core/src/datadb.rs rust-core/src/lib.rs rust-core/src/describe.rs rust-core/src/main.rs
git commit -m "feat: unified SQLite database (data.db) in Rust

New datadb.rs module: llm_descriptions + enrichment_method_chains +
state_processes + state_cache tables in single data.db file.
Replaces separate sqlite.db, enrichment.db, and meta files.
New serve commands: enrich_query, enrich_insert_batch.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Move enrichment logic from Node.js to Rust

**Files:**
- Modify: `rust-core/src/main.rs` (new `enrich` serve command that scans PHP files)
- Modify: `src/mcp-server.js` (remove `enrichMethodChains()`, `queryNullRisks()`, `node:sqlite` usage; delegate to serve commands)

**Context:** Currently `enrichMethodChains()` in `mcp-server.js` (~120 lines) scans PHP files for `$this->X->Y()` chains using regex, then writes to `enrichment.db` via `node:sqlite`. Moving this to Rust eliminates the `node:sqlite` dependency (allows Node.js 18+) and puts all DB writes in one process.

- [ ] **Step 1: Implement `enrich` serve command in Rust main.rs**

Add a new match arm in `handle_serve_request`:

```rust
"enrich" => {
    let mg_root = req.get("magento_root").and_then(|v| v.as_str()).unwrap_or("");
    if mg_root.is_empty() {
        return r#"{"ok":false,"error":"Missing magento_root"}"#.to_string();
    }
    // Use the shared DataDb to scan PHP files and populate enrichment tables
    let data_db = data_db.lock().unwrap();
    match enrich_method_chains(&data_db, Path::new(mg_root)) {
        Ok((scanned, chains)) => format!(
            r#"{{"ok":true,"data":{{"scanned":{},"chains":{}}}}}"#,
            scanned, chains
        ),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
    }
}
```

Implement `enrich_method_chains(db: &DataDb, root: &Path) -> Result<(usize, usize)>` as a standalone function in `main.rs` (or a new `enrich.rs` module). The logic:
1. Glob `vendor/**/*.php` files under `root`
2. For each PHP file, regex-scan for `$this->X->Y()` method chain patterns (same regex as current JS: `\$this->(\w+)->(\w+)\s*\(`)
3. Check for null guards within ±6 lines (same `hasNullGuard` logic)
4. `data_db.begin()` → batch `data_db.enrich_insert()` → `data_db.commit()`
5. Return (files_scanned, chains_found)

- [ ] **Step 2: Update Node.js mcp-server.js**

Remove the `enrichMethodChains()` function (~lines 3496-3615) and `queryNullRisks()` function (~lines 3620-3656). Remove the `node:sqlite` import (`DatabaseSync`).

Replace `magento_enrich` handler to send `enrich` command to serve process:
```javascript
case 'magento_enrich': {
    const root = config.magentoRoot;
    if (!root) return { content: [{ type: 'text', text: 'MAGENTO_ROOT not set.' }], isError: true };
    let text = '## magento_enrich\n\nScanning vendor/ PHP files for method chains...\n';
    try {
        const resp = await serveQuery('enrich', { magento_root: root }, 120000);
        if (resp.ok) {
            text += `\n✅ **Done**\n- Files scanned: ${resp.data.scanned}\n- Method chains indexed: ${resp.data.chains}`;
        } else {
            text += `\n❌ Error: ${resp.error}`;
        }
    } catch (err) {
        text += `\n❌ Error: ${err.message}`;
    }
    return { content: [{ type: 'text', text }] };
}
```

Replace `magento_find_null_risks` handler similarly to query via `enrich_query` serve command.

- [ ] **Step 3: Remove node:sqlite from package.json prerequisites**

If `node:sqlite` is documented in README prerequisites, remove the Node.js 22.5+ requirement (revert to 18+).

- [ ] **Step 4: Run JS unit tests**

```bash
cd /srv/magector && node tests/unit.test.js
```

Update any tests that tested `enrichMethodChains` or `queryNullRisks` directly — they should now test via MCP tool calls (integration tests) or be removed if they tested internal JS functions.

- [ ] **Step 5: Commit**

```bash
cd /srv/magector && git add rust-core/src/main.rs src/mcp-server.js
git commit -m "refactor: move enrichment logic from Node.js to Rust serve

Eliminates node:sqlite dependency. Node.js 18+ sufficient again.
New 'enrich' and 'enrich_query' serve commands handle all DB writes.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Consolidate .magector/ meta files into state tables

**Files:**
- Modify: `src/mcp-server.js` (PID/lock file operations → serve commands)
- Modify: `src/update.js` (version-check.json → serve command or keep as file)

**Context:** Replace `serve.pid`, `reindex.pid`, `primary.lock`, `format-ok.json`, `version-check.json` with `state_processes` and `state_cache` tables in `data.db`. Keep `serve.sock` (Unix socket) and `magector.log` as files.

- [ ] **Step 1: Replace PID file read/write in mcp-server.js**

Find all `writePidFile`, `readPidFile`, `writeReindexPidFile` functions and replace with serve commands `process_set` / `process_get` / `process_remove`.

For cold-start (before serve process is ready), keep PID files as fallback — the serve process writes its own PID to `data.db` on startup. The Node.js MCP server reads from `data.db` via `serveQuery('process_get', {name: 'serve'})`.

- [ ] **Step 2: Replace format-ok.json and version-check.json**

Replace:
```javascript
writeFileSync(FORMAT_CACHE_PATH, JSON.stringify({version, timestamp}));
```
With serve command:
```javascript
await serveQuery('cache_set', { key: 'format_ok', value: JSON.stringify({version, timestamp}) });
```

For `version-check.json` in `update.js`: keep as a file (it runs before MCP server starts, no serve process available).

- [ ] **Step 3: Clean up old files on migration**

On startup, if old PID/JSON files exist alongside `data.db`, import them into state tables and delete the files.

- [ ] **Step 4: Update .magector/ layout documentation in README**

Expected layout after consolidation:
```
.magector/
├── data.db         # unified SQLite (descriptions, enrichment, state)
├── index.db        # HNSW vector index (bincode)
├── serve.sock      # Unix domain socket
└── magector.log    # diagnostic log
```

- [ ] **Step 5: Run full test suite**

```bash
cd /srv/magector && node tests/unit.test.js
```

- [ ] **Step 6: Commit**

```bash
cd /srv/magector && git add src/mcp-server.js src/update.js README.md
git commit -m "refactor: consolidate .magector/ meta files into data.db state tables

PID files, format cache, primary lock → state_processes/state_cache SQLite tables.
.magector/ now has 4 files: data.db, index.db, serve.sock, magector.log.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Migration logic for old → new layout

**Files:**
- Modify: `src/mcp-server.js` (startup migration)
- Modify: `rust-core/src/main.rs` (serve startup migration)

**Context:** Existing users have `sqlite.db`, `enrichment.db`, PID files. On first start with new version, detect old layout and migrate.

- [ ] **Step 1: Add migration in Rust serve startup**

In `run_serve()`, before opening `DataDb`, check for old files:
```rust
let data_db_path = magento_root.join(".magector/data.db");
let old_desc_db = magento_root.join(".magector/sqlite.db");
if old_desc_db.exists() && !data_db_path.exists() {
    // Open old sqlite.db, copy descriptions into new data.db
    migrate_old_descriptions(&old_desc_db, &data_db_path)?;
    fs::rename(&old_desc_db, old_desc_db.with_extension("db.migrated"))?;
}
```

- [ ] **Step 2: Add migration in Node.js startup**

In `mcp-server.js`, near the beginning, check for old `enrichment.db`:
```javascript
const oldEnrichPath = path.join(config.magentoRoot, '.magector', 'enrichment.db');
if (existsSync(oldEnrichPath)) {
    logToFile('INFO', 'Old enrichment.db found — will be migrated on next magento_enrich call');
    // Don't migrate data (it's regenerated by enrich command), just rename
    renameSync(oldEnrichPath, oldEnrichPath + '.migrated');
}
```

- [ ] **Step 3: Test migration path**

Create a test fixture with old-layout `.magector/` dir (sqlite.db + enrichment.db + serve.pid), run MCP server, verify:
- `data.db` created with correct schema
- Old descriptions migrated
- Old files renamed to `.migrated`
- MCP tools work normally

- [ ] **Step 4: Commit**

```bash
cd /srv/magector && git add rust-core/src/main.rs src/mcp-server.js
git commit -m "feat: auto-migration from old .magector/ layout to unified data.db

Detects sqlite.db/enrichment.db/PID files and migrates on startup.
Old files renamed to .migrated for safety.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3 — Tool Replacements

### Task 8: Tree-sitter query patterns in Rust

**Files:**
- Create: `rust-core/queries/dataobject-set-null.scm`
- Create: `rust-core/queries/unchecked-method-chain.scm`
- Modify: `rust-core/src/ast.rs` (add query execution functions)
- Modify: `rust-core/src/main.rs` (add `ast_query` serve command)

**Context:** Replace semgrep subprocess with tree-sitter S-expression queries. Each pattern is a `.scm` file. The Rust `ast.rs` module already has `PhpAstAnalyzer` with a tree-sitter parser — extend it with query execution.

- [ ] **Step 1: Create dataobject-set-null.scm**

```scheme
;; Detect $obj->setFoo(null) — DataObject anti-pattern
;; setX(null) stores ['x' => null] in _data, hasX() returns true via array_key_exists
(member_call_expression
  object: (_) @receiver
  name: (name) @method_name
  arguments: (arguments
    (argument
      (null))) @null_arg)
```

Save to `rust-core/queries/dataobject-set-null.scm`.

- [ ] **Step 2: Create unchecked-method-chain.scm**

```scheme
;; Detect $this->dep->method() — potential null dereference chain
(member_call_expression
  object: (member_access_expression
    object: (variable_name) @root
    name: (name) @property)
  name: (name) @method)
```

Save to `rust-core/queries/unchecked-method-chain.scm`.

- [ ] **Step 3: Add query execution to ast.rs**

Add to `PhpAstAnalyzer`:

```rust
use tree_sitter::{Query, QueryCursor};

pub struct AstQueryMatch {
    pub file: String,
    pub line: usize,
    pub end_line: usize,
    pub snippet: String,
}

impl PhpAstAnalyzer {
    /// Run a named tree-sitter query against a PHP file.
    pub fn run_query(&mut self, source: &str, query_source: &str) -> Result<Vec<AstQueryMatch>> {
        let tree = self.parser.parse(source, None)
            .ok_or_else(|| anyhow::anyhow!("Failed to parse PHP"))?;
        let lang = get_php_language();
        let query = Query::new(&lang, query_source)
            .map_err(|e| anyhow::anyhow!("Invalid tree-sitter query: {}", e))?;
        let mut cursor = QueryCursor::new();
        let matches = cursor.matches(&query, tree.root_node(), source.as_bytes());

        let mut results = Vec::new();
        for m in matches {
            if let Some(node) = m.captures.first().map(|c| c.node) {
                let start = node.start_position();
                let end = node.end_position();
                let snippet = source[node.byte_range()].to_string();
                results.push(AstQueryMatch {
                    file: String::new(), // caller fills this
                    line: start.row + 1,
                    end_line: end.row + 1,
                    snippet,
                });
            }
        }
        Ok(results)
    }
}
```

- [ ] **Step 4: Add `ast_query` serve command in main.rs**

```rust
"ast_query" => {
    let pattern_name = req.get("pattern").and_then(|v| v.as_str()).unwrap_or("");
    let search_path = req.get("path").and_then(|v| v.as_str()).unwrap_or(".");
    let limit = req.get("limit").and_then(|v| v.as_u64()).unwrap_or(50) as usize;

    // Load named query from embedded queries
    let query_source = match pattern_name {
        "dataobject-set-null" => include_str!("../queries/dataobject-set-null.scm"),
        "unchecked-method-chain" => include_str!("../queries/unchecked-method-chain.scm"),
        _ => return format!(r#"{{"ok":false,"error":"Unknown pattern: {}. Available: dataobject-set-null, unchecked-method-chain"}}"#, pattern_name),
    };

    // Scan PHP files under search_path
    let root = Path::new(magento_root);
    let target = root.join(search_path);
    // ... glob *.php, run query on each, collect results, return JSON
}
```

Post-filter for `dataobject-set-null`: filter results where the method name captured by `@method_name` matches `^set[A-Z]` (same as the current JS post-filter regex).

- [ ] **Step 5: Build and test**

```bash
cd /srv/magector/rust-core && cargo build 2>&1
cargo test 2>&1
```

Write a Rust test that runs `dataobject-set-null` query against a fixture PHP file containing both `$this->setFoo(null)` (should match) and `$this->setBar('value')` (should not).

- [ ] **Step 6: Commit**

```bash
cd /srv/magector && git add rust-core/queries/ rust-core/src/ast.rs rust-core/src/main.rs
git commit -m "feat: tree-sitter query patterns replacing semgrep

Named .scm queries executed in Rust. No external dependency.
Patterns: dataobject-set-null, unchecked-method-chain.
New ast_query serve command.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Update Node.js to use tree-sitter ast_query

**Files:**
- Modify: `src/mcp-server.js` (replace `astSearch()` function, update tool definitions)

**Context:** `astSearch()` currently spawns `semgrep` subprocess. Replace with serve command `ast_query`. Update `magento_ast_search` tool definition to accept pattern name (enum) instead of arbitrary semgrep pattern. Update `magento_find_dataobject_issues` to use the new backend.

- [ ] **Step 1: Replace astSearch() function**

Remove the old `astSearch()` function (~lines 3662-3737) and `.semgrepignore` handling. Replace with:

```javascript
async function astSearch(patternName, searchPath, maxResults) {
    const root = config.magentoRoot;
    if (!root) throw new Error('MAGENTO_ROOT not set');

    // Validate path
    const safeSp = searchPath ? safeRelPath(root, searchPath) : '.';
    if (!safeSp) throw new Error(`Path escapes project root: ${searchPath}`);

    const limit = Math.min(maxResults || 50, 200);
    logToFile('INFO', `ast_search: pattern="${patternName}" path="${safeSp}" limit=${limit}`);
    const start = Date.now();

    try {
        const resp = await serveQuery('ast_query', {
            pattern: patternName,
            path: safeSp,
            limit
        }, 60000);

        if (!resp.ok) throw new Error(resp.error || 'ast_query failed');

        const elapsed = Date.now() - start;
        logToFile('INFO', `ast_search: ${resp.data.length} match(es) in ${elapsed}ms`);
        return resp.data || [];
    } catch (err) {
        logToFile('ERR', `ast_search: ${err.message}`);
        throw err;
    }
}
```

- [ ] **Step 2: Update magento_ast_search tool definition**

Change the `pattern` input from free-text to enum:

```javascript
{
    name: 'magento_ast_search',
    description: 'Run a named AST pattern query against PHP files. Available patterns: dataobject-set-null (detect setX(null) anti-pattern), unchecked-method-chain (detect $this->dep->method() without null check).',
    inputSchema: {
        type: 'object',
        properties: {
            pattern: {
                type: 'string',
                enum: ['dataobject-set-null', 'unchecked-method-chain'],
                description: 'Named AST pattern to search for'
            },
            path: { type: 'string', description: 'Subdirectory (relative to MAGENTO_ROOT)' },
            maxResults: { type: 'number', default: 50 }
        },
        required: ['pattern']
    }
}
```

- [ ] **Step 3: Update magento_find_dataobject_issues**

Replace the old `findDataObjectIssues()` function to call `astSearch('dataobject-set-null', ...)` instead of spawning semgrep directly.

- [ ] **Step 4: Update tool count in README if changed**

Check `grep -c "name: 'magento_" src/mcp-server.js` — tool count should remain 46 (no tools added/removed).

- [ ] **Step 5: Run JS unit tests**

```bash
cd /srv/magector && node tests/unit.test.js
```

Update `testAstSearch` and `testFindDataObjectIssues` tests to use named patterns instead of semgrep patterns.

- [ ] **Step 6: Commit**

```bash
cd /srv/magector && git add src/mcp-server.js tests/unit.test.js
git commit -m "refactor: magento_ast_search uses tree-sitter queries via Rust serve

Removes semgrep dependency. Pattern arg is now an enum of named queries.
No more .semgrepignore creation in project root.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: grep-searcher in Rust serve process

**Files:**
- Modify: `rust-core/Cargo.toml` (add grep-searcher, grep-regex, grep-matcher deps)
- Modify: `rust-core/src/main.rs` (add `grep` serve command)

**Context:** Add a `grep` command to the Rust serve process that uses ripgrep internals (`grep-searcher` + `grep-regex` crates). The Node.js handler will send grep requests to Rust instead of spawning external `grep`.

- [ ] **Step 1: Add dependencies to Cargo.toml**

```toml
# Text search (ripgrep internals)
grep-regex = "0.1"
grep-searcher = "0.1"
grep-matcher = "0.1"
```

Note: Check latest versions on crates.io — these may be at different versions. The `grep-*` crates are part of the ripgrep project by BurntSushi.

- [ ] **Step 2: Implement grep serve command**

Add `grep` match arm in `handle_serve_request`:

```rust
"grep" => {
    let pattern = match req.get("pattern").and_then(|v| v.as_str()) {
        Some(p) => p,
        None => return r#"{"ok":false,"error":"Missing pattern"}"#.to_string(),
    };
    let search_path = req.get("path").and_then(|v| v.as_str()).unwrap_or(".");
    let include = req.get("include").and_then(|v| v.as_str()).unwrap_or("*.php");
    let context = req.get("context").and_then(|v| v.as_u64()).unwrap_or(4) as usize;
    let max_results = req.get("max_results").and_then(|v| v.as_u64()).unwrap_or(50) as usize;
    let files_only = req.get("files_only").and_then(|v| v.as_bool()).unwrap_or(false);
    let ignore_case = req.get("ignore_case").and_then(|v| v.as_bool()).unwrap_or(false);

    let root = Path::new(magento_root);
    let target = root.join(search_path);

    match run_grep(&target, pattern, include, context, max_results, files_only, ignore_case) {
        Ok(results) => {
            match serde_json::to_string(&results) {
                Ok(json) => format!(r#"{{"ok":true,"data":{}}}"#, json),
                Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
            }
        }
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
    }
}
```

Implement `run_grep()`:

```rust
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{Searcher, SearcherBuilder, Sink, SinkMatch, SinkContext, SinkContextKind};
use std::path::PathBuf;

#[derive(serde::Serialize)]
struct GrepMatch {
    file: String,
    line: usize,
    text: String,
    is_context: bool,
}

fn run_grep(
    target: &Path,
    pattern: &str,
    include: &str,
    context: usize,
    max_results: usize,
    files_only: bool,
    ignore_case: bool,
) -> Result<Vec<GrepMatch>> {
    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(ignore_case)
        .build(pattern)
        .map_err(|e| anyhow::anyhow!("Invalid regex: {}", e))?;

    let mut searcher = SearcherBuilder::new()
        .after_context(context)
        .before_context(context)
        .build();

    let include_patterns: Vec<String> = expand_include(include);
    let mut results = Vec::new();
    let mut matched_files = std::collections::HashSet::new();

    // Walk directory, filter by include patterns
    for entry in walkdir::WalkDir::new(target).into_iter().filter_map(|e| e.ok()) {
        if results.len() >= max_results { break; }
        if !entry.file_type().is_file() { continue; }

        let path = entry.path();
        let fname = path.file_name().and_then(|f| f.to_str()).unwrap_or("");
        if !include_patterns.iter().any(|pat| glob_match(pat, fname)) { continue; }

        // ... search file with searcher + matcher, collect results
    }
    Ok(results)
}
```

- [ ] **Step 3: Build and test**

```bash
cd /srv/magector/rust-core && cargo build 2>&1
cargo test 2>&1
```

Write Rust test: create temp dir with test PHP files, run `run_grep` with known pattern, verify matches.

- [ ] **Step 4: Commit**

```bash
cd /srv/magector && git add rust-core/Cargo.toml rust-core/src/main.rs
git commit -m "feat: Rust grep-searcher serve command (ripgrep internals)

Cross-platform text search without GNU grep dependency.
New 'grep' serve command with include/context/filesOnly support.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Node.js grep handler uses Rust serve

**Files:**
- Modify: `src/mcp-server.js` (magento_grep handler + batch handler)

**Context:** Update `magento_grep` case handler to send queries to Rust serve process. Keep external GNU grep as fallback for cold-start (serve process not ready).

- [ ] **Step 1: Update standalone magento_grep handler**

Replace the `execFileSync('grep', ...)` call with:

```javascript
case 'magento_grep': {
    const root = config.magentoRoot;
    if (!root) return { content: [{ type: 'text', text: 'MAGENTO_ROOT not set.' }], isError: true };
    const searchPath = safeRelPath(root, args.path || '.');
    if (!searchPath) {
        logToFile('WARN', `grep: rejected path traversal: "${args.path}"`);
        return { content: [{ type: 'text', text: `Path escapes project root: ${args.path}` }], isError: true };
    }
    const include = args.include || '*.php';
    const maxResults = Math.min(args.maxResults || 50, 200);
    const ctxLines = args.context !== undefined ? args.context : 4;
    const filesOnly = args.filesOnly || false;
    const grepStart = Date.now();

    // Try Rust serve grep first, fall back to external grep
    const queryFn = globalServeQuery || ((serveProcess && serveReady) ? serveQuery : null);
    let lines;
    if (queryFn) {
        try {
            const resp = await queryFn('grep', {
                pattern: args.pattern, path: searchPath, include,
                context: ctxLines, max_results: maxResults,
                files_only: filesOnly, ignore_case: args.ignoreCase || false
            }, 30000);
            if (resp.ok) {
                // Format response from Rust JSON
                lines = resp.data || [];
            }
        } catch {
            // Fall through to external grep
        }
    }

    if (!lines) {
        // Fallback: external GNU grep (cold-start path)
        // ... existing execFileSync('grep', ...) code ...
    }

    // Format output (same as before)
    // ...
}
```

- [ ] **Step 2: Update batch grep handler similarly**

Apply the same serve-first-then-fallback pattern to the `magento_grep` case inside the `magento_batch` handler.

- [ ] **Step 3: Run tests**

```bash
cd /srv/magector && node tests/unit.test.js
```

The existing `testMagentoGrep` test should pass — it tests output format, not the internal implementation.

- [ ] **Step 4: Commit**

```bash
cd /srv/magector && git add src/mcp-server.js
git commit -m "refactor: magento_grep delegates to Rust serve (fallback to GNU grep)

Cross-platform grep via ripgrep internals. GNU grep only used during cold-start.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Final Phase — Release

### Task 12: Full test suite, CHANGELOG, README, release

**Files:**
- Modify: `tests/unit.test.js` (add/update tests for all changes)
- Modify: `CHANGELOG.md`
- Modify: `README.md` (prerequisites, components table, .magector/ layout)

- [ ] **Step 1: Add unit tests for all new functionality**

Tests to add/update in `tests/unit.test.js`:
- `testUnifiedDataDb`: verify enrichment query via serve command returns results
- `testAstSearchNamedPatterns`: verify `magento_ast_search` with `dataobject-set-null` returns matches
- `testGrepViaServe`: verify `magento_grep` returns results (with serve process running)
- Update existing tests that referenced `enrichment.db` or `node:sqlite`

- [ ] **Step 2: Run full test suite (0 failures)**

```bash
cd /srv/magector && node tests/unit.test.js
```

- [ ] **Step 3: Check for proprietary names**

```bash
grep -ri "drmax\|dr-max\|dr\.max" src/ tests/ --include="*.js" --include="*.rs" -l
```

- [ ] **Step 4: Update CHANGELOG.md**

Add `## [2.16.0]` section with:
- **Changed:** `bincode 1.3 → 2.0`, `reqwest → ureq`, `all-MiniLM-L6-v2 → bge-small-en-v1.5`, unified SQLite `data.db`, tree-sitter queries replacing semgrep, Rust grep-searcher replacing GNU grep subprocess, consolidated `.magector/` layout
- **Removed:** `node:sqlite` dependency (Node.js 18+ sufficient), semgrep dependency, external GNU grep requirement (kept as fallback)

- [ ] **Step 5: Update README.md**

- Prerequisites: remove Node.js 22.5+ requirement, remove semgrep
- Components table: update DB layout (data.db + index.db)
- .magector/ layout section: 4 files instead of 8+
- Tool count: verify `grep -c "name: 'magento_" src/mcp-server.js` matches README

- [ ] **Step 6: Commit, tag, push**

```bash
cd /srv/magector
git add -A
git commit -m "feat: Magector 2.16.0 — architecture improvements

- Unified SQLite (data.db replaces sqlite.db + enrichment.db)
- Tree-sitter queries replace semgrep (zero external dependency)
- Rust grep-searcher replaces GNU grep subprocess (cross-platform)
- bge-small-en-v1.5 embedding model (+4 MTEB)
- bincode 2.0, ureq replaces reqwest
- Consolidated .magector/ layout (4 files)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"

npm version minor
git push origin main --follow-tags
```

- [ ] **Step 7: Verify GitHub Actions release**

```bash
curl -s "https://api.github.com/repos/krejcif/magector/actions/runs?per_page=3" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); [print(f'{r[\"id\"]} {r[\"status\"]} {r[\"conclusion\"] or \"\"} {r[\"name\"]} {r[\"head_branch\"]}') for r in d.get('workflow_runs',[])]"
```

Wait for `completed success`, then:
```bash
npm view magector version
```
