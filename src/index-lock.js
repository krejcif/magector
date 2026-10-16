/**
 * Cross-entrypoint lock preventing two indexing processes (the MCP server's
 * background reindex, and a manually-invoked `npx magector index`) from
 * writing to the same Magento root's index concurrently. A concurrent write
 * can silently clobber a just-completed, correct index with an empty/partial
 * one — the index costs hours of CPU, so this must be a hard stop, not a race.
 *
 * File format (shared with rust-core/src/watcher.rs): one line, the bare PID.
 */
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import path from 'path';

export function lockPathFor(magentoRoot) {
  return path.join(magentoRoot, '.magector', 'reindex.pid');
}

/**
 * Reads the lock and classifies it:
 *   { state: 'absent' }            no lock file
 *   { state: 'unreadable' }        exists but cannot be read (e.g. EACCES) — not removed here
 *   { state: 'invalid' }           no PID in it — not removed here
 *   { state: 'live', pid }         the holder exists (EPERM = another user's process: alive)
 *   { state: 'stale', pid }        the holder is gone (ESRCH) — the file has been removed
 */
function inspectLock(magentoRoot) {
  const lockPath = lockPathFor(magentoRoot);
  let contents;
  try {
    contents = readFileSync(lockPath, 'utf-8');
  } catch (e) {
    return { state: e.code === 'ENOENT' ? 'absent' : 'unreadable' };
  }
  const pid = parseInt(contents.trim(), 10);
  if (!pid || isNaN(pid)) return { state: 'invalid' };
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return { state: 'live', pid };
  } catch (e) {
    if (e.code === 'EPERM') return { state: 'live', pid }; // exists, owned by another user
    // ESRCH (or anything else that says it is not there): stale, clean up
    try { unlinkSync(lockPath); } catch {}
    return { state: 'stale', pid };
  }
}

/** Returns the PID of a still-running indexer for this root, or null. */
export function getRunningIndexPid(magentoRoot) {
  const lock = inspectLock(magentoRoot);
  return lock.state === 'live' ? lock.pid : null;
}

/**
 * Takes the lock for `pid`, creating the file exclusively. Returns true when the lock now
 * names `pid` (including when it already did), false when a live holder or an I/O error
 * prevents that. A dead holder's, PID-less or unreadable lock is replaced (one retry).
 * Never throws: callers run in timers and child 'exit' handlers with no try/catch.
 */
export function writeIndexPidFile(magentoRoot, pid) {
  const lockPath = lockPathFor(magentoRoot);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, String(pid), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') {
        console.error(`magector: could not write the reindex lock ${lockPath}: ${e.message}`);
        return false;
      }
    }
    if (attempt > 0) break;
    const lock = inspectLock(magentoRoot);
    if (lock.state === 'live') {
      if (lock.pid === Number(pid)) return true; // already ours
      console.error(`magector: reindex lock ${lockPath} is held by live PID ${lock.pid}`);
      return false;
    }
    if (lock.state === 'invalid' || lock.state === 'unreadable') {
      // A lock nobody can read a holder from (the Rust watcher would not defer to it):
      // replace it with a proper one.
      if (lock.state === 'unreadable') console.error(`magector: reindex lock ${lockPath} cannot be read — replacing it`);
      try { unlinkSync(lockPath); } catch {}
    }
    // stale: inspectLock already removed it; absent: vanished meanwhile — retry once
  }
  console.error(`magector: could not take the reindex lock ${lockPath} (another process took it first)`);
  return false;
}

export function removeIndexPidFile(magentoRoot) {
  try { unlinkSync(lockPathFor(magentoRoot)); } catch {}
}
