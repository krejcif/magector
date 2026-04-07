# Changelog

All notable changes to Magector are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/). Versions correspond to git tags and npm releases.

## [1.7.1] - 2026-04-07

### Added
- **`--threads` and `--batch-size` flags now work via `npx magector index`** — the Node CLI previously parsed only `--limit`, `--format`, `--verbose`, and `--force`, silently dropping `--threads` and `--batch-size` even though the Rust binary already supported them. Both flags are now forwarded through `index` and `init` and documented in `npx magector help`.
- **`OMP_NUM_THREADS` honored as a fallback** — the embedder now resolves the ONNX intra-op thread count from (in priority order) the `--threads` flag, `MAGECTOR_THREADS`, `OMP_NUM_THREADS`, then half of available cores. `OMP_NUM_THREADS` is the de facto standard for ONNX/OpenMP workloads, and many users reach for it first.
- **Rayon thread pool constrained by the same setting** — PHASE 1 (parallel AST parsing) previously used all CPU cores regardless of `MAGECTOR_THREADS`, leaving the parsing phase saturating the machine. The Rust binary now configures rayon's global thread pool from `--threads` / `MAGECTOR_THREADS` / `OMP_NUM_THREADS` before any parallel work begins, so a single setting controls both phases.
- **Thread source logged at startup** — the embedder log line now shows where the limit came from (`--threads flag`, `MAGECTOR_THREADS`, `OMP_NUM_THREADS`, or `default (half of cores)`), making it obvious whether your env var actually took effect.
- **`MAGECTOR_INDEX_TIMEOUT` documented in `--help`** — along with `MAGECTOR_THREADS`, `MAGECTOR_BATCH_SIZE`, and `OMP_NUM_THREADS`. New "Index options" section in `npx magector help`. README has a new "Constraining CPU usage during indexing" subsection.

### Changed
- **Default indexing timeout raised from 30 minutes to 4 hours** (`MAGECTOR_INDEX_TIMEOUT` default `1800000` → `14400000`). The previous default was insufficient for ~80K-file enterprise Magento installations under any kind of CPU constraint, causing silent timeouts with no partial result. Users with smaller codebases see no difference; users with large codebases or `CPUQuota=` constraints no longer need to discover the env var the hard way.
- **Improved timeout error message** — on `ETIMEDOUT`, the CLI now suggests both raising the timeout *and* lowering `--threads` instead of only mentioning the env var.

## [1.7.0] - 2026-04-02

### Added
- **Configurable ONNX thread limit** — new `--threads` CLI flag and `MAGECTOR_THREADS` env var. Default changed from all CPU cores to half, reducing system impact during indexing.
- **Configurable embedding batch size** — new `--batch-size` CLI flag and `MAGECTOR_BATCH_SIZE` env var. Default increased from 32 to 256, reducing ONNX inference overhead by ~8x on large codebases.
- **Incremental index saves** — index is saved to disk every 50 batches during embedding generation (~12,800 files). If the process is interrupted, the partial index is preserved and usable.
- **Crash-safe writes** — new `save_atomic()` method writes to a temp file and renames, preventing index corruption on crash.
- **PHASE 2 progress logging** — embedding progress logged every 10 batches with items processed, percentage, elapsed time, ETA, and throughput rate. Visible in both terminal and `.magector/magector.log`.

### Fixed
- **Forced full re-index on MCP server restart** — previously, restarting Claude Code or the IDE would kill the serve process and trigger a full re-index even if a valid (or partial) index existed on disk. Now the MCP server preserves compatible indexes and only re-indexes on actual format incompatibility or missing database.
- **Index unavailable during entire PHASE 2** — with incremental saves, partial search results are available from the first checkpoint instead of only after the full index completes.
- **No progress in log file** — PHASE 2 previously wrote only to the terminal progress bar (ANSI escape codes), which was invisible when piped to log files. Progress is now logged via both `pb.println()` and `tracing::info!`.

## [1.6.1] - 2026-03-19

### Fixed
- **`vendor/` directory is now indexed** — v1.6.0 over-corrected by adding `vendor` to `EXCLUDE_DIRS`, which excluded the entire vendor/ tree. For Magento 2, vendor/ contains ~40,000-50,000 PHP files essential for semantic search. Now only `vendor/bin` is excluded (via `EXCLUDE_PATHS`), restoring full vendor/ indexing.
- Release workflow `permissions.contents` changed from `read` to `write` so CI can create GitHub releases with binaries

## [1.6.0] - 2026-03-13

### Added
- `.magectorignore` file support — place a `.magectorignore` file in the Magento project root to exclude additional directories from indexing. Uses gitignore-like syntax: one pattern per line, `#` comments, trailing slashes stripped. Patterns without `/` match directory names anywhere; patterns with `/` match relative paths from project root.
- `EXCLUDE_PATHS` constant for path-based exclusions (`pub/static`, `dev/tests`, `dev/tools`) that require more than directory name matching

### Fixed
- **`vendor/` directory now excluded from indexing** — previously only `vendor/bin` was in the exclude list, but the name-based matching never worked for path entries. This caused 100K-500K third-party Composer files to be indexed, leading to 30+ minute timeouts on large Magento codebases. Indexing time drops from 30+ minutes to 1-5 minutes for typical projects.
- Dead code in `EXCLUDE_DIRS` — entries with path separators (`vendor/bin`, `pub/static`, `dev/tests`, `dev/tools`) never matched because `should_skip_dir()` compared against `file_name()` (leaf component only). Moved path-based entries to a new `EXCLUDE_PATHS` check that uses relative path matching.

## [1.5.3] - 2026-03-10

### Fixed
- Indexing timeout on large codebases (`ETIMEDOUT`) — increased default from 10 minutes to 30 minutes across CLI, init, and MCP server
- Clear error message on timeout with instructions to increase via `MAGECTOR_INDEX_TIMEOUT` env var

### Added
- `MAGECTOR_INDEX_TIMEOUT` environment variable — override indexing timeout in milliseconds (default: 1800000)

## [1.5.2] - 2026-03-06

### Added
- Auto-update check on every CLI run — checks npm registry for newer version (cached 1h), re-execs via `npx magector@<latest>` to self-update seamlessly. Set `MAGECTOR_NO_UPDATE=1` to disable.
- Comprehensive logging to `.magector/magector.log` — config dump at startup, serve process lifecycle (spawn args, PID, exit code/signal), every serve query with ID and timeout tracking, search cache hits, fallback decisions, cleanup signals, and fatal errors with stack traces
- Version number displayed in `npx magector init` header (`Magector Init v1.5.1`)

### Fixed
- Orphaned `magector-core serve` processes flooding CPU on IDE restart — added PID file tracking (`.magector/serve.pid`), stale process cleanup on startup, and SIGTERM/SIGINT/SIGHUP signal handlers

### Changed
- `RUST_LOG` upgraded from `error` to `info` — Rust-side watcher events, indexing progress, model loading, and HNSW operations now logged to `.magector/magector.log`

## [1.5.0] - 2026-01-31

### Added
- LLM description enrichment for `di.xml` files — `magento_describe` MCP tool sends DI configurations to an LLM for human-readable summaries, stored in SQLite (`.magector/sqlite.db`)
- `describe` Rust CLI command and `describe` serve command for batch LLM enrichment
- `describe.rs` module — SQLite storage for LLM-generated descriptions with upsert support
- Enriched descriptions surfaced in `magento_search` and `magento_lookup` results when available
- `npx magector init` prompts for optional Anthropic API key — stored in MCP config env for LLM enrichment

### Changed
- Consolidate all data files into `.magector/` subdirectory — no more scattered files in project root
  - `magector.db` → `.magector/index.db`
  - `magector-descriptions.db` → `.magector/sqlite.db`
  - `magector.log` → `.magector/magector.log`
  - SONA state file derived from index path (`.magector/index.db.sona`)
- `npx magector init` now creates `.magector/` directory and adds it to `.gitignore`
- `MAGECTOR_DB` env var default changed from `./magector.db` to `./.magector/index.db`
- All Rust CLI command defaults updated to `.magector/` paths
- README rewritten — Magector positioned as a technology-aware MCP server with intelligent indexing and search

### Removed
- Legacy fallback to `magector.db` in project root
- Legacy fallback to `magector-descriptions.json` (JSON format descriptions)
- "Magector vs Built-in AI Search" README section (consolidated into "Why Magector")

## [1.4.3] - 2026-01-31

### Added
- SONA feedback learning system (`sona.rs`) — learns from MCP tool call sequences to adjust search result rankings
- MicroLoRA adapter (rank-2, 1536 params, ~6KB) for embedding-level query adaptation before HNSW search
- EWC++ (Elastic Weight Consolidation) regularizer to prevent catastrophic forgetting during online learning
- 3-tier scoring: per-query-hash (strongest), per-term (cross-query generalization), global bias (weakest)
- `SessionTracker` in MCP server — detects search→tool follow-up patterns within 30s and query refinements within 60s
- `feedback` and `sona_status` serve commands for Rust process
- Cosine similarity guard (≥0.90) on LoRA adjustment — skips destructive embedding changes
- LoRA learning rate decay — later signals have diminishing influence (`lr / (1 + 0.005 × count)`)
- Negative learning (0.1× rate) — when a user follows a specific result type, non-matching types are mildly demoted
- `config_xml_dir` feature for more precise scoring of XML files under `/etc/`
- Database format compatibility check with automatic background re-index on format mismatch
- `extractJson()` helper to handle Rust binary stdout that contains tracing lines mixed with JSON
- Activity logging to `magector.log` in project root (all MCP requests, serve process stderr, re-index progress)
- `magector.log` added to `.gitignore` during `init`
- Panic guard in serve process request handler — catches panics without killing the long-running process
- SONA eval test suite (180 queries across 8 categories: plugin, observer, class, controller, config, block, cross-gen, ambiguous)
- SONA integration tests (8 tests)

### Changed
- Serve process now passes `db_path` to request handler (required for SONA persistence)
- `hybrid_search()` accepts optional `SonaEngine` reference for score adjustment
- `Indexer` loads SONA state from `.sona` file alongside the database and applies MicroLoRA before HNSW search
- Term-level weight raised from 0.5 to 0.7 for stronger cross-query generalization
- Global bias weight raised from 0.2 to 0.3
- `VectorDB::open()` gracefully handles format mismatches — removes incompatible database and returns empty instead of crashing
- Integration tests handle new stderr messages from background re-index and format check

## [1.4.2] - 2026-01-30

### Changed
- Increase watcher poll interval to 300s (from 60s)

### Fixed
- Fix stderr test assertion for updated poll interval

## [1.4.1] - 2026-01-30

### Changed
- Always fetch latest version when writing MCP config (no more stale pinned versions)

## [1.4.0] - 2026-01-30

### Added
- `magento_trace_flow` MCP tool -- trace execution flow from route, API, GraphQL, event, or cron entry point through controllers, plugins, observers, and templates in one call

## [1.3.5] - 2026-01-30

### Changed
- Write Cursor MCP config to global `~/.cursor/mcp.json` instead of project-local config

## [1.3.4] - 2026-01-30

### Changed
- Generate `.cursor/rules/magector.mdc` instead of deprecated `.cursorrules` file

## [1.3.3] - 2026-01-30

### Fixed
- Fix serve process never reaching ready state before queries (race condition on startup)

## [1.3.2] - 2026-01-30

### Changed
- Sync `Cargo.toml` version with npm `package.json` and auto-sync in CI release workflow

## [1.3.1] - 2026-01-30

### Fixed
- Fix binary resolution when optional npm platform dependency fails to install (self-healing fallback)

## [1.3.0] - 2026-01-30

### Added
- Background file watcher with incremental re-indexing in serve mode
- Tombstone soft-delete strategy for modified/deleted files
- Auto-compact when tombstoned entries exceed 20% of total vectors
- `--watch-interval` flag for configurable poll interval
- `watcher_status` serve command

## [1.2.15] - 2026-01-29

### Changed
- Improve E2E accuracy to 99.2% (A+ grade, 101/101 queries passing)
- Add Adobe Commerce support (B2B, Staging, and all Commerce-specific modules)

## [1.2.14] - 2026-01-29

### Fixed
- Fix Mermaid diagram parse errors in GitHub README viewer

## [1.2.13] - 2026-01-29

### Changed
- Add Mermaid diagrams to README for architecture, pipelines, and workflows

## [1.2.12] - 2026-01-29

### Changed
- Structured JSON output for all MCP search tools (paths, classes, methods, badges, snippets)
- Enriched MCP tool descriptions with keywords and cross-tool "See also" references

## [1.2.11] - 2026-01-29

### Changed
- Improve accuracy with persistent serve mode and hybrid reranking
- Expand E2E test suite to 101 queries across 16 tool categories

### Added
- Persistent serve mode -- keeps ONNX model + HNSW index resident in memory
- LRU query cache (200 entries)

## [1.2.10] - 2026-01-29

### Changed
- Replace static tests with stdio MCP integration tests (64 tests)

## [1.2.9] - 2026-01-29

### Changed
- Save database to exact path given via `MAGECTOR_DB`

### Removed
- Remove legacy JSON index format

## [1.2.8] - 2026-01-29

### Fixed
- Fix MCP server returning invalid JSON due to ONNX Runtime log pollution on stdout

## [1.2.7] - 2026-01-28

### Changed
- Safely update existing IDE rules on re-init instead of skipping

### Fixed
- Suppress noisy ONNX Runtime logs during indexing

## [1.2.6] - 2026-01-28

### Added
- Progress bars and ETA during indexing
- ASCII art header on CLI startup

## [1.2.5] - 2026-01-28

### Fixed
- Fix CI: sync platform package versions from root, remove unnecessary `npm ci` step

## [1.2.4] - 2026-01-28

### Fixed
- Fix `-c` flag for `--model-cache` in Rust CLI
- Handle empty/corrupted model files gracefully

## [1.2.3] - 2026-01-28

### Fixed
- Fix `package-lock.json` sync with `optionalDependencies`

## [1.2.2] - 2026-01-28

### Fixed
- Fix EACCES: ensure platform binary has execute permission after npm install

### Changed
- Add comparison to Claude Code / Cursor built-in search in README

## [1.2.1] - 2026-01-28

### Fixed
- Fix redirect handling for relative `Location` headers in ONNX model download

## [1.2.0] - 2026-01-28

### Removed
- Remove darwin-x64 (Intel Mac) target -- `ort` has no prebuilt ONNX Runtime for this platform

## [1.1.0] - 2026-01-28

### Fixed
- Fix cross-compilation build failure for linux-arm64

## [1.0.0] - 2026-01-28

### Added
- Semantic code search for Magento 2 and Adobe Commerce
- ONNX embeddings (all-MiniLM-L6-v2, 384 dimensions) via `ort`
- HNSW vector index with hybrid semantic + keyword reranking
- Tree-sitter AST parsing for PHP and JavaScript
- 20+ Magento pattern detectors (controller, model, plugin, observer, block, repository, resolver, cron, etc.)
- MCP server with 20 tools for AI-assisted development
- `npx magector init` -- full setup: index + IDE config in one command
- Cross-platform npm distribution (darwin-arm64, linux-x64, linux-arm64, win32-x64)
- Batched ONNX embedding (32 per call) with adaptive thread scaling
- Bincode binary serialization for fast index save/load
- 557 Rust-level validation test cases
- `.cursorrules` and `CLAUDE.md` generation for IDE integration
