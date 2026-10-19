/**
 * Resolve the platform-specific Rust binary (magector-core).
 *
 * Resolution order:
 * 1. MAGECTOR_BIN env var
 * 2. @magector/cli-{os}-{arch} optionalDependency
 * 3. rust-core/target/release/magector-core (dev fallback)
 * 4. magector-core in PATH, only of this package's version
 */
import { existsSync, chmodSync } from 'fs';
import { execFileSync } from 'child_process';
import { npmInvocation } from './npm-cli.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const BINARY_NAME = process.platform === 'win32' ? 'magector-core.exe' : 'magector-core';
const PACKAGE_VERSION = require('../package.json').version;
const PLATFORM_PKG = `@magector/cli-${process.platform}-${process.arch}`;

/** The version `magector-core --version` reports ("magector X.Y.Z"), or null. */
export function binaryVersion(binPath) {
  try {
    const out = execFileSync(binPath, ['--version'], { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
    return out.match(/\b(\d+\.\d+\.\d+\S*)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * A magector-core found on PATH, if it is this package's version. Any other version is
 * refused: nothing on PATH is guaranteed to match, an old one cannot read the current index
 * format, and before 2.16.21 a `stats` that could not decode an index deleted it (a leftover
 * 1.4.3 on PATH wiped a 92k-file index that way). MAGECTOR_BIN runs a specific binary.
 */
export function acceptPathBinary(binPath, expected = PACKAGE_VERSION) {
  const found = binaryVersion(binPath);
  if (found === expected) return binPath;
  throw new Error(
    `magector-core on PATH (${binPath}) is ${found ? `version ${found}` : 'of an unknown version'}, but magector is ${expected}.\n` +
    `Install the platform package: npm install ${PLATFORM_PKG}@${expected}\n` +
    `Or set MAGECTOR_BIN to run that binary anyway.`
  );
}

export function resolveBinary() {
  // 1. Explicit env var
  if (process.env.MAGECTOR_BIN) {
    if (existsSync(process.env.MAGECTOR_BIN)) {
      return process.env.MAGECTOR_BIN;
    }
    throw new Error(`MAGECTOR_BIN set to ${process.env.MAGECTOR_BIN} but file not found`);
  }

  // 2. Platform-specific npm package
  const platformPkg = PLATFORM_PKG;
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
    // Package not installed — try to self-heal by installing it
    try {
      const pkgRoot = path.join(__dirname, '..');
      // This package's version: an unpinned install takes the latest, which can be a
      // different binary than the JS it runs under.
      const inv = npmInvocation('npm', ['install', '--no-save', `${platformPkg}@${PACKAGE_VERSION}`]);
      execFileSync(inv.file, inv.args, {
        shell: inv.shell,
        cwd: pkgRoot,
        timeout: 60000,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      // Retry resolution after install
      const pkgDir = path.dirname(require.resolve(`${platformPkg}/package.json`));
      const binPath = path.join(pkgDir, 'bin', BINARY_NAME);
      if (existsSync(binPath)) {
        if (process.platform !== 'win32') {
          try { chmodSync(binPath, 0o755); } catch {}
        }
        return binPath;
      }
    } catch {
      // Self-heal failed — continue to other fallbacks
    }
  }

  // 3. Dev fallback: local Rust build
  const devPath = path.join(__dirname, '..', 'rust-core', 'target', 'release', BINARY_NAME);
  if (existsSync(devPath)) {
    return devPath;
  }

  // 4. Global PATH
  let pathBinary = null;
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(which, ['magector-core'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    pathBinary = result.split('\n')[0].trim() || null;
  } catch {
    // Not in PATH
  }
  if (pathBinary) return acceptPathBinary(pathBinary);

  throw new Error(
    `Could not find magector-core binary.\n` +
    `Install the platform package: npm install ${platformPkg}\n` +
    `Or build from source: cd rust-core && cargo build --release\n` +
    `Or set MAGECTOR_BIN environment variable.`
  );
}
