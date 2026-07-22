/**
 * Keep optionalDependencies pins in lockstep with the package version.
 *
 * The platform binary packages (@magector/cli-{os}-{arch}) are published from
 * this repo's release pipeline at the SAME version as the main package. The JS
 * wrapper (src/mcp-server.js) and the Rust core binary must match — the wrapper
 * calls subcommands (e.g. `serve`) and expects an index naming that only the
 * matching binary implements. If the pins drift behind the package version, a
 * `git clone` + `npm install` pulls an incompatible old binary and the server
 * re-indexes on every startup (see CHANGELOG 2.16.16).
 *
 * The release workflow already rewrites these pins at publish time, but that
 * change lives only in the published tarball — it is never committed back, so
 * the git tree drifts forever. This script is wired into the `version` npm
 * lifecycle hook so every `npm version` bump commits matching pins.
 *
 * Usage:
 *   node scripts/sync-optional-deps.mjs [path/to/package.json]
 * Defaults to this repo's package.json when no path is given.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Return a copy of `pkg` with every optionalDependencies entry set to
 * `pkg.version`. Pure — does not mutate the input. Key order is preserved.
 */
export function syncOptionalDeps(pkg) {
  const version = pkg.version;
  const optionalDependencies = { ...(pkg.optionalDependencies || {}) };
  for (const key of Object.keys(optionalDependencies)) {
    optionalDependencies[key] = version;
  }
  return { ...pkg, optionalDependencies };
}

function main() {
  const pkgPath = process.argv[2] || fileURLToPath(new URL('../package.json', import.meta.url));
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const updated = syncOptionalDeps(pkg);
  // Match the formatting the release pipeline writes: 2-space indent + trailing newline.
  writeFileSync(pkgPath, JSON.stringify(updated, null, 2) + '\n');
  const count = Object.keys(updated.optionalDependencies || {}).length;
  console.log(`Synced ${count} optionalDependencies to ${updated.version}`);
}

// Run main() only when executed directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
