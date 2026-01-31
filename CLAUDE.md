# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Magector is a semantic code search engine for Magento 2 & Adobe Commerce. It uses a hybrid Node.js + Rust architecture: a thin Node.js layer (CLI + MCP server) delegates all indexing and search to a Rust binary (`magector-core`) that generates ONNX embeddings and searches an HNSW vector index.

## Commands

### Building

```bash
cd rust-core && cargo build --release   # Build Rust binary → rust-core/target/release/magector-core
```

No Node.js build step — `src/` is plain ES modules.

### Testing

```bash
npm test                          # MCP server integration tests (stdio JSON-RPC)
npm run test:no-index             # Skip tools requiring an index
npm run test:accuracy             # 101 E2E queries against Magento 2.4.7 ground truth
npm run test:accuracy:verbose     # Per-query accuracy metrics
npm run validate                  # Full validation suite (downloads Magento 2.4.7 if needed)
npm run benchmark                 # Performance benchmarks (latency, throughput)
```

Rust tests: `cd rust-core && cargo test` (557 unit tests in `validation.rs`).

Tests use no framework — direct Node.js scripts spawning the MCP server via stdio and validating JSON-RPC responses.

### Running Locally

```bash
npx magector init /path/to/magento2    # Full setup: index + IDE config
npx magector search "product price"    # Search indexed code
npx magector stats                     # Show index statistics
npx magector mcp                       # Start MCP server
```

The CLI auto-detects the local Rust build at `rust-core/target/release/magector-core`.

### Releasing

The release is triggered by pushing a `v*` tag to GitHub. The CI workflow (`.github/workflows/release.yml`) builds all platform binaries and publishes to npm.

**Before releasing:**

1. Update `README.md` to reflect any new or changed MCP tools, CLI commands, or features added since the last release. The README is user-facing documentation and must stay in sync with the actual tool set in `src/mcp-server.js`.
2. Update `CHANGELOG.md` with a new section for the version being released. Follow the [Keep a Changelog](https://keepachangelog.com/) format using `Added`, `Changed`, `Fixed`, and `Removed` subsections. Describe user-visible changes only — not internal refactors or CI tweaks unless they affect behavior.

**Preferred (one command):**

```bash
npm version patch && git push origin main --follow-tags
```

`npm version` bumps `package.json`, commits, and creates an **annotated** tag — `--follow-tags` then pushes both the commit and the tag. Use `npm version minor` or `npm version major` for non-patch bumps.

**Manual release (when version was already bumped separately):**

```bash
# 1. Bump version in package.json, commit
# 2. Create annotated tag and push it explicitly:
VERSION=$(node -p "require('./package.json').version")
git tag -a "v${VERSION}" -m "${VERSION}"
git push origin main && git push origin "v${VERSION}"
```

Important: always use `git tag -a` (annotated) or `npm version`. Lightweight tags (`git tag v1.x.x` without `-a`) are **not pushed** by `--follow-tags` and the CI workflow won't trigger. Always push the tag explicitly (`git push origin <tag>`) or use `--follow-tags` with annotated tags.

The CI workflow, triggered by the `v*` tag push, then:
1. Syncs `Cargo.toml` version from `package.json` (so local Cargo.toml version doesn't matter for CI)
2. Builds Rust binaries for 4 platforms (darwin-arm64, linux-x64, linux-arm64, win32-x64)
3. Publishes `@magector/cli-{platform}@{version}` to npm
4. Syncs `optionalDependencies` and publishes `magector@{version}`

After release, keep the local Cargo.toml in sync:
```bash
sed -i '' "s/^version = .*/version = \"$(node -p 'require(\"./package.json\").version')\"/" rust-core/Cargo.toml
```

## Architecture

```
User runs: npx magector search "checkout totals"
    │
    ▼
src/cli.js (Node.js)
    ├─ binary.js → resolves magector-core binary (4-tier fallback)
    ├─ model.js  → resolves ONNX models (auto-downloads from HuggingFace)
    └─ execFileSync(magector-core, ["search", ...])
         │
         ▼
    rust-core/src/main.rs (Rust binary)
         ├─ embedder.rs  → ONNX model, 384-dim embeddings
         ├─ vectordb.rs  → HNSW index + hybrid semantic/keyword reranking
         ├─ indexer.rs   → file discovery, pattern detection, batch embedding
         ├─ ast.rs       → tree-sitter PHP/JS parsing
         ├─ magento.rs   → 20+ Magento pattern detectors
         └─ watcher.rs   → file watcher for incremental re-indexing
```

The MCP server (`src/mcp-server.js`, 20 tools) wraps the same binary in a persistent `serve` subprocess that keeps the ONNX model + HNSW index resident in memory, eliminating the ~2.6s cold start. It also maintains an LRU query cache (200 entries).

### Binary Resolution (src/binary.js)

4-tier fallback with self-healing:
1. `MAGECTOR_BIN` env var
2. `@magector/cli-{os}-{arch}` npm optional dependency — if missing, auto-runs `npm install --no-save` to recover
3. `rust-core/target/release/magector-core` (local dev build)
4. `magector-core` in system PATH

### Cross-Platform Distribution

Rust binaries are distributed as npm optional dependencies (`@magector/cli-darwin-arm64`, etc.). Platform package definitions live in `platforms/*/package.json`; actual binaries are built by CI and never committed. The `optionalDependencies` in the main `package.json` are pinned versions that CI updates at publish time.

### Version Management

**Source of truth**: `package.json` version. CI auto-syncs `Cargo.toml` and platform package versions before building/publishing. The local `Cargo.toml` must be manually synced after release.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `MAGENTO_ROOT` | cwd | Path to Magento installation |
| `MAGECTOR_DB` | `./.magector/index.db` | Index database path |
| `MAGECTOR_BIN` | (auto-resolved) | Override magector-core binary path |
| `MAGECTOR_MODELS` | (auto-resolved) | Override ONNX model directory |
