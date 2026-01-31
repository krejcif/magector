# Changelog

All notable changes to Magector are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/). Versions correspond to git tags and npm releases.

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
