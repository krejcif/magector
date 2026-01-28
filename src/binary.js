/**
 * Resolve the platform-specific Rust binary (magector-core).
 *
 * Resolution order:
 * 1. MAGECTOR_BIN env var
 * 2. @magector/cli-{os}-{arch} optionalDependency
 * 3. rust-core/target/release/magector-core (dev fallback)
 * 4. magector-core in PATH
 */
import { existsSync, chmodSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const BINARY_NAME = process.platform === 'win32' ? 'magector-core.exe' : 'magector-core';

export function resolveBinary() {
  // 1. Explicit env var
  if (process.env.MAGECTOR_BIN) {
    if (existsSync(process.env.MAGECTOR_BIN)) {
      return process.env.MAGECTOR_BIN;
    }
    throw new Error(`MAGECTOR_BIN set to ${process.env.MAGECTOR_BIN} but file not found`);
  }

  // 2. Platform-specific npm package
  const platformPkg = `@magector/cli-${process.platform}-${process.arch}`;
  try {
    const pkgDir = path.dirname(require.resolve(`${platformPkg}/package.json`));
    const binPath = path.join(pkgDir, 'bin', BINARY_NAME);
    if (existsSync(binPath)) {
      // npm doesn't preserve execute permissions — ensure the binary is executable
      if (process.platform !== 'win32') {
        try { chmodSync(binPath, 0o755); } catch {}
      }
      return binPath;
    }
  } catch {
    // Package not installed — continue
  }

  // 3. Dev fallback: local Rust build
  const devPath = path.join(__dirname, '..', 'rust-core', 'target', 'release', BINARY_NAME);
  if (existsSync(devPath)) {
    return devPath;
  }

  // 4. Global PATH
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(which, ['magector-core'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    if (result) return result.split('\n')[0];
  } catch {
    // Not in PATH
  }

  throw new Error(
    `Could not find magector-core binary.\n` +
    `Install the platform package: npm install ${platformPkg}\n` +
    `Or build from source: cd rust-core && cargo build --release\n` +
    `Or set MAGECTOR_BIN environment variable.`
  );
}
