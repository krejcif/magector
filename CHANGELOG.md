# Changelog

All notable changes to Magector are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/). Versions correspond to git tags and npm releases.

## [2.15.1] - 2026-04-13

### Security
- **Path traversal in `magento_read`, `magento_grep`, `magento_ast_search`** — handlers previously joined `args.path` with the project root without validation, so a relative path containing `..` segments (or an absolute path) escaped `MAGENTO_ROOT`. In isolation the tools are invoked by a trusted MCP client, but combined with prompt injection from indexed third-party code (e.g. a hostile comment in a `vendor/` module instructing the LLM to read `../../home/user/.ssh/id_rsa`) the escape was exploitable. New `safePath()` / `safeRelPath()` helpers normalize the input with `path.resolve()` and reject any result that falls outside the resolved root. All three standalone handlers and their `magento_batch` counterparts share the same chokepoint. Unit tests cover the normal, boundary and escape cases.
- **Shell injection hardening in `update.js`** — the auto-update re-exec interpolated the npm registry's `latest` field into a shell command string. A tampered registry response (or an MITM without TLS pinning) could therefore inject shell metacharacters. The re-exec now passes argv as an array to a no-shell spawner, and a semver-strict `isSafeVersion()` validator rejects anything containing metacharacters. Fails closed — the auto-update is silently skipped rather than running a malformed version string.
- **Unix socket permissions** — the serve-proxy Unix socket at `.magector/serve.sock` was created with the default umask (typically world-readable). On multi-user systems another local account could connect and query the vector index, leaking indexed code snippets. The socket is now `chmod 0600` immediately after `listen()`.

## [2.15.0] - 2026-04-13

### Added
- **`magento_find_dataobject_issues`** — new tool that detects `setX(null)` anti-pattern on Magento `DataObject` subclasses. Calling `setX(null)` stores `['x' => null]` in `_data`, so `hasX()` (which uses `array_key_exists`) returns `true` even for null — creating silent false-positive guard conditions downstream. The correct way to fully clear a field is `unsetData('x')`. Uses semgrep internally with post-filtering for setter name pattern. Supports `path` and `maxResults` parameters. Available in `magento_batch`.

### Fixed
- **`astSearch()` snippet fallback for semgrep >=1.100** — newer semgrep versions return `"requires login"` in `r.extra.lines` for unlicensed installs. The snippet now falls back to `r.extra.message` (always available) when `lines` is empty or `"requires login"`. This restores correct code snippets in `magento_ast_search` and `magento_find_dataobject_issues` output.

## [2.14.1] - 2026-04-12

### Fixed
- **`magento_grep` brace expansion in `include` parameter** — patterns like `*.{php,xml,graphqls}` were broken by naive comma-split, producing invalid `--include=*.{php` flags for GNU grep. New `expandIncludePattern()` helper correctly splits on commas outside braces first, then expands brace alternatives. Both standalone and batch handlers are fixed.

## [2.14.2] - 2026-04-12

### Fixed
- **`astSearch()` .semgrepignore placed in wrong directory** — was created in the scan target directory (e.g., `vendor/magento/module-sales/`), but semgrep resolves `.semgrepignore` from the git repo root, not the scan path. This caused semgrep to silently ignore all `vendor/` files when scanning subdirectories inside a git repo, returning 0 results. Now creates `.semgrepignore` at `MAGENTO_ROOT` (the git root).

## [2.14.0] - 2026-04-12

### Added
- **Comprehensive diagnostic logging** — all new v2.12/v2.13 functions now have structured log entries for debugging production issues:
  - `astSearch()`: logs pattern, path, lang, semgrep execution time, result count, semgrep errors, and `.semgrepignore` lifecycle
  - `enrichMethodChains()`: logs start, file count, progress every 10k files, per-file read errors (first 5), transaction failures, and final summary with timing
  - `queryNullRisks()`: logs missing enrichment.db, unavailable node:sqlite, query parameters, result count, and query timing
  - `magento_batch`: logs query list on entry, per-tool timing and errors for each sub-query
  - `magento_grep`: logs slow queries (>5s) and timeouts
  - `magento_read`: logs file-not-found errors and failed method extractions
  - Auto-enrich after `magento_index`: logs start event (previously only logged completion)

## [2.13.1] - 2026-04-12

### Fixed
- **`enrichMethodChains` transaction safety** — enrichment DB writes are now wrapped in BEGIN/COMMIT/ROLLBACK. Previously, a crash mid-insert could leave partial data (DELETE completed but not all INSERTs).
- **`hasNullGuard` false positive on `?->`** — nullsafe operator (`?->`) on a different variable in surrounding code no longer marks unrelated chains as safe. Now only checks the matched line itself.
- **Batch `magento_grep` `filesOnly` dropped `-E` flag** — batch handler used splice mutation that removed the extended-regex flag. Aligned with standalone handler's clean ternary approach.

### Changed
- **`enrichMethodChains` line counting O(n) per match → O(log n)** — replaced repeated `content.slice().split()` with binary search on a pre-built line-offset index.
- **Removed unused `options` parameter** from `enrichMethodChains()`.
- **Test file structure** — moved `testHasNullGuard` and `testEnrichChainRegex` before `main()` for consistency with other tests. Added regression test for `?->` false positive.

## [2.13.0] - 2026-04-12

### Added
- **`magento_enrich` tool** — builds the method-chain enrichment index. Scans all `vendor/` PHP files for two-step method chains (`->firstMethod()->secondMethod()`) and analyses whether each call has a null guard in surrounding code (`=== null`, `!== null`, `?->`, `??`, `isset`, `is_null`). Results are stored in `.magector/enrichment.db` (SQLite). Runs automatically in the background after `magento_index`.
- **`magento_find_null_risks` tool** — queries the pre-built enrichment index for method chains without null guards. Pass `firstMethod` to filter (e.g., `"getPayment"` finds all `->getPayment()->anything()` calls without null guard). Available in `magento_batch`. ~100× faster than grep for null-safety analysis: O(1) SQLite query instead of scanning 80k PHP files. Requires `magento_enrich` to be run first.
- **Auto-enrichment after `magento_index`** — method-chain index is built in the background automatically when indexing completes.

## [2.12.0] - 2026-04-12

### Added
- **`magento_ast_search` tool** — structural PHP code search using [semgrep](https://semgrep.dev). Unlike `magento_grep` (text-based), this understands PHP AST: matches code structure regardless of variable names, ignores matches inside comments and strings. Pattern syntax: `$X` = any expression, `$Y` = any identifier, `...` = any arguments. Example: `$ORDER->getPayment()->$M(...)` finds all two-step method chains on payment objects, regardless of variable name. Available standalone and in `magento_batch`. Requires `semgrep` installed (`pip install semgrep`).
- **`magento_grep` `filesOnly` parameter** — returns only matching file paths (like `grep -l`), no content or line numbers. Use for discovery: first find which files match, then batch-read specific files with `magento_read`. Dramatically reduces tokens when a pattern matches many files.

### Changed
- **`magento_grep` default context increased from 2 → 4 lines** — agents can now see null-guard checks (`!== null`, `is_null(`) in the surrounding code without needing a follow-up file read. Set `context: 0` for broad scans with 30+ matches.
- **`magento_read` now hints when reading large files without `methodName`** — if a file has >100 lines and no `methodName` param is provided, the response appends a tip listing available methods and recommending targeted extraction (~10× fewer tokens).

## [2.9.0] - 2026-04-10

### Added
- **`magento_grep` tool** — exact text search (grep) across Magento files. Unlike `magento_search` (semantic/vector), this finds EVERY occurrence of a literal string or regex pattern. Supports `path` filter, `include` file patterns, `context` lines, `ignoreCase`, and `maxResults` limit. Uses `grep -rn` internally — instant and deterministic. Available standalone and in `magento_batch`. Closes the #1 gap vs classical debugging: systematic coverage of all call sites in one call.

## [2.6.3] - 2026-04-10

### Fixed
- **`magento_find_method` filesystem fallback** — when vector search returns no results for a method name (e.g., `isEditableOrderType`), the tool now uses `grep -rl` to find PHP files containing the method signature across the entire codebase. Previously used `glob` limited to 500 files which missed methods in deep directory trees. The `grep -rl` approach is fast (~2s for 80K files) and finds all matches regardless of path depth. With className provided, falls back to targeted glob. Returns full method body via brace-counting.

## [2.6.2] - 2026-04-10

### Fixed
- **`magento_find_class` filesystem fallback** — when vector search returns no matching results (common for custom module class names that embed poorly), the tool now falls back to `glob(**/${ClassName}.php)`, reads the file to extract the namespace and public methods, and returns full results. Previously returned `{"results":[],"count":0}` for classes like `AddressConditions` or `AfterDiscountCollector`.
- **`magento_module_structure` camelCase hyphenation** — vendor path matching now correctly hyphenates camelCase module names (`OrderSplit` → `module-order-split/`). Previously, `DrmaxMarketplace_OrderSplit` would look for `module-ordersplit/` which doesn't exist.
- **`magento_impact_analysis` filesystem fallback** — when vector search finds too few candidate files, the tool now globs for `{ClassName}.php` to find the class file. This ensures DI references are still found even when the vector search misses the class.
- **`magento_batch` find_class** — batch version of find_class now also has filesystem fallback.

### Added
- **CLI `--version` flag** — `npx magector --version` now prints the version instead of "Unknown command".

## [2.6.1] - 2026-04-10

### Fixed
- **Stale serve process after upgrade** — when upgrading Magector (e.g., 2.1.2 → 2.6.x), the old serve process could remain running with an outdated index, causing all search-based tools to return empty results while the CLI worked fine. The MCP server now writes its version to the PID file and kills any serve process from a different version on startup.
- **`rustSearchAsync` empty results fallback** — when the serve process returns 0 results (stale index, wrong DB), the tool now falls through to `execFileSync` (which always works if CLI works) instead of caching and returning the empty result.
- **`magento_find_plugin` partial class name matching** — short class names like `"Address"` now correctly find plugins registered for `Vendor\Module\Model\Rule\Condition\Address` in di.xml. Previously, the DI scan used exact string comparison (`typeName !== normalizedTarget`), which required the full FQCN. Now uses short name suffix matching for non-FQCN inputs.
- **`magento_find_observer` structural matching** — now parses `events.xml` files for exact event name matching (like `magento_find_event_flow` does), instead of relying solely on semantic vector search which returned loosely related results. Falls back to semantic search only when events.xml parsing finds nothing.

### Added
- **`magento_module_structure` and `magento_find_observer` in `magento_batch`** — both tools can now be used in batch requests.

## [2.6.0] - 2026-04-10

### Changed
- **Reduced default result limits** — `magento_search` default from 10 to 5, `magento_find_class` from 5 to 3, `magento_find_method` from 10 to 5. Agents rarely use results beyond rank 3-5, and the extra results consumed tokens without adding value. Use the `limit` parameter to override when more results are needed.
- **Snippet truncation for lower-ranked results** — `formatSearchResults` now only includes `snippet` and `codePreview` for the top 3 results. Results ranked 4+ still show path, className, methodName and badges but omit verbose content. Reduces token consumption by ~40% for typical queries. `fullMethodBody` (from `magento_find_method`) is always included regardless of rank.
- **`magento_find_plugin` now includes method bodies** — when DI registrations are resolved, each plugin method (before/after/around) now includes its complete source code in the response. Eliminates the need for follow-up `magento_find_method` calls to understand what a plugin actually does.

### Added
- **DI XML session cache** — `getDiXmlFiles()` caches the glob result and file contents across tool calls within a session. Tools that scan di.xml (find_plugin, find_di_wiring, trace_dependency) now share cached data instead of re-reading all files from disk on each call. Speeds up multi-tool debugging workflows significantly.

## [2.5.2] - 2026-04-09

### Added
- **Full method body in `magento_find_method`** — results now include the complete method source code extracted via brace-counting, not just a 10-line snippet. This lets LLM agents verify what a method actually does without needing a separate file-read tool. Critical for accurate bug analysis where method behavior must be understood, not just located.
- **`magento_find_di_wiring` and `magento_find_method` in `magento_batch`** — both tools can now be used in batch requests for parallel execution.

### Fixed
- **FQCN disambiguation in `magento_find_di_wiring`** — when a fully-qualified class name is provided (e.g., `Acme\OrderEdit\Plugin\ViewPlugin`), DI XML matching and PHP constructor extraction now verify the full namespace instead of matching on the short class name alone. Previously, if two modules had classes with the same short name (e.g., `ViewPlugin`), the tool could return the wrong module's constructor and DI configuration. The fix adds namespace verification for both XML `<type>` matching and PHP file selection.

## [2.5.1] - 2026-04-09

### Added
- **`magento_search` precise mode** — new `precise: true` parameter disables query expansion and applies strict post-filtering: only returns results where the file content contains at least one significant query keyword. Reduces noise for debugging-specific queries like "gift card subtotal infinite loop".
- **`magento_impact_analysis` runtime callers** — new "Runtime Callers" section in impact analysis output. Detects classes that inject the target class via constructor and call its methods at runtime (e.g., `$this->totalsCollector->collect()`). Groups callers by class for readability. Reveals the runtime call chain that was previously invisible.
- **`magento_batch` tool** — execute multiple Magector tool calls in a single MCP request to reduce round-trip overhead. Runs queries in parallel and returns combined results. Supports: `magento_find_class`, `magento_find_plugin`, `magento_find_observer`, `magento_trace_dependency`, `magento_impact_analysis`, `magento_search`, `magento_find_callers`, `magento_find_event_flow`. Up to 10 queries per batch.

### Fixed
- **`magento_trace_call_chain` now follows inherited methods** — previously returned `method_not_found` when a method was defined in a parent/abstract class (e.g., `validate()` inherited from `AbstractCondition`). The tool now walks up the PHP inheritance chain (up to 10 levels), resolving parent classes via `extends` declarations and `use` statements. When a method is found in an ancestor, the output shows `inherited from ParentClass` with the resolved file path. Constructor type hints are resolved from both the original child class and the parent class for accurate dependency tracking.

## [2.5.0] - 2026-04-09

### Added
- **`magento_find_fieldset` tool** — new MCP tool to search `fieldset.xml` definitions that control data copy between Magento entities (order→quote, quote→order). Shows which fields are copied for each aspect (`to_order`, `to_edit`, `to_quote`). Essential for understanding data conversion flows like reorder, order edit, and checkout.
- **`magento_trace_shipping_chain` tool** — traces the complete shipping rate calculation chain: carrier classes → plugins on `collectRates()` → ShippingRateModifier pool → totals collectors → fieldset copy mappings. Useful for debugging shipping price issues.
- **Plugin method extraction in `magento_find_plugin`** — when plugins are found via di.xml, the tool now resolves the PHP class file and extracts `before`/`after`/`around` method signatures, showing which target methods are intercepted by each plugin.
- **Code snippets in `magento_trace_flow`** — trace results now include actual code snippets for controllers (`execute()`), observers (`execute()`), cron handlers, and API service methods. Plugin entries include extracted interceptor methods.
- **Fieldset tracking in deep `magento_trace_flow`** — when using `depth: "deep"`, trace results now automatically discover relevant `fieldset.xml` mappings for the traced domain (e.g., `sales_convert_*` fieldsets for sales routes).
- **Code preview in search results** — `formatSearchResults` now reads actual source file lines for PHP results with known class/method names, providing real code previews alongside the indexed text snippet.
- **Helper functions** — `extractPluginMethods()`, `readMethodSnippet()`, `parseFieldsetXml()`, `findClassFile()`, `traceShippingChain()` as reusable utilities for the new tools.
- **29 new unit tests** covering all new helper functions: plugin method extraction, fieldset XML parsing, method snippet reading, and class file resolution.

### Fixed
- **Fieldset filter now matches fieldset ID** — previously `parseFieldsetXml` only filtered by scope ID (e.g., "global"), not the actual fieldset ID (e.g., "sales_copy_order"). Filter now matches against both scope and fieldset IDs.

## [1.7.2] - 2026-04-07

### Fixed
- **Incremental saves are now actually usable for resume.** Since v1.7.0 the indexer had written a checkpoint to disk every 50 batches, but the checkpoint was ignored on the next run — the indexer always called `vectordb.clear()` and started from 0%. On an 80K-file enterprise codebase a single timeout meant losing ~2 hours of work. The indexer now auto-resumes: on startup it collects the paths of every already-embedded file from the existing DB, filters them out of file discovery, preserves the existing HNSW state, and only parses/embeds files that aren't in the DB yet. Partial resume works too — new files added to the tree since the last run are picked up without re-embedding the old ones.
- **MCP server auto-index timeout raised from 30 min to 4 h** (`src/mcp-server.js`). v1.7.1 bumped the default in `cli.js` and `init.js`, but the MCP server's `rustIndex()` path still used the old 1800000 literal, so users running indexing through Claude Code / Cursor hit the old 30-minute cliff. Error message now mentions that partial progress is preserved and the next run will resume.

### Added
- **`--force` flag on `npx magector index`** — discards any existing index and rebuilds from scratch. Without `--force`, indexing auto-resumes from the last incremental save. Useful when you want to pick up major schema or detection changes without waiting for a natural re-index. Forwarded from `src/cli.js` and `src/init.js` to the Rust binary's new `--force` clap flag.
- **`VectorDB::metadata_iter()`** — read-only iterator over live `(id, &IndexMetadata)` pairs, used by resume mode to collect already-indexed paths without exposing internal maps.

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
