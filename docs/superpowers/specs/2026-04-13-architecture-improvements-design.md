# Magector Architecture Improvements — Design Spec

**Date:** 2026-04-13
**Scope:** 7 changes (#1-4, #6, #8-9 from security audit architecture review)
**Skipped:** #5 (pure Rust MCP server — wait for rmcp 1.x), #7 (musl static — needs perf benchmarking)

---

## Changes Overview

| # | Change | Layer | Effort |
|---|---|---|---|
| 1 | 3 SQLite DBs → 1 unified `data.db` | Rust + JS | 1-2 days |
| 2 | semgrep → tree-sitter queries (option A) | Rust + JS | 1 day |
| 3 | GNU grep subprocess → `grep-searcher` Rust crate | Rust + JS | 2-3 days |
| 4 | MiniLM-L6-v2 → bge-small-en-v1.5 embedding model | Rust | 4 hours + re-index |
| 6 | bincode 1.3 → 2.0 | Rust | 1 hour |
| 8 | reqwest → ureq | Rust | 2 hours |
| 9 | Consolidate .magector/ meta files into state tables | Rust + JS | 1 day |

---

## 1. Unified SQLite Database

### Current state
Three separate SQLite files, two different drivers:
- `.magector/index.db` — Rust (`rusqlite`): vector metadata
- `.magector/enrichment.db` — Node.js (`node:sqlite`): method-chain null-risk analysis
- `.magector/sqlite.db` — Rust (`rusqlite`): LLM-generated descriptions

### Target state
Single `.magector/data.db` with schema namespacing via table prefixes:

```sql
-- Vector metadata (written by Rust indexer)
CREATE TABLE vectors_metadata (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL,
    hash TEXT,
    module TEXT,
    class_name TEXT,
    -- ... existing columns from index.db
);

-- LLM descriptions (written by Rust describe command)
CREATE TABLE llm_descriptions (
    path TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    description TEXT NOT NULL,
    model TEXT NOT NULL,
    timestamp INTEGER NOT NULL
);

-- Method chains (written by Node.js enrichMethodChains)
CREATE TABLE enrichment_method_chains (
    file TEXT NOT NULL,
    line INTEGER NOT NULL,
    chain TEXT NOT NULL,
    first_method TEXT NOT NULL,
    second_method TEXT NOT NULL,
    has_null_guard INTEGER NOT NULL DEFAULT 0,
    indexed_at INTEGER NOT NULL
);
```

### Migration
- On first startup with old layout: detect `enrichment.db` / `sqlite.db` existence, copy tables into `data.db`, rename old files to `.bak`.
- HNSW binary data stays in its own file (`.magector/hnsw.bin`) — it's bincode-serialized, not SQL.
- `node:sqlite` dependency removed from Node.js side — Rust serve process handles all DB writes, Node queries via serve IPC.

### Impact on Node.js `enrichMethodChains()`
Currently writes directly to `enrichment.db` via `node:sqlite`. After change:
- **Option A:** Move enrichment logic to Rust (serve command `enrich`). Node sends `enrich` command via stdin, Rust does the PHP file scanning + DB writes.
- **Option B:** Keep enrichment in Node.js but use `better-sqlite3` npm package instead of `node:sqlite`.
- **Chosen: Option A** — keeps all DB access in Rust, eliminates `node:sqlite` requirement (Node.js 18+ sufficient again).

### Tests
- Unit test: migration from 3 DBs to 1
- Unit test: `enrichment_method_chains` queries return same results as before
- Unit test: `llm_descriptions` get/upsert/all work
- Integration test: MCP server starts with old layout → auto-migrates → tools work

---

## 2. semgrep → Tree-sitter Queries

### Current state
`astSearch()` in `mcp-server.js` spawns `semgrep` subprocess with user-supplied pattern. Used by:
- `magento_ast_search` — arbitrary patterns
- `magento_find_dataobject_issues` — hardcoded `$X->$SETTER(null)` pattern

### Target state
Tree-sitter PHP queries executed in Rust `rust-core/src/ast.rs`. Named patterns stored as `.scm` files in `rust-core/queries/`:

```
rust-core/queries/
├── dataobject-set-null.scm      # ->setX(null) calls
├── unchecked-method-chain.scm   # $this->dep->method() without null check
└── ...                          # future patterns
```

`magento_ast_search` changes from arbitrary pattern to named pattern selection:
```json
{"tool": "magento_ast_search", "args": {"pattern": "dataobject-set-null", "path": "vendor/drmax/"}}
```

New Rust serve command: `ast_query {pattern_name, path, limit}` → returns JSON array of matches.

### Breaking change
`magento_ast_search` no longer accepts arbitrary semgrep patterns. The `pattern` arg becomes a pattern name (enum). Tool description updated to list available patterns. This is acceptable because:
- Only 2 callers exist (ast_search + find_dataobject_issues)
- ad-hoc semgrep patterns were rarely used (semgrep often missing on user machines)

### Tests
- Unit test per `.scm` query file: known PHP fixture → expected matches
- Integration test: `magento_ast_search` with `dataobject-set-null` returns matches
- Integration test: `magento_find_dataobject_issues` produces same output as before

---

## 3. GNU grep → grep-searcher Rust Crate

### Current state
`magento_grep` in `mcp-server.js` spawns `execFileSync('grep', [...])` with:
- `-rn` or `-rl` (filesOnly)
- `-E` (extended regex)
- `-i` (optional case insensitive)
- `-C N` (context lines)
- `--include=*.php` (file pattern filter)

### Target state
New Rust serve command: `grep {pattern, path, include, context, max_results, files_only, ignore_case}`.
Uses `grep-searcher` + `grep-regex` crates (from ripgrep internals).

Node.js `magento_grep` handler sends grep queries to Rust serve process instead of spawning external grep. Fallback: if serve process not ready, spawn external `grep` as before (cold-start path).

### Advantages
- Cross-platform (Windows works without GNU grep)
- No subprocess fork overhead (~1-3ms saved per call)
- Consistent regex engine (Rust `regex` crate)
- Results serialized as JSON in Rust → no stdout line parsing in JS

### Tests
- Unit test: regex patterns match expected content in fixture files
- Unit test: `--include` glob filtering works for `*.php`, `*.xml`, `*.{php,xml}`
- Unit test: context lines (0, 2, 4) produce correct output
- Unit test: filesOnly mode returns paths only
- Integration test: `magento_grep` via MCP returns same results as GNU grep on a test fixture
- Performance test: compare wall-clock of Rust grep vs external grep on `vendor/` tree

---

## 4. Embedding Model Upgrade

### Current state
`all-MiniLM-L6-v2` — 22 MB, 384 dimensions, MTEB ~58.

### Target state
`bge-small-en-v1.5` — 33 MB, 384 dimensions, MTEB ~62.2.

Drop-in replacement: same dimensionality (384), same ONNX format. Changes:
- Model download URL in `rust-core/src/embedder.rs`
- Model filename / hash validation
- Tokenizer config (bge-small uses different tokenizer than MiniLM)
- `EMBEDDING_DIM` stays 384 — no HNSW structural change

### Migration
Index format version bump. Existing indexes detected as incompatible → auto re-index (existing behavior).

### Tests
- Unit test: embedding output shape is [1, 384] for a test sentence
- Unit test: cosine similarity between "checkout totals" and "collectQuoteTotals" is > 0.5
- Benchmark: compare MiniLM vs bge-small on the 101 E2E query suite (optional — measures quality delta)

---

## 6. bincode 1.3 → 2.0

### Current state
`bincode = "1.3"` in `Cargo.toml`. Used for HNSW index serialization.

### Target state
`bincode = "2.0"` with explicit `Configuration` for forward-compatible encoding.

```rust
use bincode::{config, Decode, Encode};
let config = config::standard();
let bytes = bincode::encode_to_vec(&hnsw_state, config)?;
let (state, _): (HnswState, _) = bincode::decode_from_slice(&bytes, config)?;
```

### Migration
Format version bump → auto re-index on first startup with old format.

### Tests
- Unit test: round-trip serialize → deserialize produces identical HNSW state
- Unit test: old bincode 1.x data triggers format incompatibility detection

---

## 8. reqwest → ureq

### Current state
`reqwest = { version = "0.12", features = ["blocking", "rustls-tls", "json"] }` — used only in `embedder.rs` for one-time ONNX model download.

### Target state
`ureq = { version = "3", features = ["tls"] }` — synchronous HTTP client, no async runtime, ~150 KB vs ~1 MB.

```rust
let resp = ureq::get(url).call()?;
let mut reader = resp.into_body().into_reader();
std::io::copy(&mut reader, &mut file)?;
```

### Tests
- Unit test: model download succeeds (can mock with a local HTTP server or test with real URL)
- Manual verification: `npx magector init` on fresh project downloads model correctly

---

## 9. Consolidate .magector/ Meta Files

### Current state
```
.magector/
├── serve.pid           # text: PID\nVERSION
├── reindex.pid         # text: PID
├── primary.lock        # empty file (existence = lock)
├── format-ok.json      # JSON: {version, timestamp}
├── version-check.json  # JSON: {latest, checkedAt}
└── serve.sock          # Unix socket
```

### Target state
Move all meta-state into `data.db` (from change #1):

```sql
CREATE TABLE state_processes (
    name TEXT PRIMARY KEY,      -- 'serve', 'reindex'
    pid INTEGER NOT NULL,
    version TEXT,
    started_at INTEGER NOT NULL
);

CREATE TABLE state_cache (
    key TEXT PRIMARY KEY,       -- 'format_ok', 'version_check'
    value TEXT NOT NULL,        -- JSON blob
    updated_at INTEGER NOT NULL
);
```

Keep only: `serve.sock` (Unix socket — can't go in SQLite) and `data.db` itself.

`.magector/` after consolidation:
```
.magector/
├── data.db       # all SQLite data + state
├── hnsw.bin      # bincode-serialized HNSW index
├── serve.sock    # Unix domain socket
└── magector.log  # diagnostic log
```

### Tests
- Unit test: process state CRUD (insert, read, cleanup stale PIDs)
- Unit test: cache state CRUD
- Integration test: MCP server startup reads process state from DB, not PID files

---

## Execution Order

Dependencies between changes:

```
#6 (bincode 2.0) ──┐
                    ├──→ #4 (bge-small model) ──→ re-index once
#8 (ureq)     ─────┘
#1 (unified SQLite) ──→ #9 (consolidate meta) ──→ #2 (tree-sitter queries)
#3 (grep-searcher) — independent
```

Recommended sequence:
1. **Phase 1 — Rust internals (no JS changes):** #6, #8, #4
2. **Phase 2 — Storage consolidation:** #1, #9
3. **Phase 3 — Tool replacements:** #2, #3

After all phases: full test suite, CHANGELOG, README update, `npm version minor`, release.

---

## Out of Scope

- Pure Rust MCP server (#5) — wait for rmcp 1.x
- musl static linking (#7) — needs performance benchmarking first
- New MCP tool additions — this spec only refactors internals
- Node.js → Rust port of pattern detection (7000+ lines) — separate project
