# DI / event resolution — open items (TODO)

Follow-ups to the structural DI / event resolution (`src/di-config.js`). Verification against a
Magento installation: `scripts/verify-magento/`.

## A2. Structural answers — done: `find_api`, `find_graphql`, `find_cron`, `find_db_schema`, `module_structure`

Verified against the installation and against Magento's readers on a synthetic fixture
(`docs/verification.md`). Found on the way, still open:

| # | Item |
|---|------|
| A13 | Cron: jobs / schedules from `core_config_data` are only noted (they are not in any file). |
| A15 | **Class lookup reads only composer's PSR-4 map** — `autoload_classmap.php` and PSR-0 (`autoload_namespaces.php`) are not read. On the project 1,475 classes load only through the classmap (mostly dev tools, also `Cm_Cache_Backend_Redis`, `Credis_Client`); 67 of them have no namespace and a file named differently from the class, so the file-name fallback does not find them either → a class hierarchy through them is cut (inherited plugins can be missed). Fix: read both maps; verify against `Composer\Autoload\ClassLoader::findFile()` for every class. |
| A16 | Cron (adversarial review): the `system/default/crontab` of app/etc/config.php and env.php is not read (only config.xml); several `<default>` / `<crontab>` nodes in one config.xml — only the first is read; a later `<schedule>` holding a comment does not replace the earlier one in Magento (Magector replaces it). |
| A17 | webapi (review): two routes whose url differs only by surrounding whitespace are separate DOM nodes in Magento, and the last wins whole; Magector merges them. |
| A18 | GraphQL (review): a duplicate definition swallowed into another type's chunk replaces the earlier one in Magento, Magector merges them (more, not less); escapes inside a block string (triple quotes) in `@resolver(class: …)`. |
| A19 | XML attribute values: libxml turns tabs / newlines into spaces, `parseXml` keeps them (e.g. db_schema comments). |
| A20 | Returns more, harmless: `implements` forms Magento does not recognise (one-letter interface name, leading `&`); `<schedule>0</schedule>` (Magento drops it); two indexes with the same generated name (Magento keeps the last); a foreign key to a table on another shard (Magento skips it). |

## A3. Performance (measured on the project, see docs/verification.md)

Done: module discovery from the registrations and one listing of the modules' etc/ instead of a walk of
the tree per pattern (each walk ~1 s); applyModuleOrder computed a file's module per comparison (1.6 s of
a 2.8 s first call); `find_observer` no longer searches dispatchers (4.9 s per call); the PHP file list
is reused for `MAGECTOR_PHP_LIST_TTL_MS` (30 s). First call now 0.15–0.5 s, repeated calls 8–110 ms for the DI / event /
config tools.

Still slower than grep on a first call (everything reads all PHP files):

| # | Tool | First call | Repeat |
|---|---|---|---|
| P1 | `find_implementors` (class hierarchy) | 8.0 s | 1 ms |
| P2 | `find_event_flow` / `find_event_dispatchers` | 3.0 s | 0.45 s |
| P3 | `impact_analysis` | 2.5 s | — |
| P4 | `find_callers` | 1.7 s | — |
| P5 | `find_di_wiring` | 1.2 s (after the DI model) | — |

Fix: an index of PHP files by content (declared types, extends / implements, dispatch() names) stored
beside the vector index and refreshed by mtime, so a session does not re-read 73k files. Until then the
class hierarchy behind `find_implementors` is built once per session (a class added mid-session is not
seen until restart).

## B. Decision needed

| # | Question | Now | Proposal |
|---|----------|-----|----------|
| B1 | composer `require` as a dependency for the ambiguity check | counts like `<sequence>` | Magento orders modules **only** by `<sequence>`; `require` does not affect load order → report "order held only by composer require" as a weaker warning instead of hiding it |

## C. Not fixed — returns less (narrower)

| # | Item |
|---|------|
| C1 | `find_callers`: calls through factory-created instances (`$f->create()->x()`) and untyped variables |
| C2 | `trace_flow` deep for GraphQL stops at the resolver (does not follow the injected service → preference → plugins) |
| C3 | Remaining regex readers: `trace_shipping_chain`, `trace_api`, `trace_call_chain` (only comment stripping applied); semantic-only: `find_config`, `find_template`, `find_block`, `find_trigger`, `performance_profile` |
| C4 | Generated classes (`generated/`: Factory, Proxy, Interceptor) and classes without a file → hierarchy unknown, inherited plugins can be missed, interceptability "unknown" |

## D. Not fixed — returns more / behaviour (left on purpose)

| # | Item |
|---|------|
| D1 | MCP server starts a full re-index on connect when no index exists |
| D2 | First, semantic block of `find_plugin` lists unrelated plugin classes |

## E. Known limits (documented)

- Module order without `app/etc/config.php` is approximated from `<sequence>`.
- Full plugin execution order (sortOrder chain, around nesting) is not shown — per-plugin sortOrder only;
  runtime order: `magento-di-inspect.php`.
- Observer `shared="false"`, observer `method` details not evaluated.
- First call on a large project: `find_plugin` ≈ 4 s, `find_implementors` ≈ 8 s; no cache across sessions.
- Short class names stay fuzzy (by design).

## F. Not verified

- `npm run test:accuracy` (needs an indexed Magento 2.4.7).
- Semantic search quality on a full project index.
- Tools for layout / templates / blocks, fieldset, shipping chain, diff analysis, complexity.
- Upstream: 4 failing `unit.test.js` cases (`ast_search`, `find_dataobject_issues`) — also on 2.17.0.
