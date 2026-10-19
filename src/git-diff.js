// Git access for magento_analyze_diff. Never goes through a shell: the ref comes
// from an MCP client, so it is validated and passed to git as an argv entry.
// isSafeGitRef rejects a leading '-', so no `--end-of-options` is needed (git
// before 2.24 does not know that flag).
import { execFileSync } from 'child_process';

// A ref name, optionally followed by a numeric reflog selector (HEAD@{1}, stash@{0}).
const SAFE_REF = /^[0-9A-Za-z][\w.\/^~-]{0,127}(@\{\d{1,9}\})?$/;

export function isSafeGitRef(ref) {
  return typeof ref === 'string' && SAFE_REF.test(ref) && !ref.includes('..');
}

// Runs git and returns stdout. On failure throws an Error carrying git's stderr
// (or the spawn error when git itself could not run).
function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = err && err.stderr ? String(err.stderr).trim() : '';
    throw new Error(stderr || (err && err.message) || 'git failed');
  }
}

export function commitDiff(root, ref) {
  if (!isSafeGitRef(ref)) return '';
  try {
    return git(root, ['show', '--format=', ref]);
  } catch (err) {
    throw new Error(`git show failed for ${ref}: ${err.message}`);
  }
}

export function stagedDiff(root) {
  try {
    // Outside a repository `git diff` falls back to --no-index mode and reports
    // "unknown option `cached'"; ask git first so the error says what is wrong.
    git(root, ['rev-parse', '--git-dir']);
    return git(root, ['diff', '--cached']);
  } catch (err) {
    throw new Error(`git diff --cached failed: ${err.message}`);
  }
}

// The subject is decoration for the analysis; a failure here yields ''.
export function commitSubject(root, ref) {
  if (!isSafeGitRef(ref)) return '';
  try {
    return git(root, ['log', '-1', '--format=%s', ref]).trim();
  } catch {
    return '';
  }
}
