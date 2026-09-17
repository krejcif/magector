/**
 * Cross-entrypoint lock preventing two indexing processes (the MCP server's
 * background reindex, and a manually-invoked `npx magector index`) from
 * writing to the same Magento root's index concurrently. A concurrent write
 * can silently clobber a just-completed, correct index with an empty/partial
 * one — the index costs hours of CPU, so this must be a hard stop, not a race.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import path from 'path';

export function lockPathFor(magentoRoot) {
  return path.join(magentoRoot, '.magector', 'reindex.pid');
}

/** Returns the PID of a still-running indexer for this root, or null. */
export function getRunningIndexPid(magentoRoot) {
  const lockPath = lockPathFor(magentoRoot);
  try {
    if (!existsSync(lockPath)) return null;
    const pid = parseInt(readFileSync(lockPath, 'utf-8').trim(), 10);
    if (!pid || isNaN(pid)) return null;
    process.kill(pid, 0); // signal 0 = existence check, throws if dead
    return pid;
  } catch {
    // Process doesn't exist or lock file unreadable — stale, clean up
    try { unlinkSync(lockPath); } catch {}
    return null;
  }
}

export function writeIndexPidFile(magentoRoot, pid) {
  try { writeFileSync(lockPathFor(magentoRoot), String(pid)); } catch {}
}

export function removeIndexPidFile(magentoRoot) {
  try {
    const lockPath = lockPathFor(magentoRoot);
    if (existsSync(lockPath)) unlinkSync(lockPath);
  } catch {}
}
