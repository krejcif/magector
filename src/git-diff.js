// Git access for magento_analyze_diff. Never goes through a shell: the ref comes
// from an MCP client, so it is validated and passed to git as an argv entry.
import { execFileSync } from 'child_process';

const SAFE_REF = /^[0-9A-Za-z][\w.\/^~-]{0,127}$/;

export function isSafeGitRef(ref) {
  return typeof ref === 'string' && SAFE_REF.test(ref) && !ref.includes('..');
}

function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

export function commitDiff(root, ref) {
  if (!isSafeGitRef(ref)) return '';
  return git(root, ['show', '--format=', '--end-of-options', ref]);
}

export function stagedDiff(root) {
  return git(root, ['diff', '--cached']);
}

export function commitSubject(root, ref) {
  if (!isSafeGitRef(ref)) return '';
  return git(root, ['log', '-1', '--format=%s', '--end-of-options', ref]).trim();
}
