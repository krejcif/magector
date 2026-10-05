/**
 * A PID means something only inside one PID namespace. MCP instances sharing a Magento root's
 * .magector through a mount from separate containers (an MCP gateway starting one per session)
 * see each other's PIDs as dead, or as an unrelated process of their own: a container took
 * another's serve for its own and never started one, or signalled one of its own processes.
 * So a lock or PID file records the namespace beside the PID, and the PID is checked only from
 * that namespace; from another, the file's mtime (its holder refreshes it) tells whether it lives.
 */
import { existsSync, readFileSync, readlinkSync, statSync } from 'fs';
import os from 'os';

/** This process's PID namespace (Linux), else its host. */
export const PROCESS_SCOPE = (() => {
  try { return readlinkSync('/proc/self/ns/pid'); } catch { return `host:${os.hostname()}`; }
})();

const SCOPE_LINE = /^(pid:\[\d+\]|host:.*)$/;

/**
 * The PID and namespace a lock or PID file records — `pid`, then any lines, one of them the
 * namespace — or null. A file from before namespaces were recorded counts as this namespace's.
 */
export function readPidRecord(file) {
  try {
    if (!existsSync(file)) return null;
    const lines = readFileSync(file, 'utf-8').trim().split('\n');
    const pid = parseInt(lines[0], 10);
    if (!pid || isNaN(pid)) return null;
    const scope = lines.slice(1).find(l => SCOPE_LINE.test(l)) || null;
    return { pid, scope, ours: !scope || scope === PROCESS_SCOPE };
  } catch { return null; }
}

/**
 * Whether the process a record names is alive, as far as this process can tell: one of this
 * namespace is signalled; one of another is alive while `file` was touched within `freshMs`.
 */
export function isRecordAlive(record, file, freshMs) {
  if (!record) return false;
  if (!record.ours) {
    try { return Date.now() - statSync(file).mtimeMs < freshMs; } catch { return false; }
  }
  try { process.kill(record.pid, 0); return true; } catch { return false; }
}
