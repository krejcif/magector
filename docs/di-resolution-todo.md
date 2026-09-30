# DI / event resolution — open items (TODO)

Follow-ups to the structural DI / event resolution (`src/di-config.js`). Verification against a
Magento installation: `scripts/verify-magento/`.

## A. Invalid XML / values — done: `magento_validate_config` + notice in the DI / event tools

Magento behaviour (Mage-OS 2.4.9 source, each point checked in PHP 8.3 / libxml 2.9.14):
- Not well-formed XML → `Config\Dom::_initDom()` fails in **every mode** → `The XML in file "<file>" is
  invalid:\n<errors>\nVerify the XML and try again.`, errors in `ERROR_FORMAT_DEFAULT` (`%message%\nLine: %line%\n`).
  An empty file is a `ValueError` of `DOMDocument::loadXML()` (PHP 8), not wrapped.
- The converters run on the **merged** configuration of an area, under Magento's `ErrorHandler` (a PHP
  warning is an exception): plugin `disabled` / type `shared` → `BooleanUtils` strict; missing `name` /
  `for` / `type` → `Warning: Attempt to read property "nodeValue" on null`; unknown node → `Invalid
  application config. Unknown node`; DI arguments → `Config\Converter\Dom\Flat` + the interpreters of
  `ObjectManagerFactory::createArgumentInterpreter()`. All of this fails in **every mode**, not only in
  developer mode (the plan had A5 as developer-only — wrong).
- Developer mode adds schema validation: per file where the reader has a per-file schema (`events.xml`),
  of the **merged** document otherwise (`di.xml`: `getPerFileSchema()` is `null`). The outcome depends on
  file order — duplicate `<argument name>` fails only when no earlier file declared that argument; a bad
  value can be overridden by a later file. Only Magento's reader gives the answer, so the native check
  reads every area with `ObjectManager\Config\Reader\Dom` / `Event\Config\Reader` in both modes.
- Observer `disabled`: only `'true'` disables. `sortOrder` → PHP `(int)` (`"10abc"` → 10, `"1e2"` → 100).
- Text (or CDATA) next to `<item>`s in an argument: `Flat` takes the first non-blank text as the value and
  drops the items (an array argument becomes empty) — found by the value mutations.

| # | Variant | Now |
|---|---------|-----|
| A1 | Not well-formed | error, Magento's message; built-in: libxml's first fatal error (message, line) |
| A2 | Plugin `disabled` / type `shared` outside `true/false/1/0` | error, `BooleanUtils` message |
| A3 | Observer `disabled="1"` etc. | warning ("does not disable") |
| A4 | Non-integer `sortOrder` | warning with the `(int)` value |
| A5 | Missing `name` / `for` / `type`, unknown node, invalid DI argument value | error in every mode, converter / interpreter message |
| A6 | Schema (XSD) errors | native only: developer-mode failure per area from Magento's reader; other files against their declared schema, as its own section |

Still open:

| # | Item |
|---|------|
| A7 | The DI / event tools warn about a rejected file (notice) but still list its declarations and use them for the effective state; they could mark them "file not loaded". |
| A8 | Native developer-mode verdicts cover DI and events only; other readers (`crontab.xml`, `routes.xml`, `webapi.xml`, `system.xml`, …) get the declared-schema check, which Magento's reader may not apply (`module.xml` is read without a schema). |
| A9 | Built-in: `const` / `init_parameter` arguments (needs PHP's `defined()`); nested-array `SortItems` order is approximated (single-level stable sort) — affects only which of several errors is first. |
| A10 | Native run over a whole project: ~10 s (3,077 files, 15 areas), no cache between calls. |

## B. Decision needed

| # | Question | Now | Proposal |
|---|----------|-----|----------|
| B1 | composer `require` as a dependency for the ambiguity check | counts like `<sequence>` | Magento orders modules **only** by `<sequence>`; `require` does not affect load order → report "order held only by composer require" as a weaker warning instead of hiding it |

## C. Not fixed — returns less (narrower)

| # | Item |
|---|------|
| C1 | `find_callers`: calls through factory-created instances (`$f->create()->x()`) and untyped variables |
| C2 | `trace_flow` deep for GraphQL stops at the resolver (does not follow the injected service → preference → plugins) |
| C3 | Remaining regex readers: `trace_shipping_chain`, `trace_api`, `trace_call_chain` (only comment stripping applied) |
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
