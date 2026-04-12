# Magector Index Enrichment & Structural Search — Design

**Date:** 2026-04-12  
**Versions:** v2.12.0 (grep + semgrep), v2.13.0 (null chain index)

## v2.12.0

### 1. `magento_grep` quick wins
- Add `filesOnly: boolean` — passes `-l` to rg, returns only file paths (eliminates content noise)
- Increase default `context` from 2 → 4 lines (agent sees null guards without opening file)

### 2. `magento_read` hint
- When file > 100 lines and no `methodName` param: append tip recommending methodName usage

### 3. `magento_ast_search` — new tool
- Wraps `semgrep --pattern <pattern> --lang php --json`
- Returns file:line:snippet per match
- Supports PHP structural patterns (`$X->getPayment()->$Y(...)`)
- Replaces grep for code structure queries; understands AST (no false positives from comments/strings)
- Optional `path`, `maxResults` parameters

## v2.13.0

### 4. `magento_enrich` + `magento_find_null_risks`
- JS enrichment pass: scans PHP vendor/ for `->method()->method()` chains
- Detects null guards in ±6 lines (null check, ?->, ??, is_null)
- Stores in SQLite `method_chains(file, line, chain, first_method, second_method, has_null_guard)`
- Runs automatically after `magento_index`, also manually via `magento_enrich`
- New tool `magento_find_null_risks(firstMethod?)` queries pre-built table → O(1) instead of 22 grep calls
