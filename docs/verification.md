# Verification — how the structural answers are checked, and why each fix was made

Goal of the structural tools: return **exactly** what Magento loads, or **more with a mark** (disabled,
superseded, does not run, not read) — **never less**. "Less" is the failure that hurts in change-impact
work: the missing plugin, route or column is the one nobody checks.

## Method

Two layers, each against Magento itself — never against Magector's own idea of Magento:

1. **A real installation** (`scripts/verify-magento`). PHP scripts ask the running Magento what it
   loaded, `compare.mjs` checks Magector against it and prints *missing* (must be 0), *different* and
   *extra* (should be explainable). Regenerate the truth right before comparing — project files change.

   | Mode | Truth from Magento | Magector |
   |---|---|---|
   | `php` | PHP's tokenizer | class / method reading |
   | `xml` | DOMDocument | di.xml / events.xml reading, files Magento rejects |
   | `plugins` | `PluginListInterface::getNext()` per area | `magento_find_plugin` |
   | `webapi` `graphql` `cron` `dbschema` `modules` | `config-truth.php`: `Webapi\Model\Config`, `GraphQlSchemaStitching\Reader`, `Cron\Model\ConfigInterface` (+ `core_config_data`), `SchemaConfig::getDeclarationConfig()`, `ComponentRegistrar` / `ModuleList` | `src/magento-config.js` models |

2. **Synthetic fixtures with Magento's answer pinned.** Every fixture case is an unusual but valid (or
   deliberately broken) shape. Its expected result is not written by hand: `fixture-truth.php` runs
   Magento's readers on the fixture's files and the output is committed
   (`tests/fixtures/config-models/magento-truth/`). The tests compare with it through the same
   `compare.mjs` used on real projects, then check the MCP answers. Each test name says the Magento
   behaviour and what the tool did before (`was: …`); every new test is run on the previous code and
   must fail there.

## Results (Mage-OS 2.4.9 project, ~190 custom modules, PHP 8.3, libxml 2.9.14)

| Check | Result |
|---|---|
| PHP classes / methods | 0 differences on 18,419 classes |
| di.xml / events.xml | 0 differences on 999 files |
| Plugins Magento runs | 37/37 global, 40/40 graphql; 0 reported as running that do not |
| Web API routes | 446/446 (service, method, ACL) |
| GraphQL fields → resolver | 4,538/4,538 from schema.graphqls; 38 more come from EAV attribute readers (named in the answer) |
| Cron jobs | 81/81; 3 differ only through `core_config_data` (noted in the answer) |
| Declared tables | 507/507 with every column, key and index under Magento's name |
| Modules | 598/598 directories, enabled state and load order |
| `trace_api` vs Magento | 446/446 routes: same route, service class and method |

## Use cases and time (the project above, no vector index, `MAGECTOR_AUTO_INDEX=0`)

Magector: *cold* = a new MCP server and the first call of the session, *warm* = the same call again.
Classic: the grep an agent would run, plus reading the files it lists (tokens = text read).
Complete = items of Magento's answer that the output contains.

| Question | 2.17.5 cold / complete | This branch cold / warm / tokens / complete | Classic time / tokens / complete |
|---|---|---|---|
| Plugins on QuoteRepository | 4.3 s / 4 of 4 | 0.43 s / 31 ms / 2.5k / 4 of 4 | 0.18 s / 10.4k / 2 of 4 (inherited missing) |
| Observers of sales_order_place_after | 6.2 s (4.9 s warm) / 7 of 7 | 0.27 s / 8 ms / 0.5k / 7 of 7 | 0.18 s / 1.9k / 7 of 7 |
| Preference of CartRepositoryInterface | 4.2 s / 1 of 1 | 0.44 s / 30 ms / 0.1k / 1 of 1 | 0.19 s / 0.04k / 1 of 1 (winner by hand) |
| PUT /V1/carts/mine → class | no answer without index | 0.28 s / 23 ms / 0.5k / 2 of 2 | 0.35 s / 0.1k / 1 of 2 |
| Resolvers of SimpleCartItem fields | no answer | 0.31 s / 20 ms / 0.6k / 9 of 9 | 0.18 s / 17.5k / 9 of 9 (merging by hand) |
| Cron jobs "clean" | no answer | 0.15 s / 23 ms / 1.1k / 19 of 20 (+1 in core_config_data, noted) | 0.18 s / 0.8k / 19 of 20 |
| Columns of sales_order | no answer | 0.18 s / 18 ms / 4.6k / 158 of 158 | 0.18 s / 44.9k / 158 of 158 |
| Files of Magento_Catalog | no answer | 0.47 s / 107 ms / 3.4k / all counted | 0.02 s / 68.8k / all |

## Why each fix was made

Magento behaviour → what Magector did before → where it is pinned.

### DI and events (merged in 2.17.1)
Findings #1–#21 of the original report: plugins inherited from parents and interfaces, plugins on a
virtual type name that never run, the plugin type resolved through preferences, disabled plugins and
observers, module load order from `app/etc/config.php`, areas, interceptability (final, static,
non-public, `NoninterceptableInterface`), comments in XML read as data. Tests: `tests/di-resolution.test.js`,
`tests/di-parsing.test.js`.

### Class lookup
| Magento | Before | Test |
|---|---|---|
| A class is the file its FQCN autoloads (composer PSR-4) | looked up by file name: with two `Stock` observers the other module's file | `di-resolution`: find_method / trace_call_chain / batch by FQCN |

### Structural answers for API, GraphQL, cron, schema, modules
| Magento | Before | Test (`tests/config-models.test.js`) |
|---|---|---|
| Only `<module>/etc/<file>` of enabled modules is read, in config.php order | vector search over every file, no index → no answer | every `find_*` case |
| webapi route merged by url + method; `<service>` overrides attribute by attribute; ACL merged by ref; url trimmed | separate hits | find_api cases |
| GraphQL types are cut from the raw text by a regular expression: a type in a `#` comment is read, a `{` in a body breaks the file | line-based match of `@resolver(` — multi-line directives missed | find_graphql cases, `magentoGraphqlChunks` |
| Types of one name merge with array_replace_recursive (a later field without `@resolver` keeps the earlier one); interface fields are copied into object types, a declared field replaces the interface's whole | — | find_graphql cases |
| Only `etc/schema.graphqls` is read | every `*.graphqls` under etc | find_graphql case |
| Cron: crontab.xml merged by group + job, then the crontab system config (config.xml defaults, `run/model` → instance::method) | — | find_cron cases |
| Declarative schema merged by table / column / referenceId; disabled elements dropped; keys named PRIMARY / by `ExpressionConverter` (map, md5); `_replica` named after the origin table | — | find_db_schema cases, db names |
| A module is where registration.php registers it; a name can contain dots (`Amasty_Mage2.4.7Fix`) | vendor path guessed from the name, 100-file cap; a dotted name read as "not installed" | module_structure cases, config.php case |

## Not structural yet

`find_config`, `find_template`, `find_block`, `find_trigger`, `performance_profile` answer from the
index only; `find_callers` misses calls through factories and untyped variables; `trace_api` and
`trace_data_flow` still match short names by substring. See `docs/di-resolution-todo.md`.
