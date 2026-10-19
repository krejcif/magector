# Review Fixes (2026-10-16) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the security holes and the serve-protocol defects found in the 2026-10-16 review without changing the index format, the MCP tool set, or any search result a user currently gets.

**Architecture:** Every fix is a local, test-pinned change behind an existing chokepoint (`safePath`, `serveQuery`, the serve stdin loop, the reindex lock). No file split, no dependency swap, no index rebuild. A PR-gating CI workflow lands first so every later task is verified by the same `npm test` + `cargo test` run on Linux. Each phase is one branch and one PR into `main`, merged in order.

**Tech Stack:** Node 20+ ES modules (no test framework, plain scripts in `tests/`), Rust 2021 (`rust-core`, `cargo test`), GitHub Actions.

**Spec:** The review delivered in this session (findings 1–10 and the hygiene list). Verified facts the plan relies on are restated in each task.

## Global Constraints

- The on-disk index format (`PERSIST_VERSION_V2`, manifest, sona state, `php-scan.json`) must not change. No task may require `magector index --force`.
- The MCP tool list (48 tools, names and input schemas) must not change. `tests/mcp-server.test.js` asserts `tools.length >= 46`; it must still pass.
- Rust and Node ship together at one version (`package.json` is the source of truth; CI syncs `Cargo.toml`). A protocol change is allowed only if the Node side tolerates the old Rust reply shape and the Rust side tolerates the old Node request shape.
- No big-bang refactors: `src/mcp-server.js` stays one file in this plan; `ruvector` stays a dependency (only its shell-spawning functions stop being called).
- Every task ends with `npm test` and, for Rust tasks, `cd rust-core && cargo test --release` green locally. cargo is installed via Homebrew rustup and is NOT on the default PATH: prefix every cargo command with `export PATH=/opt/homebrew/opt/rustup/bin:$PATH &&`.
- Line numbers in this plan are from main@813c2d7; earlier tasks shift them. Locate code by the quoted content / `case '<tool>'` / function name, not by number alone.
- Every user-visible change gets one line under `## [Unreleased]` in `CHANGELOG.md` (Keep a Changelog subsections `Fixed` / `Changed` / `Added`).
- Commit messages follow the repo style `fix(scope): …` / `feat: …` / `chore: …`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never run `git push --force`, never rewrite `main`, never delete tags.

## Review Focus

Inputs the spec implies but no existing test exercises, each pinned to a task below:

1. `magento_analyze_diff` with `commitHash` = `HEAD; touch /tmp/pwned` must return an error and run nothing. → Task 4.
2. `magento_read` on `app/code/link` where `link -> /etc` must be refused like `../etc`. → Task 6.
3. A serve request that times out in Node, then replies late, must not shift the reply of the next request. → Task 9.
4. A serve handler returning an error text containing `"` or `\` must still produce one parseable JSON line. → Task 8.
5. `.magector/reindex.pid` written by a new Node (two lines) must still be read as a live lock by the Rust watcher, and a one-line file from an old Node must still be read. → Task 13.

---

## Phase 0 — Safety net (branch `chore/ci-and-test-hygiene`)

### Task 1: PR-gating CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `scripts/run-tests.mjs`
- Modify: `package.json` (`scripts.test`)

**Interfaces:**
- Produces: `npm test` runs every file in the `TEST_FILES` list of `scripts/run-tests.mjs`, continues past failures, exits 1 if any file exited non-zero, and prints a per-file summary table. Later tasks rely on this to see all failures at once.

- [ ] **Step 1: Write `scripts/run-tests.mjs`**

Export `const TEST_FILES = [...]` with the eleven files currently chained in `package.json` `scripts.test` (same order). `main()` runs each with `spawnSync(process.execPath, [file], { stdio: 'inherit' })`, collects `{ file, status, ms }`, prints the table, and `process.exit(anyFailed ? 1 : 0)`. Guard `main()` with the same `process.argv[1] === fileURLToPath(import.meta.url)` idiom as `scripts/sync-optional-deps.mjs`.

- [ ] **Step 2: Point `npm test` at it**

`"test": "node scripts/run-tests.mjs"`. Keep every `test:*` script unchanged.

- [ ] **Step 3: Run `npm test` locally**

Expected: all eleven files run (not only the first), summary shows `unit.test.js` failed (the four semgrep tests, fixed in Task 2) and the other ten passed, exit code 1.

- [ ] **Step 4: Write `.github/workflows/ci.yml`**

Trigger: `pull_request` and `push` to `main`. Two jobs:
- `node`: `ubuntu-24.04`, `actions/setup-node@v4` with `node-version: 22`, `npm ci`, `npm test`, with job env `MAGECTOR_AUTO_INDEX=0` (otherwise the server started by `tests/mcp-server.test.js` with no index.db begins a real background index of the repo, `src/mcp-server.js:9752`) and `MAGECTOR_MODELS=$HOME/.magector/models` (the server itself never downloads models; the Rust binary downloads into the `-c` directory, which defaults to `./models` in cwd, `src/mcp-server.js:70`). Cache `~/.magector/models` with `actions/cache@v4`, key `onnx-models-v1`. `npm ci` installs `@magector/cli-linux-x64@<package.json version>` (the published binary).
- `rust`: `ubuntu-24.04`, `dtolnay/rust-toolchain@stable`, `Swatinem/rust-cache@v2` with `workspaces: rust-core`, `sudo apt-get install -y pkg-config build-essential` (`build.rs` compiles `glibc_compat.c` on Linux; `ort`'s `download-binaries` needs network), then `cargo test --release` in `rust-core` (release: the tests embed with ORT and debug builds are too slow). Do not add `clippy -D warnings` in this plan.
- Note for later tasks: the `node` job runs the Node code against the *published* binary of the current version, so a Node change that depends on a Rust change of the same PR (Task 9 on Task 8) is exercised only by its fake-core test until the next release.

- [ ] **Step 5: Open the PR and confirm both jobs run**

Expected: `rust` green (132 tests), `node` red on the four semgrep tests until Task 2 is merged into the same branch.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml scripts/run-tests.mjs package.json
git commit -m "chore(ci): run npm test and cargo test on every PR; test runner no longer stops at the first failing file"
```

### Task 2: Replace the dead semgrep unit tests with a tree-sitter test

**Files:**
- Modify: `tests/unit.test.js:1510-1640` (`testAstSearch`, `testFindDataObjectIssues`) and the two `await` lines at `tests/unit.test.js:4782-4783`
- Modify: `rust-core/src/ast.rs` (tests module)

**Interfaces:**
- Consumes: `PhpAstAnalyzer::run_query(&mut self, source: &str, query_source: &str) -> Result<Vec<AstQueryMatch>, String>` (`rust-core/src/ast.rs:140`); query files `rust-core/queries/dataobject-set-null.scm`, `rust-core/queries/unchecked-method-chain.scm`.

Fact: the product's `magento_ast_search` and `magento_find_dataobject_issues` run `ast_query` through the Rust serve (`src/mcp-server.js:5312-5338`); the two JS tests invoke an external `semgrep` binary with a hard-coded `/home/swed/.local/bin` and fail on any machine without it.

- [ ] **Step 1: Write the failing Rust tests in `rust-core/src/ast.rs`**

Facts: `AstQueryMatch.snippet` is the whole source line(s) of the match (`ast.rs:160-178`), so assertions go on `captures`; `dataobject-set-null.scm` matches any `->name(null)` call (no `set*` restriction; the `set[A-Z]` filtering was only in the deleted JS test); `unchecked-method-chain.scm` matches `$var->prop->method()` (object is a `member_access_expression`), not `$o->getPayment()->getMethod()`.

```rust
#[test]
fn test_query_dataobject_set_null_captures_method_names() {
    let src = "<?php\nclass A {\n  function f($o) {\n    $o->getPayment()->setMethod(null);\n    $o->setCouponCode(null);\n    $o->setMethod('x');\n  }\n}\n";
    let mut a = PhpAstAnalyzer::new().unwrap();
    let m = a.run_query(src, include_str!("../queries/dataobject-set-null.scm")).unwrap();
    let names: Vec<&str> = m.iter().flat_map(|x| x.captures.iter())
        .filter(|(k, _)| k == "method_name").map(|(_, v)| v.as_str()).collect();
    assert_eq!(names, vec!["setMethod", "setCouponCode"]);
}

#[test]
fn test_query_unchecked_method_chain_captures_property_chain() {
    let src = "<?php\nclass U {\n  function e() {\n    return $this->payment->getMethod();\n  }\n}\n";
    let mut a = PhpAstAnalyzer::new().unwrap();
    let m = a.run_query(src, include_str!("../queries/unchecked-method-chain.scm")).unwrap();
    assert_eq!(m.len(), 1);
    assert!(m[0].captures.contains(&("property".to_string(), "payment".to_string())));
    assert!(m[0].captures.contains(&("called_method".to_string(), "getMethod".to_string())));
}
```

- [ ] **Step 2: Delete `testAstSearch` and `testFindDataObjectIssues` and their two `await` calls**

- [ ] **Step 3: Run tests**

Run: `node tests/unit.test.js` — Expected: `882 passed, 0 failed`. Push; CI `rust` job — Expected: 134 tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/unit.test.js rust-core/src/ast.rs
git commit -m "test: pin ast_query patterns in Rust; drop the semgrep tests the product no longer uses"
```

### Task 3: Sync the stale version and docs claims

**Files:**
- Modify: `rust-core/Cargo.toml:3` (`version = "1.7.3"` → `2.23.0`)
- Modify: `CLAUDE.md:30` (`557 unit tests in validation.rs`) and `CLAUDE.md:106` (`20 tools`)
- Modify: `package.json` (add `"engines": { "node": ">=20" }` — `glob@13` requires Node 20)
- Modify: `CHANGELOG.md` `## [Unreleased]`

- [ ] **Step 1: Apply the four edits**

CLAUDE.md line 30 becomes: ``Rust tests: `cd rust-core && cargo test` (unit tests live beside the code in each module; `validation.rs` holds the accuracy ground-truth data, not tests).`` Line 106: replace `20 tools` with `48 tools`. Add to CHANGELOG `### Changed`: `package.json now declares engines.node >=20 (glob 13 needs it); npm warns on older Node instead of failing at import.`

- [ ] **Step 2: Verify**

Run: `node -e "require('./package.json').engines.node"` prints `>=20`; `grep -n '^version' rust-core/Cargo.toml` prints `2.23.0`; `npm test` green.

- [ ] **Step 3: Commit, open PR `chore/ci-and-test-hygiene`, merge when CI is green**

```bash
git add rust-core/Cargo.toml CLAUDE.md package.json CHANGELOG.md
git commit -m "chore: sync Cargo.toml version, CLAUDE.md tool and test counts, declare engines.node"
```

---

## Phase 1 — Security in the Node layer (branch `fix/mcp-input-hardening`)

### Task 4: `magento_analyze_diff` must never reach a shell

**Files:**
- Create: `src/git-diff.js`
- Modify: `src/mcp-server.js:27-36` (imports), `1548-1584` (`analyzeDiff`), `7321-7325` (handler)
- Test: `tests/unit.test.js` (new `testGitDiffHelpers`)

**Interfaces:**
- Produces: `isSafeGitRef(ref: string): boolean` — true only for `/^[0-9A-Za-z][\w.\/^~-]{0,127}$/` with no `..`, no leading `-`; `commitDiff(root: string, ref: string): string` and `stagedDiff(root: string): string` — `execFileSync('git', ['-C', root, 'show', '--format=', '--end-of-options', ref])` / `['-C', root, 'diff', '--cached']`, `encoding: 'utf-8'`, `maxBuffer: 10 * 1024 * 1024`, `timeout: 30000`; a git failure returns `''`.
- Consumes: `analyzeFileDiff(file, section)` from `ruvector/dist/core/diff-embeddings.js` (pure; keep).

Fact: today `analyzeCommit(options.commitHash)` → ruvector `execSync(\`git show ${commitHash} …\`)` through a shell, in `process.cwd()` not `MAGENTO_ROOT`.

- [ ] **Step 1: Write the failing tests in `tests/unit.test.js`**

```js
async function testGitDiffHelpers() {
  console.log('\n── git-diff helpers ──');
  const { isSafeGitRef, commitDiff, stagedDiff } = await import('../src/git-diff.js');
  assert(isSafeGitRef('HEAD'), 'HEAD is a safe ref');
  assert(isSafeGitRef('0f32c5f'), 'short sha is safe');
  assert(isSafeGitRef('main~2'), 'main~2 is safe');
  assert(!isSafeGitRef('HEAD; touch /tmp/pwned'), 'shell metachars rejected');
  assert(!isSafeGitRef('$(id)'), 'command substitution rejected');
  assert(!isSafeGitRef('--output=/tmp/x'), 'leading dash rejected');
  assert(!isSafeGitRef('a/../b'), 'dotdot rejected');
  assert(!isSafeGitRef(''), 'empty rejected');
  // real repo: this project
  const root = path.join(__dirname, '..');
  assert(commitDiff(root, 'HEAD').includes('diff --git') || commitDiff(root, 'HEAD') === '', 'commitDiff returns a diff or empty');
  assertEq(commitDiff(root, 'HEAD; echo x'), '', 'unsafe ref yields empty diff without running');
  assertEq(typeof stagedDiff(root), 'string', 'stagedDiff returns a string');
}
```
Register `await testGitDiffHelpers();` next to `await testReadMethodNameHint();`.

- [ ] **Step 2: Run to verify it fails** — `node tests/unit.test.js` — Expected: FAIL with "Cannot find module '../src/git-diff.js'".

- [ ] **Step 3: Implement `src/git-diff.js`** per the Interfaces block; `commitDiff` returns `''` when `!isSafeGitRef(ref)`.

- [ ] **Step 4: Rewire `analyzeDiff` in `src/mcp-server.js`**

Remove `analyzeCommit` and `getStagedDiff` from the ruvector import. `analyzeDiff(options)`: if `options.commitHash` → `if (!isSafeGitRef(options.commitHash)) throw new Error(\`Invalid commit reference: ${options.commitHash}\`)`; `diff = commitDiff(config.magentoRoot, options.commitHash)`; else `diff = stagedDiff(config.magentoRoot)`. The existing per-section loop (`diff.split(/^diff --git /m)` → `analyzeFileDiff`) handles both cases. Preserve today's commit-mode output shape: add `commitSubject(root, ref): string` to `src/git-diff.js` (`git -C root log -1 --format=%s --end-of-options ref`, `''` on failure) and set `message: commitSubject(...)` and `hash: options.commitHash` on the result (the handler prints `message` at ≈7332); for the commit path compute `riskScore` as the mean over files, as ruvector's `analyzeCommit` did, and keep the max for the staged path. The handler at 7321 is unchanged.

- [ ] **Step 5: Run tests** — `npm test` — Expected: green; `tests/mcp-server.test.js` still lists `magento_analyze_diff`.

- [ ] **Step 6: CHANGELOG `### Fixed`** — `magento_analyze_diff passed commitHash to a shell; it now rejects anything but a git ref and runs git without a shell, in MAGENTO_ROOT.`

- [ ] **Step 7: Commit**

```bash
git add src/git-diff.js src/mcp-server.js tests/unit.test.js CHANGELOG.md
git commit -m "fix(mcp): magento_analyze_diff validates the ref and runs git without a shell"
```

### Task 5: `magento_complexity` and `magento_index` validate their paths

**Files:**
- Modify: `src/mcp-server.js` handlers `case 'magento_complexity'` (starts at 7349) and `case 'magento_index'` (6866)
- Create: `src/index-root.js`
- Test: `tests/mcp-server.test.js` (two new `--no-index`-safe cases for `magento_complexity`), `tests/unit.test.js` (for the index-root check)

**Interfaces:**
- Consumes: `safePath(root, rel)` (Task 6 moves it to `src/path-safety.js`; until then the in-file one).
- Produces: `export function resolveIndexRoot(argPath: string|undefined, configured: string): { root: string } | { error: string }` in `src/index-root.js` — `root = argPath ? path.resolve(argPath) : configured`; `{ error: \`Index path is not a directory: ${root}\` }` unless `statSync(root).isDirectory()` (in try).

Fact: `magento_index` is not in `indexFreeTools` (`src/mcp-server.js:6539`), so with no index the dispatcher answers before the handler runs; its check is therefore unit-tested, not integration-tested. `magento_complexity` is index-free. Intended behavior change, to state in the CHANGELOG: `magento_complexity` used to accept any absolute path; it now accepts only paths inside `MAGENTO_ROOT` (the existing integration test passes a path inside the project root, which stays valid).

- [ ] **Step 1: Write the failing tests**

`tests/mcp-server.test.js`, no-index section: call `magento_complexity` with `{ path: '../../etc' }` and assert the text starts with `Path escapes project root`; call it with `{ module: 'Magento_Catalog; rm -rf /' }` and assert the text starts with `Invalid module name`. `tests/unit.test.js`, new `testResolveIndexRoot`: `resolveIndexRoot('/nonexistent/dir/xyz', '/srv/m')` has `error` containing `not a directory`; `resolveIndexRoot(undefined, __dirname)` returns `{ root: __dirname }`; `resolveIndexRoot(__dirname, '/x')` returns `{ root: __dirname }`.

- [ ] **Step 2: Run** — `node tests/mcp-server.test.js --no-index` and `node tests/unit.test.js` — Expected: the new cases FAIL (today `magento_complexity` returns metrics; module missing).

- [ ] **Step 3: Implement**

`magento_complexity`: `const abs = args.path ? safePath(config.magentoRoot, args.path) : null; if (args.path && !abs) return error text \`Path escapes project root: ${args.path}\`` (same shape as `magento_read`); use `abs` in `stat`/`glob`. `args.module` must match `/^[A-Za-z][A-Za-z0-9]*_[A-Za-z][A-Za-z0-9]*$/` else `Invalid module name: …`. `magento_index`: `const r = resolveIndexRoot(args.path, config.magentoRoot); if (r.error) return { content: [{ type: 'text', text: r.error }], isError: true }; const root = r.root;`. (Indexing a different root is a documented feature of this tool; only non-directories are refused.)

- [ ] **Step 4: Run** — `npm test` — Expected: green.

- [ ] **Step 5: Commit** — `fix(mcp): magento_complexity and magento_index refuse paths outside the root / non-directories`

### Task 6: `safePath` follows symlinks

**Files:**
- Create: `src/path-safety.js`
- Modify: `src/mcp-server.js:226-260` (delete the two functions, import them), `tests/unit.test.js:4961-4990` (import instead of re-implementing)
- Test: `tests/unit.test.js` (`testSafePath`, extended)

**DECISION NEEDED FROM THE OWNER before this task starts.** Magento dev setups routinely symlink `app/code/Vendor/Module` or `vendor/<pkg>` to a directory outside the root (composer path repositories). With symlink checking on, `magento_read`, `magento_grep`, `magento_ast_search`, `magento_find_dataobject_issues` and `magento_batch` reads (`src/mcp-server.js:5318, 8376, 8406, 8540, 8753, 9400`) refuse those files. Proposed default: secure (refuse), with the refusal text naming the escape hatch `MAGECTOR_ALLOW_SYMLINKS_OUTSIDE_ROOT=1` (checked once at startup; when set, behave exactly as today). If the owner prefers compatibility first, invert the default and keep the test for both modes. Until decided, Phase 1 ships Tasks 4, 5, 7 without this task.

**Interfaces:**
- Produces: `safePath(root: string, rel: string|undefined): string|null`, `safeRelPath(root, rel): string|null` — same contract as today (`'.'` for the root itself; the returned value is the *lexical* absolute path, never the realpath, because `safeRelPath` does `path.relative(path.resolve(root), abs)` and on macOS `/var` → `/private/var` would otherwise yield `../../private/…`), plus: the deepest existing ancestor of the joined path is `realpathSync`'d and must stay under `realpathSync(root)`; when `realpathSync(root)` or the ancestor lookup throws (root does not exist — the existing tests use `/srv/project`), fall back to the lexical check; non-existent tails are compared lexically (so `magento_grep` on a not-yet-created file keeps working). The env escape hatch above disables the realpath step.

- [ ] **Step 1: Extend `testSafePath` (starts at `tests/unit.test.js:4967`) with the symlink case**

```js
const tmp = mkdtempSync(path.join(os.tmpdir(), 'magector-safepath-'));
mkdirSync(path.join(tmp, 'root', 'app'), { recursive: true });
mkdirSync(path.join(tmp, 'outside'));
writeFileSync(path.join(tmp, 'outside', 'secret.txt'), 'x');
symlinkSync(path.join(tmp, 'outside'), path.join(tmp, 'root', 'app', 'link'));
assertEq(safePath(path.join(tmp, 'root'), 'app/link/secret.txt'), null, 'symlink escaping the root is refused');
assert(safePath(path.join(tmp, 'root'), 'app/new-file.php')?.endsWith('app/new-file.php'), 'non-existent path inside root is still accepted');
```
and change the test to `import { safePath, safeRelPath } from '../src/path-safety.js'` (delete the local copies).

- [ ] **Step 2: Run** — Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/path-safety.js`**; in `mcp-server.js` replace the definitions with `import { safePath, safeRelPath } from './path-safety.js';`.

- [ ] **Step 4: Run** — `npm test` — Expected: green (all `safePath` callers unchanged).

- [ ] **Step 5: CHANGELOG `### Fixed`** — `A symlink inside the Magento root could lead magento_read / magento_grep / magento_ast_search outside it; paths are now checked after resolving symlinks.`

- [ ] **Step 6: Commit** — `fix(mcp): safePath resolves symlinks before checking the root`

### Task 7: npm/npx on Windows

**Files:**
- Create: `src/npm-cli.js`
- Modify: `src/binary.js:76`, `src/update.js:165`
- Test: `tests/unit.test.js`

**Interfaces:**
- Produces: `npmInvocation(tool: 'npm'|'npx', args: string[]): { file: string, args: string[], shell: boolean }` — on `win32`: `file: \`${tool}.cmd\``, `shell: true`, and every arg must match `/^[\w@.:\/\\=+-]+$/` else throws `Error('unsafe argument for shell: …')`; elsewhere `file: tool`, `shell: false`, args untouched.

Fact: Node ≥18.20 refuses `execFileSync('npx.cmd', …)` without `shell: true` (EINVAL), and `execFileSync('npx')` fails with ENOENT; both call sites currently exit 1 / silently fail on Windows.

- [ ] **Step 1: Tests** — on the current platform assert `npmInvocation('npx', ['-y', 'magector@2.23.0'])` has `shell === (process.platform === 'win32')`, `file` ends with `npx` or `npx.cmd`; assert it throws for `['-y', 'magector@2.23.0 && calc']` only when `shell` is true (skip the throw assertion on non-win32, assert args pass through unchanged).

- [ ] **Step 2–4: Implement, rewire both call sites (`const inv = npmInvocation(...); execFileSync(inv.file, inv.args, { shell: inv.shell, … })`), run `npm test`.**

- [ ] **Step 5: Commit** — `fix(cli): self-heal install and auto-update work on Windows (npm.cmd/npx.cmd)`. Note in the PR: not runnable on macOS CI; verified by reading only, needs one manual run on Windows before release.

- [ ] **Open PR `fix/mcp-input-hardening`, merge when green.**

---

## Phase 2 — Serve protocol (branch `fix/serve-protocol-ids`)

### Task 8: Every serve reply is valid JSON and echoes the request id

**Files:**
- Modify: `rust-core/src/main.rs:605-650` (serve loop)
- Test: `rust-core/src/main.rs` tests module

**Interfaces:**
- Produces: `fn finish_response(req: &serde_json::Value, raw: String) -> String` — parses `raw`; on success inserts `"id": req["id"]` when the request carried an `id` (any JSON value, copied verbatim) and re-serializes; on parse failure returns `json!({"ok": false, "error": format!("serve produced invalid JSON: {}", raw.chars().take(200).collect::<String>()), "id": req["id"]})` (omit `id` when absent). The seven hand-built `format!` strings in `handle_serve_request` stay as they are; this chokepoint makes them safe.

- [ ] **Step 1: Failing tests**

```rust
#[test]
fn finish_response_echoes_id_and_keeps_payload() {
    let req = serde_json::json!({"command": "search", "id": 7});
    let out = finish_response(&req, r#"{"ok":true,"data":[1]}"#.to_string());
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["id"], 7); assert_eq!(v["ok"], true); assert_eq!(v["data"][0], 1);
}
#[test]
fn finish_response_without_id_adds_none() {
    let out = finish_response(&serde_json::json!({"command": "stats"}), r#"{"ok":true}"#.to_string());
    assert!(serde_json::from_str::<serde_json::Value>(&out).unwrap().get("id").is_none());
}
#[test]
fn finish_response_repairs_invalid_handler_output() {
    let req = serde_json::json!({"id": "a"});
    let out = finish_response(&req, r#"{"ok":false,"error":"path C:\new\dir"}"#.to_string());
    let v: serde_json::Value = serde_json::from_str(&out).expect("one valid JSON line");
    assert_eq!(v["ok"], false); assert_eq!(v["id"], "a");
    assert!(v["error"].as_str().unwrap().contains("invalid JSON"));
}
```

- [ ] **Step 2: Implement `finish_response` and call it on both branches of the loop (`Ok(resp) => finish_response(&req, resp)`, panic branch likewise; the `Invalid JSON` branch has no `req`, keep it but build it with `json!`).**

- [ ] **Step 3: CI rust job green (137 tests).**

- [ ] **Step 4: Commit** — `fix(serve): every reply is one valid JSON line and echoes the request id`

### Task 9: Node routes serve replies by id, with FIFO fallback

**Files:**
- Modify: `src/mcp-server.js:994-998` (stdout routing), `1301` (`const msg = JSON.stringify({ command, ...params })` → `{ id, command, ...params }`)
- Create: `tests/mcp-serve-ids.test.js`
- Modify: `scripts/run-tests.mjs` `TEST_FILES` (add it)

**Interfaces:**
- Consumes: Task 8 reply shape `{..., "id": <number>}`.
- Routing rule: if `parsed.id !== undefined && servePending.has(parsed.id)` → resolve that entry; else if `parsed.id !== undefined` → log `ERR [id] ← late reply dropped` and return; else (old binary, no id) → current FIFO behavior. None of the nine `serveQuery` commands sends a param named `id` (verified by grep), so `{ id, command, ...params }` cannot collide.

- [ ] **Step 1: Write `tests/mcp-serve-ids.test.js`**

Copy the harness of `tests/mcp-serve-start.test.js` (`makeRoot`, `startServer`, `ok`) but make the fake core a Node script (`fake-core.mjs`, run via `MAGECTOR_BIN` pointing at a `#!/usr/bin/env node` file) that: prints `{"ok":true,"ready":true}` on `serve`; for each stdin line parses JSON; for `command === 'search'` replies after `query === 'slow' ? 6000 : 10` ms with `{"ok":true,"id":<req.id>,"data":[{"path":"<query>.php","score":1}]}`; on the `search` subcommand (cold fallback) prints `[]`. Fact: the search path does not use `serveQuery`'s default timeout — `rustSearchAsync` passes `Math.min(SOCKET_QUERY_TIMEOUT_MS, left())` (`src/mcp-server.js:1372`) and `SOCKET_QUERY_TIMEOUT_MS = SERVE_RELOAD_WAIT_MS + 10000` (`:213`). Add at `:213`: `const SOCKET_QUERY_TIMEOUT_MS = envMs('MAGECTOR_SERVE_QUERY_TIMEOUT_MS', SERVE_RELOAD_WAIT_MS + 10000);` (default unchanged). Test: start with `MAGECTOR_SERVE_QUERY_TIMEOUT_MS=500`, call `magento_search` `{query:'slow'}` (it times out, runs the cold fallback, answers with no results), then immediately `magento_search` `{query:'fast'}`, both awaited in sequence within the 6 s window; assert the second response text contains `fast.php` and not `slow.php`. The 6 s delay guarantees the late `slow` reply lands while `fast` is pending, which is the bug.

- [ ] **Step 2: Run** — Expected: FAIL (second answer carries `slow.php`: the late reply was handed to the next pending request).

- [ ] **Step 3: Implement the routing rule and the id in the outgoing message.**

- [ ] **Step 4: Run `npm test`** — Expected: green, including `mcp-serve-start.test.js` whose bash fake core replies without an id (FIFO fallback path).

- [ ] **Step 5: CHANGELOG `### Fixed`** — `A serve query that timed out in the MCP server could hand its late reply to the next query; replies now carry the request id.`

- [ ] **Step 6: Commit** — `fix(mcp): route serve replies by request id, FIFO only for binaries that send none`

### Task 10: A panic in one serve request no longer poisons the indexer lock

**Files:**
- Modify: `rust-core/src/lib.rs` (new `pub mod sync_util;`), create `rust-core/src/sync_util.rs`, modify `rust-core/src/watcher.rs:73-84` (delete local `lock_recover`, import), `rust-core/src/main.rs` (16 `.lock().unwrap()` sites listed in the review: 566, 582, 691, 706, 711, 725, 755, 803, 838, 901, 1009, 1047, 1059, 1080, 1103, 1115)

**Interfaces:**
- Produces: `pub fn lock_recover<'a, T>(mutex: &'a Mutex<T>, label: &str) -> MutexGuard<'a, T>` in `magector_core::sync_util` — body identical to today's watcher version (warn + `into_inner()`).

- [ ] **Step 1: Test in `sync_util.rs`**

```rust
#[test]
fn lock_recover_returns_guard_after_poison() {
    let m = std::sync::Arc::new(std::sync::Mutex::new(1));
    let m2 = m.clone();
    let _ = std::thread::spawn(move || { let _g = m2.lock().unwrap(); panic!("poison"); }).join();
    assert!(m.lock().is_err());
    assert_eq!(*lock_recover(&m, "test"), 1);
}
```

- [ ] **Step 2: Implement, replace the 16 sites with `lock_recover(<mutex>, "<label>")` where the label is the mutex's name: `"indexer"` for `indexer`, `"status"` for `watcher_status` (566, 711), `"data_db"` for `data_db` (582, 838, 1009, …) — read each site, do not assume all are `indexer`. The guard type is unchanged; `&Arc<Mutex<T>>` derefs to `&Mutex<T>`.**

- [ ] **Step 3: CI rust green. Commit** — `fix(serve): recover the indexer lock after a handler panic instead of failing every later request`

### Task 11: The watcher walks the tree without holding the indexer lock

**Files:**
- Modify: `rust-core/src/watcher.rs:540-550` (`manifest_for`), `568-573`, `590-600`

**Interfaces:**
- Changes: `fn manifest_for(paths: &HashSet<String>, magento_root: &Path, db_path: &Path) -> FileManifest` (takes the path set instead of `&Indexer`; body otherwise identical).

- [ ] **Step 1: Rewrite the two call sites**

Initial manifest: `let paths = lock_recover(&indexer, "indexer").indexed_paths();` (do not bind the guard to a variable: the temporary guard is dropped at the end of this statement, which is the point) then `let mut manifest = manifest_for(&paths, &magento_root, &db_path);`. Reload branch: inside the `Ok(true)` arm keep `idx.warm_search()` and read `let paths = idx.indexed_paths();`, set a local `reloaded = Some(paths)`; after the `if external_reindex_pid…` block's lock scope ends, `if let Some(paths) = reloaded { manifest = manifest_for(&paths, …); tracked_files = … }`. Searches now proceed during the walk.

- [ ] **Step 2: Run `cargo test` in CI** — Expected: all 35 watcher tests green (they call the loop through the public API, not `manifest_for`).

- [ ] **Step 3: CHANGELOG `### Fixed`** — `magento_search no longer waits while the serve watcher walks the whole tree at start or after an external reindex.`

- [ ] **Step 4: Commit** — `fix(watcher): build the manifest outside the indexer lock`

- [ ] **Open PR `fix/serve-protocol-ids`, merge when green.**

---

## Phase 3 — Robustness (branch `fix/index-robustness`)

### Task 12: `magento_index` runs the indexer without blocking the event loop

**Files:**
- Modify: `src/mcp-server.js:1453-1495` (`rustIndex`), `6867` (`const output = rustIndex(root)` → `await rustIndex(root)`)

**Interfaces:**
- Changes: `async function rustIndex(magentoRoot): Promise<string>` — `spawn(config.rustBinary, indexArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: rustEnv })`, collect stdout+stderr into a buffer capped at 4 MB (keep the last 4 MB), kill with `SIGTERM` after `indexTimeout` and reject with the existing timeout message, reject on non-zero exit with the collected stderr tail, resolve with stdout. `searchCache.clear()` and `writeReindexPidFile(process.pid)` stay before the spawn; `removeReindexPidFile()` runs in a `finally` attached to the promise (both resolve and reject). Store the child in a module-level `let toolIndexProcess = null` and kill it in `cleanup()` next to the existing `reindexProcess` kill (`src/mcp-server.js:≈9893`), so a server shutdown does not orphan the indexer. `rustIndex` has exactly one caller (`:6867`).

- [ ] **Step 1: Test** — in `tests/mcp-serve-start.test.js` style with the bash fake core: add an `index) sleep 2; echo "indexed" ;;` branch, call `magento_index` and, while it runs, `magento_stats`; assert `stats` answers in < 1500 ms (today it waits for the index to finish).

- [ ] **Step 2–4: Implement, `npm test`, commit** — `fix(mcp): magento_index no longer freezes the server for the length of the index run`

### Task 13: Reindex lock — the safe half now, the namespace half deferred

Facts that shape this task: `writeIndexPidFile` is called from the background-reindex `exit` handler (`src/mcp-server.js:738`) and via `startBackgroundReindex()` from a `setInterval` poll (`:642`, `:9745`, `:9755`) — none in `try/catch`, so a throwing `writeIndexPidFile` would be an uncaught exception that kills the server; at `:738` the lock file always still exists (it names the just-exited child). The MCP background reindex (`spawn` at `:696`) has no timeout and nobody touches the lock's mtime, so any fixed freshness window for a foreign-namespace lock is wrong in one direction. An old Rust binary (`MAGECTOR_BIN`, stale `rust-core/target`) does `contents.trim().parse()` on the whole file and would ignore a two-line lock entirely. Therefore the file format does **not** change in this plan.

**Files:**
- Modify: `src/index-lock.js` (whole file, 40 lines), `rust-core/src/watcher.rs:53-63` (`external_reindex_pid`)
- Test: `tests/unit.test.js` (existing `index-lock` tests at ≈5190-5210, extended), `rust-core/src/watcher.rs` tests

**Interfaces:**
- `writeIndexPidFile(root, pid): boolean` — `writeFileSync(path, String(pid), { flag: 'wx' })`; on `EEXIST`: if `getRunningIndexPid(root)` is a live PID other than `pid`, log to stderr and return `false`; else `unlinkSync` and write again with `wx` (one retry); on any other error log and return `false`. Never throws (callers unchanged; the `:738` path writes over its own dead child's file and keeps working).
- `getRunningIndexPid(root)`: same file format (one line, bare PID). Change only the liveness branch: `process.kill(pid, 0)` throwing `EPERM` means the process exists (another user) → return `pid` and keep the file; `ESRCH` → stale → unlink (unit.test.js asserts "Stale lock file is cleaned up", keep that). A read error other than ENOENT (e.g. `EACCES`) → return `null` without unlinking.
- Rust `external_reindex_pid`: parse `contents.lines().next()?.trim()` instead of the whole content (forward-compatible with a future multi-line format; identical result for today's files).
- Deferred to a follow-up (needs its own design): recording the PID namespace in `reindex.pid`, a heartbeat that touches the lock while an indexer runs, and a Rust hostname source that matches Node's `host:${os.hostname()}` scope on macOS/Windows (`libc::gethostname`, or treating any `host:` line as same-scope).

- [ ] **Step 1: Tests**

JS: `writeIndexPidFile(root, 1)` then `writeIndexPidFile(root, 2)` returns `false` when PID 1 is alive on this machine (skip that assertion if `process.kill(1, 0)` throws `ESRCH`), and the file still names `1`; write `999999` (dead) then `writeIndexPidFile(root, process.pid)` returns `true` and the file names `process.pid`; the existing stale-cleanup test stays green. Rust: `test_external_reindex_pid_reads_first_line` — file `"<live pid of this test>\nextra"` → `Some(pid)`.

- [ ] **Step 2–4: Implement both sides, `npm test` + CI rust, CHANGELOG `### Fixed`** — `The reindex lock is created exclusively and a lock held by another user's live process is no longer deleted.`

- [ ] **Step 5: Commit** — `fix(lock): exclusive reindex.pid, keep locks of live foreign-user processes`

### Task 14: Stop the no-op MicroLoRA update

**Files:**
- Modify: `rust-core/src/main.rs:735-746`

Fact: `sona.learn_with_embeddings(signal, Some(qe), Some(qe))` makes `delta = target − query = 0`; the embedding costs one ONNX pass per signal under the indexer lock and changes nothing.

- [ ] **Step 1: Replace the branch (740-746) with `sona.learn(signal)` only; delete the `query_emb` computation (735-739).**
- [ ] **Step 2: Add a comment naming the follow-up: a real target is the embedding of the result the agent followed (`signal.followed_args.path`), to be designed separately.**
- [ ] **Step 3: CI rust green (sona tests unchanged). CHANGELOG `### Changed`** — `Feedback signals no longer embed the query for a LoRA update that could not change anything; feedback is cheaper and the serve lock is held shorter.`
- [ ] **Step 4: Commit** — `perf(sona): drop the self-targeted LoRA update`

### Task 15: Durable writes for `index.db` and the SONA state

**Files:**
- Modify: `rust-core/src/vectordb.rs:466-478` (`save_atomic`), `rust-core/src/sona.rs:452-460` (`save`)

- [ ] **Step 1: `save_atomic`: after `writer.flush()?`, `writer.get_ref().sync_all()?` (still inside the block), then rename.**
- [ ] **Step 2: `sona.save`: write to `path.with_extension("tmp")`, `sync_all`, `fs::rename`.**
- [ ] **Step 3: Test in `sona.rs`: `save_then_load_roundtrip_leaves_no_tmp_file` — save into a `tempfile::tempdir()`, assert the `.tmp` file is gone and `load` returns an equal state.**
- [ ] **Step 4: CI rust green. Commit** — `fix(persist): fsync index.db and write sona state atomically`

### Task 16: Interrupted model download repairs itself

**Files:**
- Modify: `rust-core/src/embedder.rs:78-126`

- [ ] **Step 1: Download each file to `<name>.part`, `sync_all`, `fs::rename` to the final name; download when either `model_path` or `tokenizer_path` is missing (today only the model is checked).**
- [ ] **Step 2: Test: `download_needed_when_tokenizer_missing` — create a temp cache dir with only the model file name touched; assert the new helper `fn files_missing(cache_dir: &Path) -> bool` returns true; with both touched → false.**
- [ ] **Step 3: CI rust green. Commit** — `fix(embedder): partial model downloads are retried, tokenizer presence is checked`

### Task 17: One unreadable directory does not abort indexing

**Files:**
- Modify: `rust-core/src/indexer.rs:860-875` (`discover_files`)

- [ ] **Step 1: Replace `let entry = entry?;` with `let entry = match entry { Ok(e) => e, Err(e) => { tracing::warn!("Skipping unreadable entry: {}", e); continue; } };`.**
- [ ] **Step 2: Test (unix only, `#[cfg(unix)]`): temp root with `a/ok.php` and `b/` chmod 000; assert `discover_files()` returns `a/ok.php` and does not error; restore perms in the test before the tempdir drops.**
- [ ] **Step 3: CI rust green. Commit** — `fix(indexer): skip unreadable directories instead of failing the whole run`

- [ ] **Open PR `fix/index-robustness`, merge when green.**

---

## Phase 4 — README indexing follow-ups to PR #45 (branch `fix/readme-index-followups`)

### Task 18: `magento_find_class` never returns a README

**Files:**
- Modify: `src/mcp-server.js` `case 'magento_find_class'` (≈6650-6658)
- Test: `tests/unit.test.js`

**Interfaces:**
- Produces: `export function isClassCandidate(r, classLower): boolean` in a new `src/find-class-filter.js`: returns false when `r.type === 'markdown' || r.magentoType === 'readme'`, else the current `className`/`path` test copied verbatim from the handler. The handler's `.filter(...)` calls it.

- [ ] **Step 1: Test** — `isClassCandidate({ path: 'app/code/Acme/Price/README.md', type: 'markdown', magentoType: 'readme' }, 'price') === false`; `isClassCandidate({ path: 'app/code/Acme/Price/Model/Price.php', className: 'Acme\\Price\\Model\\Price' }, 'price') === true`.
- [ ] **Step 2–3: Implement, wire, `npm test`.**
- [ ] **Step 4: CHANGELOG `### Fixed`** — `magento_find_class could list README sections of a module whose name contains the class name.`
- [ ] **Step 5: Commit** — `fix(mcp): find_class filters README hits as the changelog promised`

### Task 19: README sections: later `# ` headings and long single lines

**Files:**
- Modify: `rust-core/src/indexer.rs:82-140` (`readme_sections`), tests at `1758-1781`

- [ ] **Step 1: Extend `test_readme_sections`**

Add: `"# Acme_Export\n# Purpose\nExports orders.\n# How it works\n1. cron\n"` → `[("Purpose","Exports orders."), ("How it works","1. cron")]` (first `# ` is the title, later ones are sections). Add: one line of 2 000 characters of words under `## Long` → every chunk `len() <= README_CHUNK_CHARS`, chunks `> 1`, and `chunks.concat() with spaces == original` (split at the last space before the limit).

- [ ] **Step 2: Implement** — track `seen_title: bool`; a `# ` line after the first behaves like `## `. In `push`, when a single line exceeds `README_CHUNK_CHARS`, split it at the last `' '` before the limit (hard split if none) before the existing line loop.
- [ ] **Step 3: CI rust green. CHANGELOG `### Fixed`** — `Module READMEs that use # for every section, or very long paragraphs on one line, are now indexed section by section.`
- [ ] **Step 4: Commit** — `fix(indexer): README sections for H1-only files and unwrapped paragraphs`

- [ ] **Open PR `fix/readme-index-followups`, merge when green.**

---

## Phase 5 — Dependency hygiene (branch `chore/rust-deps`)

### Task 20: Remove unused Rust dependencies, pin ort

**Files:**
- Modify: `rust-core/Cargo.toml`, `rust-core/Cargo.lock` (via `cargo update -p …` in CI or on a machine with cargo)

Fact (grep over `rust-core/src`): `tokio`, `memmap2`, `unicode-normalization`, `thiserror` are never imported; `Cargo.lock` resolves `ort` to `2.0.0-rc.11`.

- [ ] **Step 1: Delete the four dependencies; change `ort = { version = "=2.0.0-rc.11", … }`.**
- [ ] **Step 2: Push; CI `rust` job must build and test green on Linux; the release workflow's four targets are not exercised until the next tag — open the PR and additionally trigger a dry build by pushing a `v0.0.0-ci-test` tag only if the team wants that; otherwise rely on the Linux build and note the risk in the PR.**
- [ ] **Step 3: CHANGELOG `### Changed`** — `Build: four unused Rust crates removed, ONNX Runtime pinned to the version the lockfile already used.`
- [ ] **Step 4: Commit** — `chore(rust): drop unused crates, pin ort`

---

## Deferred to a follow-up plan (out of scope here on purpose)

- Split `src/mcp-server.js` (9 930 lines) along its section headers; registry of tool handlers instead of one `switch`.
- Replace the `grep` binary calls (7 sites) with a JS implementation for Windows.
- Per-path collapse inside Rust `hybrid_search` before `truncate(k)` (changes result counts for every caller; needs an accuracy run on a real install).
- vectordb performance: `path → ids` map for `remove_by_path`, contiguous vector storage, lowercase `search_text` at index time, batch-length padding in the embedder.
- Drop `ruvector` entirely (complexity metrics are 100 lines).
- `validation.rs` data to a JSON file.
- Rewriting git history to drop the 37 MB `dist/` blob (destructive; team decision).
