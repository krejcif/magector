# Changelog

All notable changes to Magector are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/). Versions correspond to git tags and npm releases.

## [Unreleased]

### Added
- **`find_api`, `find_graphql`, `find_cron`, `find_db_schema` and `module_structure` answer from the configuration, merged as Magento merges it** (`src/magento-config.js`) — before, the first four answered only from the vector index (no index, no answer; with one, whatever ranked), and `module_structure` guessed a vendor path from the module name and stopped at 100 files. Now: Web API routes (merged by url + method, service → the class that runs, ACL); GraphQL fields → resolver / `@cache` identity (types cut and merged as `GraphQlReader` does, interface fields copied, `extend type`; the schema readers registered besides schema.graphqls are named); cron jobs (crontab.xml + config.xml crontab defaults, run model); declared tables with columns, keys and indexes under the names Magento creates, disabled elements, foreign keys to the table; every file of a module (a composer path repository's module at its real path) and what it declares. Only files of enabled modules are read, a webapi.xml / crontab.xml / config.xml / db_schema.xml that is not well-formed is flagged (Magento fails that whole configuration), and each answer says what it cannot see (disabled modules, EAV readers, `core_config_data`). Semantic results follow, marked. On a Mage-OS 2.4.9 project: 446/446 routes, 4,538/4,538 fields, 81/81 jobs, 507/507 tables, 598/598 modules; ~20–100 ms per call after the first.
- **`scripts/verify-magento`: modes `webapi`, `graphql`, `cron`, `dbschema`, `modules`** (`config-truth.php`), and `fixture-truth.php`, which runs Magento's readers on a synthetic fixture — the expected results of `tests/config-models.test.js` come from Magento. Method and the reason for every fix: `docs/verification.md`.
- **`MAGECTOR_FILE_LIST_TTL_MS`** (default 2 s) and **`MAGECTOR_PHP_LIST_TTL_MS`** (30 s): how long the module `etc/` listing and the PHP file list are reused before files added mid-session are picked up.

### Changed
- **First call 0.15–0.5 s instead of 4–6 s, repeated calls 8–110 ms** (Mage-OS project, 73k PHP files, 600 modules). Modules are found from their registrations (`vendor/composer/autoload_files.php`, `app/etc/registration_globlist.php`, including registrations that include `*/registration.php` below them) and config files from a listing of the modules' `etc/` — every `**/etc/…` pattern walked the whole tree (~1 s each, 4–5 per first call); files outside the modules were never read by Magento anyway. `applyModuleOrder` looked up a file's module on every sort comparison (1.6 s). `find_observer` no longer searches every PHP file for dispatchers it does not show (4.9 s per call). A class outside composer's PSR-4 map is looked up in its classmap and in `generated/code` (factories, proxies) instead of walking the tree.
- **Fewer tokens**: no empty semantic block (`{"results":[],"count":0}`) in `find_plugin` (a class without plugins says so); a plugin class registered in several areas shows its code once; `magento_batch` says how many plugin registrations it left out, and its `module_structure` lists counts, not every file.

### Fixed
- **`find_plugin` missed the plugins of the class a preference puts in place of the target** — code asking for `Import\Product` gets a module's `Rewrite\Product`, and that class's plugins run too, in every area; they are listed, marked "the class that runs for this type". **An abstract class** is marked as not running itself (its plugins run on its concrete subclasses). Found on a Magento 2.4.5 project, checked against its runtime.
- **Without an index database every structural tool took 5–10 s** — its semantic addition waited for a serve process that had no index to load (the respawn delay). It is skipped at once now.
- **`trace_call_chain` followed another module's preference** (the first `<preference>` whose name ended the same, e.g. GiftMessage's `CartRepository` for `CartRepositoryInterface`), and traced an aliased or same-named dependency into another module's class. Constructor hints are qualified by the file's namespace and imports; preferences come from the DI model.
- **The DI tools did not see di.xml files added or edited mid-session** (the list and contents were kept until restart) — di.xml is re-read by mtime, and modules are rediscovered when `config.php` / the registrations change.
- **`trace_flow` (GraphQL), `impact_analysis` and `trace_api` read webapi.xml / schema.graphqls with their own regex readers** — `trace_flow` could take another type's field of the same name, `trace_api` the first route whose URL contained the query (or was contained in it), `impact_analysis` missed routes served through a `webapi_rest` preference. They read the merged models now (trace_api agrees with Magento on 446/446 routes of a project).
- **A module whose name contains a dot (`Amasty_Mage2.4.7Fix`) was read from `app/etc/config.php` as not installed**, so its configuration counted as not loaded.
- **A class was looked up by its file name**, so with two classes of the same short name in different modules (`…\Core\Observer\Stock`, `…\Mix\Observer\Stock`) `trace_call_chain` traced the other module's class, `find_class`, `find_method` and `magento_batch` (`find_method`, `find_class`) listed its file, and `findClassFile` returned the first file with that name. A fully qualified name now resolves to the file that declares exactly that class (composer PSR-4 map and classmap, `app/code`, `generated/code`, then a same-named file that declares that FQCN); a short name keeps the fuzzy match.
- **`trace_call_chain`, `trace_config` and `find_fieldset` refused to answer without an index** (they read only PHP and config files) — they are index-free now.

## [2.17.5] - 2026-09-30

### Fixed
- **Vectors of deleted or newly excluded files stayed in the index for good** (#28). `index` and the `serve` watcher reported a file deleted only when the manifest had a record of it, and a manifest rebuilt from the index (after an upgrade or a lost sidecar) records only the files the walk still finds. Every indexed file without a record is now tracked: re-embedded when it is still there, dropped when it is gone or excluded — which is what the 2.17.0 note promised for `vendor/bin`, `dev/tools` and the other paths it excludes. On a 92.5k-file install this dropped 22 leftover vectors.
- **`serve` wrote a stale index back over one that `magector index` had just rebuilt** (#28). `magector index` and the `magento_index` tool rewrite `index.db` while `serve` holds the previous index in memory; its watcher's next save put that copy back, and the new manifest then vouched for the stale vectors. On each check the watcher first reloads an `index.db` that another process replaced, and `serve` never writes its copy over a file that another process wrote after it was loaded. `magento_index` also takes the re-index lock, so the watcher defers to it.
- **A `magector-core` of any version found on `PATH` was used when the platform package could not be resolved** (#28). A leftover 1.4.3 there deleted a 2.16 index it could not decode. The PATH fallback now accepts only a binary whose `--version` matches the package, and the self-heal installs the platform package of this version instead of the latest.
- **The manifest that pre-2.17 background re-indexes left behind as `index.db.manifest` is adopted** (#28). Without it `index` treated every indexed file as current; when `index.manifest` is missing and no temp DB is in progress, the orphan now takes its place.
- **Files that are not valid UTF-8 were skipped** — every Magento install has one: `vendor/symfony/cache/Traits/ValueWrapper.php` declares `class ©` as a Latin-1 byte, and Latin-1 legacy modules were skipped whole (#28). Sources are read lossily, and a file that still fails is logged at warn level instead of only counting as `Errors: 1`.
- **A run that changes nothing leaves `index.manifest` alone**, as it already did `index.db` (#28).
- **An `index.sona` that cannot be decoded is moved aside** (`.incompatible-<ts>`) instead of failing, and warning, on every start (#28).
- The `setting number of points` line `hnsw_rs` prints on stdout is no longer logged as `Unparseable serve stdout` (#28).

## [2.17.4] - 2026-09-30

### Changed
- **Docs:** neutral placeholder names in the architecture plan and spec (`vendor/acme/`).

## [2.17.3] - 2026-09-30

### Changed
- **`index` and `stats` no longer build the search graph.** Opening an index used to rebuild its whole HNSW graph, which only search needs: an incremental refresh with nothing to embed took 47 s on an 86k-vector index with 2 threads, now 2.2 s (`stats`: 41.6 s → 0.2 s), and a refresh or full index no longer inserts into a graph it never searches. The graph is built on the first search; `serve` builds it before it reports ready, so its first query is as fast as before.

### Added
- **`MAGECTOR_AUTO_INDEX=0`** stops the MCP server from starting an index when there is none (or an incompatible one) — for CI and agent jobs, where indexing a whole shop in the background competes with the job. The structural tools work without an index; semantic search says the index is missing. `trace-graphql` and `di-resolution` set it, which also removes `trace-graphql`'s flakiness (a finished background index of its fixture changed a result, or raced the cleanup).

## [2.17.2] - 2026-09-30

### Changed
- **Tool answers are capped** so one broad query cannot flood an agent's context: every MCP tool answer is cut at 40,000 characters (~10k tokens; `MAGECTOR_MAX_OUTPUT_CHARS`) at a line boundary, with open code blocks closed and a note to narrow the query, and `find_implementors` lists at most 50 classes per group with the remaining count (`ActionInterface` on a full install: ~390 KB → 12 KB, every group still shown).

## [2.17.1] - 2026-09-30

### Added
- **Effective DI state per area.** `find_plugin`, `trace_dependency` and `find_di_wiring` add an *Effective state* section: declarations with the same plugin name are merged in module load order (`app/etc/config.php`, or `<sequence>` when it is missing), so a plugin disabled by another module is reported as disabled; `find_preference` answers structurally (FQCN) with the effective preference per area, the superseded declarations and the class that is finally instantiated; `find_observer` / `find_event_flow` merge observers by name the same way.
- **Ambiguous module order is reported.** When two modules declare the same preference, plugin or observer, neither depends on the other (no `<sequence>`, no composer `require`) and swapping them would change the result, the output warns that the outcome depends on incidental module order.
- **Declarations of modules disabled in `app/etc/config.php`** are listed but marked as ignored.
- **Interceptability.** `find_plugin` marks plugins that never run: final class, `Magento\Framework\ObjectManager\NoninterceptableInterface`, and per plugin method a final, static, non-public or never-intercepted target method (`__construct`, `_resetState`, …) or a method the class does not have.
- **README: "How exact are the results?"** — per tool, whether the answer is exact, a marked superset, fuzzy or semantic, and when it can return less than the codebase contains.
- **`scripts/verify-magento/`** — ground truth from a Magento installation (PHP tokenizer, DOMDocument, the running plugin list) and `compare.mjs` to check Magector against it; open items in `docs/di-resolution-todo.md`.
- `find_class` recognises a virtual type name and shows its di.xml declaration and the class it instantiates; `impact_analysis` lists API exposure (`webapi.xml` services, `schema.graphqls` resolvers) and the DI arguments that inject the class.

### Fixed
- **PHP sources are read with a state-machine scanner** (comments, strings, heredoc / nowdoc, attributes, inline HTML) instead of regexes: `'*/*/edit'` — the admin redirect idiom — `'image/*'` or `"a//b"` in a string no longer swallow code up to the next `*/`; declarations or methods inside strings and heredocs are no longer taken as real; methods are read at the class body's brace depth (nested and anonymous classes do not leak), traits are followed, several namespaces per file keep their own imports, `namespace` may follow `<?php` on the same line, and `#[…]class`, `#` comments inside lists, `namespace\\Name` and case-insensitive class names are handled. Checked against PHP's tokenizer on 18,419 real class files (0 differences in classes and methods).
- **Several `<arguments>` blocks per type** are read (the XSD allows them); **preference chains** (`I → J → K`) are followed; a **virtual type re-declared by a later module** wins (module load order); DI arguments resolved through **area-specific preferences** count as injections; plugins on **intermediate virtual types** are reported as not running; **event names** are matched case-insensitively (Magento lower-cases them); `<!--` or `<?` inside CDATA no longer hides elements; `app/etc/config.php` is read with comments, `array()` / `[]`, either quote style and `1`/`0`/`true`/`false`.
- **Plugins declared on an interface or a parent class were missing** from `find_plugin` and `find_di_wiring` for the implementing / child class. Parents and interfaces are now resolved from the PHP sources (composer PSR-4 map first).
- **A plugin declared right after a self-closing `<type … />` was lost or attributed to the wrong type**, and only the first self-closing `<virtualType … />` of a file was read. di.xml and events.xml are parsed with an XML parser (`src/di-config.js`) instead of regexes.
- **Commented-out XML was reported as live configuration.** Comments are ignored everywhere di.xml is read.
- **Virtual types and DI arguments were matched by a substring of the short class name** (`trace_dependency`, `impact_analysis` on a FQCN), which listed unrelated virtual types (`…\Reporter` for `…\Repo`) and missed chains through neutrally named virtual types. They are now resolved transitively, through preferences, `Factory` and `\Proxy`.
- **Plugins on a virtual type:** the plugins of its real class are reported; a plugin declared only on the virtual type name is marked as not running (the interceptor looks plugins up by the real class).
- **Plugin type resolution:** methods are read from the declared type (a virtual type → its base class), the code shown is the class that is instantiated (a preference on the plugin type or an interface as plugin type applies).
- **DI area** of `etc/webapi_rest/`, `etc/webapi_soap/` and `etc/crontab/` files was reported as `global` in `find_plugin`.
- **Observers:** declarations without `instance` (disabling or changing an observer) were dropped, area disables were not shown, and an observer class could be mapped to another module's file with the same short name. `find_event_flow` listed semantic neighbours as "dispatchers"; it now lists exact `dispatch('event')` calls. `find_event_dispatchers` counts only this event's observer declarations.
- **`find_table_usage` missed the ResourceModel that owns the table** (`_init('table', …)`); PHP and `db_schema.xml` are also searched for the exact table name.
- **`find_controller` returned nothing for admin routes** (the area filter compared `/adminhtml/` with `Controller/Adminhtml/`); routes are also resolved through `routes.xml` (frontName → module → controller class).
- **`find_implementors` listed only classes whose `implements` names the interface**, missed subclasses, implementors of extending interfaces and preferences whose attributes are in `type`/`for` order, and counted commented-out preferences. For a FQCN it now returns everything that is `instanceof` the type, transitively, from a reverse class hierarchy built once per session.
- **PHP declarations are read robustly:** group and multi-imports (`use A\\{B, C as D};`, `use A, B;`), aliases, declarations split over several lines, comments between the parts; a trait `use` inside a class body is not taken for an import; namespace aliases with relative names (`use A\\B as C;` … `implements C\\X`), enums implementing interfaces, block namespaces (`namespace X { … }`) and case-insensitive keywords.
- **Plugin `disabled="1"` / `"0"`** is read like `true` / `false` (`BooleanUtils`, as Magento does). For observers only `disabled="true"` disables — Magento's events converter ignores `"1"`.
- **A relative `MAGENTO_ROOT` produced non-existent file paths** (the root segment was cut out). It is resolved to an absolute path at startup.
- **Configuration outside the modules could override them.** `app/etc/di.xml` — the primary scope, which Magento reads before any module — was ranked after the modules, so a module preference for an interface also declared there lost (`Magento\Framework\App\ScopeResolverInterface` was reported as `…\ScopeResolver` instead of `Magento\Store\Model\Resolver\Store`); and a di.xml Magento never reads (a `dev/tests/integration/tmp/sandbox-*` or `magento2-base` copy of app/etc) could win over every module. app/etc now comes first; files outside app/etc and the modules rank last.
- **A `<!--` inside a CDATA value hid the di.xml declarations after it** (up to the next comment) from the DI tools.
- `find_plugin` labels its semantic block (`Similar plugin code (semantic, not filtered by targetClass)`); only the DI sections are resolved against `targetClass`.

## [2.17.0] - 2026-09-29

### Added
- **The Linux binaries run in Warden / DDEV PHP containers.** x64 and arm64 now link libstdc++ statically, so they no longer need the build host's `GLIBCXX_3.4.30` (x64) or GCC 14's libstdc++ and glibc 2.38/2.39 (arm64); the floor is glibc 2.34 for both (CentOS Stream 9, RHEL 9, Debian 12, Ubuntu 22.04+). The release now fails before publishing when the x64 binary links libstdc++ dynamically or does not start on CentOS Stream 9, or when the arm64 binary needs a glibc newer than 2.34.

### Changed
- **Incremental indexing compares content, not only timestamps.** The manifest (`.magector/index.manifest`, format v2) stores a SHA-256 per file. A file whose mtime or size changed but whose content is identical — every file after a fresh checkout, `COPY` or `docker cp` — is recorded as "touched" and not re-embedded, by `index` and by the `serve` file watcher. `📊 Incremental:` gains a `(T touched: mtime changed, content identical)` count.
- **v1 manifests load and migrate**; the first run records hashes for unchanged files (`🔐 Recorded content hashes for N unchanged files`). 2.16.x cannot read v2 and rebuilds the manifest treating indexed files as current — after a downgrade, run `magector index --force` if files changed since.
- **`MAGECTOR_DB` defaults to `$MAGENTO_ROOT/.magector/index.db`** (was `./.magector/index.db`, relative to the process cwd), so an MCP server started outside the Magento root finds the index, and `magector index <path>` keeps its database under `<path>`. **Upgrade note:** if you ran magector with `MAGENTO_ROOT` set from another directory, move that directory's `.magector/index.db` and `index.manifest` into `$MAGENTO_ROOT/.magector/` (or set `MAGECTOR_DB`); otherwise the first start re-indexes from scratch. `magector index <path>` users: the database used to land in the current directory's `.magector/`; move it into `<path>/.magector/` (and set `MAGENTO_ROOT=<path>` for `search`/`stats` run from elsewhere).
- **A missing model is downloaded into `MAGECTOR_MODELS` when it is set** (was always `~/.magector/models`); `init` and `setup` write `MAGECTOR_MODELS` (absolute) into the MCP config when it is set. The lookup order is unchanged.
- **Resume and `serve` scans skip what a full index skips** — `vendor/bin`, `pub/static`, `dev/tests`, `dev/tools` and `.magectorignore` patterns. The first run after upgrading may report files under those paths as deleted and drop their vectors.
- **A run that changes nothing leaves `index.db` untouched** (`✓ Index unchanged — index.db not rewritten`), and a saved index is verified by counting the vectors in the written file instead of reloading it (save + verify of a 42k-vector index: 92.8 s → 0.3 s on 2 threads).
- **Library (magector-core):** `Indexer::index()` / `index_with_options()` no longer write the manifest — save `index.db` when `IndexStats::db_changed` is set, verify it, then call `Indexer::save_manifest()`. `Indexer::save` / `save_atomic` take `&mut self`. A manifest that cannot be written only warns (the next run rebuilds it).

### Fixed
- **The manifest could claim content `index.db` did not hold, so files stayed stale or missing for good once hashes were trusted.** The manifest is now written only after `index.db` is saved and verified; `index` marks the files it is about to change stale first (a crash after a periodic save re-embeds them); a full rebuild (`--force`, first index) withdraws the old manifest right before its first `index.db` write (a rebuild interrupted earlier leaves the old index and manifest intact); the `serve` watcher and `describe` mark every file they re-embed or remove stale, and remove a manifest they cannot read. A file that already had vectors but no manifest record is replaced instead of embedded twice.
- **The MCP background re-index left the old `index.manifest` next to the new `index.db`** (and orphaned `index.db.manifest`). The swap now removes the old manifest first and moves the new one along; it refuses a re-index that wrote no `index.db.new` (which used to strand the live index as `index.db.bak`), puts the old index back when the new one cannot be renamed in, keeps the re-index lock until the swap is done, and logs what actually happened. An extension-less `MAGECTOR_DB` no longer shares its manifest with the temp DB. The server says "No index found" instead of "Database format incompatible" when there was no index.
- **A partially downloaded model file was kept as valid forever.** Downloads go to `<file>.part` and are renamed only when complete (checked against `Content-Length`).
- The `Incremental:` unchanged count no longer subtracts deleted files and can no longer wrap to a bogus number (a debug build panicked); the "no manifest" line now distinguishes a missing manifest from an unreadable one.

## [2.16.28] - 2026-09-23

### Fixed
- **If the `serve` process died (OOM, manual kill, crash), the primary MCP instance never restarted it, and secondary instances never noticed the primary was gone — every query fell back to the cold path (rebuilding the entire HNSW index on all CPU cores, ~40s each) until every session was restarted.** The primary's `serve` exit handler only reset in-memory state; it never respawned the process, so its socket proxy kept accepting connections from secondary instances but had nothing behind it to answer them. Secondaries, in turn, made exactly one reconnect attempt 5s after losing the socket and then gave up permanently, never trying to become primary themselves. The primary now respawns `serve` after an unexpected exit (not during its own shutdown, and not for a deliberate restart such as after a re-index), rate-limited to at most 3 respawns within 10 minutes with a growing delay (5s, 10s, 15s); once that budget is exhausted it releases the primary lock and closes the socket proxy (dropping any still-connected secondaries) so one of them can take over, and retries becoming primary itself once after a cooldown. A secondary that loses its socket now retries every 5s for about 30s — first trying to reconnect (another instance may already have taken over), then trying to acquire the primary lock and start its own `serve` process — before settling into a slow 60s poll instead of staying on the cold fallback forever; the same retry now also runs when a secondary never managed to connect at startup at all. Related hardening: the socket proxy now starts from `serve`'s own "ready" signal itself — the one place that fires no matter which path got `serve` running (first start, a crash respawn, or a restart after re-indexing) or how long it took, instead of a single fixed-window race after the first start that could miss a 45-60s HNSW rebuild, a re-index-triggered restart, or a fresh install with no index yet, any of which used to leave the lock held with no proxy ever starting and every query going cold for the rest of that primary's life. Both the proxy and the local search/stats calls now wait up to ~75s for an in-flight (re)load instead of only when a local `serve` process object currently exists — during the few seconds between an exit and its scheduled respawn there was none, so both the primary's own queries and every connected secondary's proxied queries went cold in parallel with `serve` coming back up; the secondary's own socket timeout was raised to match so it doesn't give up first while the proxy is still legitimately waiting. Also: a primary re-acquiring its own already-held lock no longer fails; in-flight queries are failed cleanly instead of silently misrouted when `serve` exits; a primary momentarily without a local `serve` process (mid-respawn delay) no longer connects to its own socket proxy in a self-referential loop; and a deliberate restart (after re-indexing) now escalates to SIGKILL if `serve` doesn't exit within 15s, instead of potentially never spawning a replacement.

## [2.16.27] - 2026-09-23

### Fixed
- **The `serve` watcher re-indexed the same zero-vector files forever and rewrote the entire index on every tick even when nothing changed** — a file matching `INCLUDE_EXTENSIONS`/size limits but producing zero index entries (empty, unparseable, or otherwise yielding no vectors) was never recorded in the watcher's file manifest, since only files that produced at least one vector were tracked. `detect_changes` therefore reported it as "added" on every single scan, forever, and each tick that "indexed" it still called `save_atomic()` — rewriting the whole `index.db` — even though nothing in the vector DB had actually changed. On a long-running `serve` process against a real Magento install this meant a multi-hundred-MB index was rewritten every `--watch-interval` (default 5 min) around the clock: hundreds of gigabytes of disk writes and multi-GB memory growth over several days, with no corresponding index change. Zero-entry (and whole-chunk-error) files are now recorded in the manifest with empty `vector_ids` so they stop being re-reported after the first attempt (a later edit still re-triggers them via the mtime/size check), and the watcher only calls `save_atomic()` when a tick actually added or removed vectors or triggered compaction.

## [2.16.26] - 2026-09-17

### Fixed
- **`magento_stats`/`magento_search` could still ETIMEDOUT right after MCP startup, on the exact large index the previous fix targeted** — the socket-first fallback only waited 10s for a starting `serve` process before giving up and running the cold `execFileSync` path, which itself was still capped at the same too-short 30s timeout. On an index whose HNSW rebuild takes 45-60s, both numbers were wrong: the 10s wait rarely caught serve becoming ready, and the cold path it fell back to needed 120s of headroom (matching what `checkDbFormat()`'s own equivalent stats call already used), not 30s. This also meant the cold fallback would collide with `checkDbFormat()`'s own concurrent startup stats process, doubling the CPU cost for no benefit. Both wait windows are now 60s and both cold-path timeouts are now 120s.

## [2.16.25] - 2026-09-17

### Fixed
- **`magento_stats` reliably timed out on large indexes, even with a warm `serve` process already holding the answer in memory** — the tool always ran the cold `magector-core stats` path (`execFileSync`, hardcoded 30s timeout), which reopens the database and rebuilds the *entire* HNSW graph from the flat vector list just to report a count. `checkDbFormat()`'s own log message already warns "this takes 30-60s for large indexes", so on anything past roughly 150k vectors the call was guaranteed to exceed its own 30s timeout. `magento_search` already had a socket-first fallback (`rustSearchAsync`) for the same reason; `magento_stats` (and the `magector://stats` resource) now use the equivalent `rustStatsAsync`, which asks the already-running `serve` process directly over its socket (the `"stats"` command already existed server-side, just unused from this call site) and only falls back to the cold path when no warm serve process is reachable.

## [2.16.24] - 2026-09-17

### Fixed
- **The `serve` process's own in-process file watcher never checked the `.magector/reindex.pid` lock, so it could race a manually-invoked `npx magector index` on the same root** — the lock added in the previous entry closed the gap between the CLI and an MCP server's *background reindex*, but `serve`'s `watch-interval` loop is a third, independent writer: it runs inside the long-lived `magector-core serve` process, shares nothing with the JS lock file, and calls `save_atomic()` on the same `index.db` on its own schedule. In practice this fired right after a large `composer install` populated thousands of new vendor files: the watcher's own scan detected them and started embedding at the same time as an unrelated `npx magector index` run, both writing to the same file — the exact clobbering failure mode from the previous entry, through a path that lock didn't cover, and burning double the CPU/RAM while at it. The watcher loop now checks the same `.magector/reindex.pid` lock before touching the index and defers the cycle (re-checking next tick) whenever an external indexer holds it.

## [2.16.23] - 2026-09-17

### Fixed
- **A manually-invoked `npx magector index` racing an MCP server's background reindex on the same Magento root could silently clobber a completed multi-hour index with an empty one** — a full reindex ran to completion, logged "INDEXING COMPLETE" with the correct vector count, and `save_atomic()` returned success, but the file on disk afterwards decoded to 0 live vectors and returned no search results. `startBackgroundReindex()` already tracked a `.magector/reindex.pid` lock, but only against *other MCP-orchestrated* reindexes — a bare `npx magector index` (or a raw `magector-core index` invocation) never checked or wrote that lock, so nothing stopped it from running at the same time as a background reindex against the same root and overwriting each other's output between one process's atomic rename and its own belief that the write had succeeded. This closes the gap noted as a known follow-up in the previous entry: `npx magector index` now acquires the same `.magector/reindex.pid` lock (shared via `src/index-lock.js`) and refuses to start — with a clear error naming the conflicting PID — while another indexer holds it.
- **A corrupted/clobbered save was still reported as "Indexing complete"** — belt-and-suspenders for the above and any other silent-corruption path: `magector-core index` now reopens the database immediately after `save_atomic()` and errors out if the reloaded vector count doesn't match what was just built in memory, instead of trusting a successful write call.

## [2.16.21] - 2026-09-16

### Fixed
- **A read-only `stats` or `search` call deleted the entire index whenever it could not be decoded** — `VectorDB::open()` treated any decode failure as a schema change, ran `fs::remove_file()` on the database and returned an empty index. Two things made that destructive rather than merely helpful: the underlying bincode error is not specific to a schema change (a truncated write from an interrupted save produces the same error), and `stats` and `search` — commands a user has every reason to read as non-mutating — go through the same `open()` path. An index representing hours of CPU was therefore removed by the very command used to inspect it, with `Total vectors: 0` as the only visible clue, which looks like an index that was never built rather than one just deleted. Restoring a backup then appeared not to work either, because the next `stats` deleted the restored copy as well. Any index written before the bincode 1.3 → 2.0 upgrade hits this on every command, since its version byte is 2 while `PERSIST_VERSION_V2` is now 3. The file is now moved aside to `<db>.incompatible-<unix-ts>` instead of being deleted, so the data survives for recovery and a re-index still starts from a clean slate.

## [2.16.20] - 2026-09-16

### Fixed
- **A concurrent MCP instance could promote an unfinished temp index as if it were complete** — the secondary-instance poller in `startBackgroundReindex()` treated "external reindex PID is gone" plus "a `.new` file exists" as proof of a finished index and swapped it straight into place. That was safe only because, until the fix above, a `.new` file could never survive an interruption. Now that partial temp DBs are deliberately kept around for resume, the poller instead takes ownership and resumes/finishes the reindex itself, only swapping once its own run actually completes (exit code 0).

## [2.16.19] - 2026-09-16

### Fixed
- **Every background re-index discarded all progress at startup, so indexing a large codebase could never finish across multiple short MCP sessions** — `magector-core` saves the index incrementally to the temp path (`index.db.new`) and auto-resumes from it, but `startBackgroundReindex()` unconditionally deleted that temp DB the moment a new reindex was scheduled, before checking whether it held resumable progress from a run that was simply interrupted by the previous MCP session ending (the normal case for a short-lived session against a codebase too large to index in one sitting). Every new session therefore restarted PHASE 1 from file 0, never converging on a usable index. That unconditional delete-at-start is now removed. The `reindexProcess` exit handler was also tightened to only discard the temp DB on a genuine failure (non-zero exit with no signal), not when the process was killed — though in practice the OS-level kill from `cleanup()` on session shutdown usually races Node's own `process.exit()`, so it's this startup fix, not the exit-handler change, that resolves the reported failure to index.

## [2.16.18] - 2026-09-03

**First release published to npm since 2.16.15.** 2.16.16 and 2.16.17 were version-bumped and tagged but never reached npm — the publish job still authenticated with the long-lived `NPM_TOKEN` secret and could not publish, which is what prompted the move to OIDC below. Everything documented under those two versions therefore reaches users here.

### Fixed
- **`magector-core stats` process orphaned on shutdown, one leaked core per MCP session** — `checkDbFormat()` spawns `magector-core stats` to validate the index and guards it with a 120 s timeout, but that timeout only fires while the MCP server is alive. `cleanup()` tracked `serveProcess` and `reindexProcess` and not this one, so when the parent exited before the timeout elapsed the stats child was never killed: it reparented to init and kept running. This is easy to hit with a short-lived session against a large index — the format check takes 30–60 s (longer on big indexes) while an agent asking a single question connects and disconnects in seconds, so every such session left a `magector-core` process behind, each consuming a core. Several were observed accumulating on a production box, one per question asked, none ever exiting. The process is now tracked so `cleanup()` can kill it, and the timeout is cleared when it exits on its own. (PR #4, Rudolf Vince)

### Changed
- **Releases publish via npm trusted publishing (OIDC) instead of `NPM_TOKEN`** — removes the long-lived token secret from the publish job, so releases no longer depend on a credential that has to be rotated by hand, and gets ahead of npm's restrictions on 2FA-bypassing tokens (account changes August 2026, direct publishing January 2027). The publish job also pins the npm CLI version instead of installing `@latest`, so a CLI release cannot change publish behaviour underneath the pipeline.

## [2.16.17] - 2026-09-03

Tagged locally during the OIDC publishing migration but **never pushed and never published to npm**; its contents (the orphaned-process fix and the trusted-publishing switch) shipped in 2.16.18. Recorded here only so the version sequence has no silent gap.

## [2.16.16] - 2026-07-22

### Fixed
- **Watcher never persisting a large incremental backlog — index stuck, queries timing out** — `watcher_loop` indexed the *entire* detected changeset in one `index_files()` call while holding the indexer lock, then saved to disk exactly once at the very end. When the backlog was large (e.g. the first watcher run against an index that predates tens of thousands of new files, or a big dependency install), that single call could take far longer than the MCP server stays alive. The process was killed before reaching the save, so **nothing was written to disk** — every restart rebuilt the initial manifest from the same incomplete index, re-detected the identical "N added" files, and re-started the doomed re-index, never converging. Meanwhile the lock was held for the whole multi-minute run, so concurrent search queries timed out and uncached searches returned 0 results. The watcher now indexes added/modified files in bounded chunks (`WATCHER_INDEX_CHUNK = 512`): it persists with `save_atomic()` after each chunk — so an interrupted process keeps its progress and resumes from where it left off instead of re-detecting everything — and releases the indexer lock between chunks so searches stay responsive while a backlog drains. Tombstoning of deleted/modified vectors and the final compaction/save are unchanged in effect (a delete-only tick and post-compaction state are still persisted). This mirrors the incremental-save pattern the full `index()` path has used since the start (`SAVE_INTERVAL_BATCHES`).
- **`git clone` + `npm install` pulled an incompatible Rust core, re-indexing on every startup** — the committed `package.json` pinned the platform binary packages (`@magector/cli-{os}-{arch}`) in `optionalDependencies` to a stale version (`1.2.7`, whose binary reports `0.1.0`) while the JS wrapper had advanced to `2.16.15`. The release pipeline rewrites those pins to the release version at publish time, but that change lived only in the published tarball and was **never committed back to git** — so the tree drifted further behind on every release. Installing from a git checkout therefore fetched a Rust core with no `serve` subcommand and the old index-file naming: the wrapper's `rename index.db.new → index.db` swap failed with `ENOENT`, the persistent `serve` process could not start (`unrecognized subcommand 'serve'`), and the server fell back to "no index database" and launched a full multi-minute re-index on **every** startup, never persisting anything. npm-installed users (`npx magector@latest`) were unaffected because their tarball carried the synced pins. Fixed by committing pins that match the package version and adding a `version` npm lifecycle hook so future `npm version` bumps keep them in lockstep in git — not just in the published artifact.

### Added
- **`watcher::tests::test_chunked_apply_persists_partial_progress`** — regression test for the backlog-persistence fix. Models the chunked update against a temp tree of 5 files: applies the manifest update for the first chunk only (simulating a crash mid-backlog), asserts that exactly the unprocessed files are re-detected as "added" on the next scan (durable partial progress, not all-or-nothing), and that applying the remainder converges `detect_changes` to empty.
- **`scripts/sync-optional-deps.mjs` + `version` npm lifecycle hook** — the script rewrites every `optionalDependencies` pin to `package.json`'s `version` and is wired into the `version` script (`node scripts/sync-optional-deps.mjs && git add package.json`), so `npm version <bump>` commits matching binary pins automatically. This is the single source of truth the release pipeline already applied at publish time, now enforced in git so a `git clone` install can never fetch a mismatched Rust core again.
- **`testSyncOptionalDeps` (tests/unit.test.js)** — covers the pure `syncOptionalDeps()` transform (all pins bumped, input not mutated, key order preserved, missing `optionalDependencies` handled) and adds a regression guard asserting the committed `package.json` pins all equal its `version` and that the `version` hook is wired. This guard fails the moment the pins drift again.

## [2.16.15] - 2026-04-15

### Fixed
- **`magento_trace_flow` blocked during background re-index even when structural data is available** — `magento_trace_flow` was missing from the `indexFreeTools` allowlist, so any call during warmup or background re-indexing was rejected with "Re-indexing in progress and no previous index available". After v2.16.14's structural-first GraphQL parser (and the pre-existing filesystem-based paths for `event`/`cron`/`api` via `findDiWiring()` and XML parsing), `trace_flow` produces valid data without a search index for most entry types, so the hard block was too aggressive. Added `magento_trace_flow` to `indexFreeTools`. The existing empty-trace guard in the handler (added in v2.16.11) already appends a clear `⚠️ Re-indexing in progress` warning when a given trace genuinely depends on semantic search and comes back empty, so agents still get actionable feedback without the tool being silently unusable.

### Added
- **`tests/trace-graphql.test.js`** — deterministic fixture-based integration test for the v2.16.14 `traceGraphql()` fix. Builds a minimal `.graphqls` + resolver PHP + `di.xml` fixture under `tests/tmp_graphql_trace/`, spawns the MCP server against it via stdio JSON-RPC, and asserts the full response shape across 19 test cases: schema array, resolver class extraction (escaped/bare backslashes, leading-backslash variant, `@doc` directive between signature and `@resolver`), resolver PHP file resolution on disk, `resolve()` method snippet extraction, deep-mode plugin discovery via `findDiWiring()`, and graceful handling of unknown operations. Runs without an index (structural-first path is filesystem-based). Wired into `npm test` and available as `npm run test:trace-graphql`.

## [2.16.14] - 2026-04-15

### Fixed
- **`magento_trace_flow` returning empty trace for GraphQL operations** — `traceGraphql()` relied exclusively on semantic vector search (`graphql ${name} mutation query`, `${name} resolver`) to locate the schema and resolver. For short, specific operation names like `addSimpleProductsToCart`, `addProductsToCart`, or `placeOrder`, the embeddings don't carry enough context to reliably surface the `.graphqls` file or `/Resolver/` class, so the tool returned `{"trace": {}}` and forced agents to fall back to manual `magento_find_plugin` + `magento_find_class` + `Read` + `Grep` (≈10 tool calls). `traceGraphql()` now parses `**/etc/**/*.graphqls` files structurally, extracts the `@resolver(class: "…")` directive (handling both escaped `\\\\` and bare `\\` namespace separators, leading-backslash variants, `@resolver (…)` with space, multi-line operation signatures, and schema extensions that redeclare the same operation in multiple modules), resolves the resolver class on disk, reads the `resolve()` method body, and — in `deep` mode — walks `di.xml` via `findDiWiring()` to surface plugins and preferences on every resolver class found. Semantic search is retained as a fallback when no schema match is located. Matches the same structural-first pattern already used by `find_observer` (events.xml) and `find_plugin` (di.xml).

## [2.16.13] - 2026-04-15

### Fixed
- **Panic in `sona.rs:254`** (index out of bounds) — `EwcRegularizer::update_fisher` could panic when `fisher` or `star_weights` had dimensions that did not match the flattened `MicroLoRA`. The 2.16.11 fix reset corrupted `MicroLoRA` on load but left the EWC state untouched, so a reset LoRA combined with stale `star_weights` (e.g. `len 44`) produced an out-of-bounds access on the first `learn_with_embeddings` call. Added `EwcRegularizer::is_valid()`, validated EWC dimensions in `SonaEngine::open()`, reset EWC whenever LoRA is reset (to keep them in sync), and made `update_fisher`/`penalty`/`regularize` no-op-or-reset instead of panicking when dimensions disagree.
- **Watcher thread dying after an unrelated panic** — `watcher_loop` called `indexer.lock().unwrap()` (and `status.lock().unwrap()`), which propagated `PoisonError` when another handler (e.g. `feedback`) panicked while holding the lock. The watcher thread died and no further incremental indexing happened until the MCP server was restarted. Replaced all `lock().unwrap()` call-sites with a `lock_recover` helper that logs a warning and continues with `poisoned.into_inner()`.

## [2.16.11] - 2026-04-14

### Fixed
- **Search returning 0 results after indexing** — zero vectors (from empty/binary files that produce no tokens) and NaN/Inf embeddings (from ONNX model edge cases) were inserted into the HNSW graph. Cosine distance with a zero-norm vector produces NaN, which corrupts the HNSW graph structure and makes all searches return empty results. Embedder now replaces zero vectors with a small uniform vector and rejects NaN/Inf embeddings. VectorDB validates vectors before HNSW insertion (both at index time and when loading from disk), tombstoning invalid entries instead of corrupting the graph.
- **Panic in `sona.rs:130`** (index out of bounds) — MicroLoRA arrays loaded from an incompatible sona.db file could have wrong dimensions, causing out-of-bounds access in `forward()`. Added `is_valid()` dimension check on MicroLoRA; `forward()` and `update_from_signal()` now return unchanged data instead of panicking when dimensions are wrong. `SonaEngine::open()` catches deserialization errors and resets to defaults instead of propagating the error.
- **search/trace_flow silent empty results during re-indexing** — `magento_search` and `magento_trace_flow` now include a progress warning in their output when re-indexing is in progress. `trace_flow` detects empty traces during reindex and reports a clear message instead of returning `{}`.

### Added
- **bge-small-en-v1.5 query prefix** — search queries now use the `"Represent this sentence: "` prefix recommended by the BGE model for retrieval tasks. Documents are embedded without prefix (as before). This improves retrieval accuracy by signaling the model that the input is a search query, not a document.
- **`argumentInjections` in `magento_trace_dependency`** — detects when a class/interface is injected as a constructor argument value inside `<type>` or `<virtualType>` blocks (via `xsi:type="object"` arguments and `<item>` elements). Previously only detected `<preference>`, `<plugin>`, and direct `<virtualType type="...">` declarations. New section "Argument Injections" appears in the formatted output.

## [2.16.9] - 2026-04-14

### Fixed
- **Socket proxy search always timing out** — `globalServeQuery` (used by secondary MCP instances connecting to an existing serve process via Unix socket) had no default `timeoutMs` parameter. When callers like `rustSearchAsync` omitted the third argument, `setTimeout(fn, undefined)` resolved to a 1ms timeout — causing every socket search query to fail instantly with "Socket query timeout" and fall through to the 20-second `execFileSync` cold-start fallback. Added `timeoutMs = 30000` default parameter and `|| 30000` safety fallback in `processSocketQueue`. This restores sub-second search response for all secondary MCP instances.

## [2.16.8] - 2026-04-14

### Added
- **New tool: `magento_trace_config`** — traces a Magento config path end-to-end: finds the `system.xml` admin definition (label, type, source_model, comment), PHP classes that read the value (with constant names and consuming methods), and actual database values from config-data exports. Accepts either an exact config path (`acme_marketplace/payments/payment_methods`) or a keyword search (`marketplace_payment`). Available in `magento_batch`.
- **Config-data exports** — one-time JSON exports of `core_config_data` stored in `.magector/config-data/{env}.json` (e.g., `CZ-production.json`). The `magento_trace_config` tool automatically looks up actual values from all available exports and shows them per environment with scope information.
- **`excludeModuleFilter` parameter on `magento_search`** — inverse of `moduleFilter`. Removes results from specified vendor/module patterns. Same pattern syntax (wildcards, vendor prefix matching). Useful when you know which modules are irrelevant to your search.

### Fixed
- **`moduleFilter` returning 0 results for less-popular modules** — when `moduleFilter` was specified, semantic search only fetched 30 results before applying the post-filter. If the target modules weren't in the semantic top-30, filtering returned nothing. Now fetches up to 200 results when `moduleFilter` is present, ensuring modules with lower semantic ranking are still found.

## [2.16.6] - 2026-04-14

### Changed
- **`magento_find_plugin` sub-namespace discovery** — when searching for plugins on a short class name like `Payment`, the DI scan now also finds plugins registered on sub-namespace types (e.g., `Payment\State\CaptureCommand`, `Payment\Operations\CaptureOperation`). Previously only types whose last namespace segment matched were found. Sub-namespace matches include full method bodies for all intercepted methods (not filtered by `targetMethod`), since the intercepted method name typically differs from the searched method. Results appear in a separate "Plugins on sub-classes" section. Both standalone and batch handlers updated. DI registration limit raised from 8 to 12 in batch to accommodate the broader discovery.

## [2.16.5] - 2026-04-13

### Fixed
- **`magento_ast_search` / `magento_find_dataobject_issues` missing `magento_root`** — `astSearch()` sent the `ast_query` serve command without the `magento_root` field, so the Rust handler always responded with `Missing 'magento_root' field`. Both tools now pass `config.magentoRoot` through to the serve process. This restores detection of the `DataObject::setX(null)` anti-pattern and arbitrary tree-sitter pattern queries.

## [2.16.4] - 2026-04-13

### Fixed
- **Secondary instance reconnects to serve socket automatically** — when a secondary MCP instance couldn't connect to the serve socket at startup (socket didn't exist yet — primary was still re-indexing), it stayed on slow `execFileSync` fallback for the entire session. After the primary completed re-indexing and restarted its serve process, the secondary never retried the socket. Now `rustSearchAsync` attempts socket reconnection before each cold-start fallback if not yet connected as a secondary. This prevents 30–44s timeout failures on search after re-indexing completes.

## [2.16.3] - 2026-04-13

### Fixed
- **Stale empty cache after re-index** — after a background re-index, `magento_search` could return 0 results due to `[]` entries cached during the period when the index was unavailable. The search cache is now explicitly cleared when the serve process signals ready (both when the primary process starts its own serve process and when a secondary connects via socket proxy). Previously the cache was only cleared at re-index start, leaving a window where empty results could be re-cached during the serve warmup period.

## [2.16.2] - 2026-04-13

### Added
- **Re-index progress notification** — all tool responses now include a banner when a background re-index is running. The banner shows elapsed time, current phase (1/3 AST parsing, 2/3 embeddings, 3/3 HNSW build), file/item count, and an estimated time remaining. Derived from real-time parsing of the Rust indexer log output (`Found N files`, `PHASE 1/2/3`, `Items to embed: N`). Previous index remains active during re-index so results stay valid; the banner clarifies they may miss recently added files. Secondary MCP instances (spawned after a session restart during re-index) detect the ongoing re-index via the `reindex.pid` file and show a simpler banner noting that semantic search may be unavailable.

## [2.16.1] - 2026-04-13

### Fixed
- **`magento_find_dataobject_issues` crash** — calling this tool before the serve process was ready threw `Cannot read properties of null (reading 'stdin')`. The `serveQuery()` function now guards against a null or not-yet-ready serve process and returns a graceful error instead of crashing.
- **`magento_module_structure` mixes cross-references** — vector search returned results from unrelated modules (e.g. a 100-file result set containing references from other modules). Now uses filesystem glob as primary source (`app/code/{Vendor}/{Module}/` then `vendor/{vendor}/{module-hyphenated}/`), falling back to vector search only when no files are found. Vendor-specific path matching prevents false positives from same-named modules of different vendors.
- **`magento_find_config` unavailable inside `magento_batch`** — the tool was not implemented in the batch handler, causing `Unsupported batch tool: magento_find_config` errors. Now fully supported in batch with `configType` filtering.

### Changed
- **`magento_search` description** clarifies that semantic search may return 0 results for small custom/proprietary modules whose names are not well-represented in the embedding model. Recommends using `magento_grep` for such modules.
- **`magento_find_null_risks` description** notes that `magento_enrich` is triggered automatically in the background after `magento_index` completes.
- **`magento_batch` description** now lists all 19 supported tools explicitly, preventing confusion about which tools can be batched.

## [2.16.0] - 2026-04-13

### Changed
- **Unified SQLite database** — three separate files (`sqlite.db`, `enrichment.db`, and meta files) consolidated into single `.magector/data.db`. New `datadb.rs` Rust module handles all metadata: LLM descriptions, method-chain enrichment, process state, and cache. Enrichment logic moved from Node.js to Rust serve process, eliminating `node:sqlite` dependency (Node.js 18+ sufficient again).
- **Tree-sitter queries replace semgrep** — `magento_ast_search` now uses tree-sitter S-expression queries executed in Rust instead of spawning external `semgrep` subprocess. Named patterns (`dataobject-set-null`, `unchecked-method-chain`) stored as `.scm` files in `rust-core/queries/`. Zero external dependency. Pattern arg changed from free-text to enum.
- **Rust grep-searcher replaces GNU grep subprocess** — `magento_grep` delegates to in-process Rust text search (using `regex` + `walkdir`) via new `grep` serve command. Cross-platform (Windows works without GNU grep). Falls back to external GNU grep during cold-start.
- **Embedding model: bge-small-en-v1.5** — replaces all-MiniLM-L6-v2 (+4 MTEB points: 58 → 62.2, same 384 dimensions). Existing indexes require re-indexing.
- **bincode 2.0** — serialization upgraded from bincode 1.3. Better forward-compatibility via explicit `Configuration`. Index format version bumped → auto re-index.
- **ureq replaces reqwest** — synchronous HTTP client for model download. ~850 KB smaller binary, no async runtime overhead.
- **Consolidated `.magector/` layout** — directory now contains 4 files: `data.db`, `index.db`, `serve.sock`, `magector.log`. PID files, format cache, and primary lock stored in SQLite state tables with file fallback for cold-start.

### Removed
- `node:sqlite` dependency — Node.js 18+ sufficient (was 22.5+)
- `semgrep` external dependency — tree-sitter handles all AST queries
- External GNU `grep` requirement (kept as cold-start fallback)
- `reqwest` Rust dependency (~265 fewer lines in Cargo.lock)

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
- **`magento_module_structure` camelCase hyphenation** — vendor path matching now correctly hyphenates camelCase module names (`OrderSplit` → `module-order-split/`). Previously, `AcmeCorp_OrderSplit` would look for `module-ordersplit/` which doesn't exist.
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
