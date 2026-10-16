/**
 * After a background re-index swaps its index in, the MCP server restarts serve. The old
 * serve still holds the previous index in memory and its watcher would save that over the
 * new one, so the re-index lock (.magector/reindex.pid) must stay until that serve has exited.
 *
 * Runs the real MCP server against a fake magector-core (a bash script): `stats` reports an
 * incompatible index, `index` writes a new one and exits 0, `serve` takes 2s to obey SIGTERM
 * and records whether the lock file exists at each step.
 *
 * Usage: node tests/mcp-reindex-lock.test.js   (needs bash; skipped on Windows)
 */

import { spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

if (process.platform === 'win32') {
  console.log('  ○ mcp re-index lock — skipped (needs bash)');
  process.exit(0);
}

const SERVER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp-server.js');
const root = mkdtempSync(path.join(os.tmpdir(), 'magector-lock-'));
const timeline = path.join(root, 'timeline.log');
const fakeCore = path.join(root, 'fake-core.sh');
mkdirSync(path.join(root, '.magector'));
writeFileSync(path.join(root, '.magector', 'index.db'), Buffer.alloc(4096));
writeFileSync(fakeCore, `#!/bin/bash
ts() { echo "$*" >> "$FAKE_TIMELINE"; }
lock() { [ -e "$FAKE_ROOT/.magector/reindex.pid" ] && echo yes || echo no; }
cmd="$1"; shift
case "$cmd" in
  stats) echo "Total vectors: 0" ;;
  index)
    while [ $# -gt 0 ]; do case "$1" in -d) db="$2"; shift 2;; *) shift;; esac; done
    sleep 1; head -c 4096 /dev/zero > "$db"; ts "index-done" ;;
  serve)
    ts "serve-start"
    echo '{"ready":true}'
    trap 'ts "term lock=$(lock)"; sleep 2; ts "before-exit lock=$(lock)"; ts "serve-exit"; exit 0' TERM
    while read -r line; do echo '{"ok":true,"data":{}}'; done ;;
esac
`);
chmodSync(fakeCore, 0o755);

const server = spawn('node', [SERVER_PATH], {
  stdio: ['pipe', 'ignore', 'ignore'], // stdin stays open: the server exits when it closes
  env: {
    ...process.env,
    MAGECTOR_AUTO_INDEX: '1', // this test needs the startup re-index; CI exports 0
    MAGENTO_ROOT: root,
    MAGECTOR_BIN: fakeCore,
    MAGECTOR_NO_UPDATE: '1',
    FAKE_ROOT: root,
    FAKE_TIMELINE: timeline,
  },
});

const lines = () => (existsSync(timeline) ? readFileSync(timeline, 'utf-8').split('\n').filter(Boolean) : []);
const deadline = Date.now() + 30000;
while (!lines().includes('serve-exit') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
await new Promise((r) => setTimeout(r, 500)); // the lock is removed just after the exit is seen
const lockGone = !existsSync(path.join(root, '.magector', 'reindex.pid'));
const seen = lines();
server.kill();
try { rmSync(root, { recursive: true, force: true }); } catch {}

const failures = [];
if (!seen.includes('serve-exit')) failures.push(`the old serve was never restarted (${seen.join(' | ')})`);
if (!seen.includes('term lock=yes')) failures.push(`the lock was already gone when the old serve got SIGTERM (${seen.join(' | ')})`);
if (!seen.includes('before-exit lock=yes')) failures.push(`the lock was released while the old serve was still running (${seen.join(' | ')})`);
if (!lockGone) failures.push('the lock outlived the old serve');

if (failures.length) {
  failures.forEach((f) => console.log(`  \x1b[31m✗\x1b[0m mcp re-index lock — ${f}`));
  process.exit(1);
}
console.log('  \x1b[32m✓\x1b[0m mcp re-index lock is held until the old serve has exited');
process.exit(0);
