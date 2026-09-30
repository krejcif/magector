/**
 * magento_validate_config and the configuration notice of the DI / event tools.
 *
 * Fixture: tests/fixtures/validate-config — a valid module, a not well-formed frontend di.xml, a
 * di.xml / events.xml with values Magento rejects or reads differently, a broken file in a module
 * disabled in config.php, and a broken file under Test/ (Magento never loads it). Expected messages
 * are the ones Magento 2.4.9 / PHP 8.3 / libxml 2.9.14 produced for these files
 * (src/php/validate-config.php in the Magento container). The native path runs against
 * fake-php.mjs, which answers like src/php/validate-config.php.
 *
 * Usage:
 *   node tests/validate-config.test.js
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, '..', 'src', 'mcp-server.js');
const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'validate-config');

let passed = 0;
let failed = 0;

function check(name, text, { has = [], hasNot = [] }) {
  const missing = has.filter(s => !text.includes(s));
  const unexpected = hasNot.filter(s => text.includes(s));
  if (!missing.length && !unexpected.length) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    return;
  }
  failed++;
  console.log(`  \x1b[31m✗\x1b[0m ${name} — ${[
    missing.length ? `missing: ${missing.map(s => JSON.stringify(s)).join(', ')}` : '',
    unexpected.length ? `unexpected: ${unexpected.map(s => JSON.stringify(s)).join(', ')}` : '',
  ].filter(Boolean).join('; ')}`);
  if (process.env.VALIDATE_CONFIG_DEBUG) console.log(text);
}

class McpClient {
  constructor(env) {
    this.env = env;
    this.nextId = 1;
    this.pending = new Map();
  }

  async start() {
    this.dbDir = mkdtempSync(path.join(os.tmpdir(), 'magector-vc-'));
    this.child = spawn(process.execPath, [SERVER_PATH], {
      cwd: FIXTURE_ROOT,
      env: {
        ...process.env,
        MAGENTO_ROOT: FIXTURE_ROOT,
        MAGECTOR_DB: path.join(this.dbDir, 'index.db'),
        MAGECTOR_AUTO_INDEX: '0',
        MAGECTOR_PHP: '',
        ...this.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', () => {});
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id != null && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      }
    });
    await this.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'validate-config-test', version: '1.0' },
    });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 60000);
      this.pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async call(name, args) {
    const res = await this.request('tools/call', { name, arguments: args });
    return (res.result?.content || []).map(c => c.text || '').join('\n');
  }

  stop() {
    try { this.child.kill(); } catch { /* already exited */ }
    rmSync(this.dbDir, { recursive: true, force: true });
  }
}

const BROKEN = 'app/code/Acme/Broken/etc/frontend/di.xml';
const VALUES_DI = 'app/code/Acme/Values/etc/di.xml';
const VALUES_EVENTS = 'app/code/Acme/Values/etc/events.xml';
const OFF = 'app/code/Acme/Off/etc/di.xml';

async function main() {
  console.log('\nConfiguration validation (fixture: tests/fixtures/validate-config)\n');

  // ── Built-in check ─────────────────────────────────────────────
  const builtin = new McpClient({});   // the fixture has no app/autoload.php → built-in
  await builtin.start();
  try {
    let t = await builtin.call('magento_validate_config', {});
    check('built-in: engine and fallback reason are stated', t, {
      has: ['**Engine:** built-in', 'Native check not available (no app/autoload.php in the Magento root)'],
    });
    check('built-in: not well-formed file — Magento\'s message, libxml first error with its line', t, {
      has: [
        `- \`${BROKEN}:5\``,
        `The XML in file "${path.join(FIXTURE_ROOT, BROKEN)}" is invalid:\nOpening and ending tag mismatch: type line 3 and typ\nLine: 5\n\nVerify the XML and try again.`,
      ],
    });
    check('built-in: plugin disabled="yes" — BooleanUtils exception', t, {
      has: [`- \`${VALUES_DI}:4\``, '<plugin name="values_disabled_yes"> disabled="yes": InvalidArgumentException \'Boolean value is expected, supported values: array (\n  0 => true,'],
    });
    check('built-in: number argument "12px" — Number interpreter exception', t, {
      has: [`- \`${VALUES_DI}:7\``, 'argument "limit": InvalidArgumentException \'Numeric value is expected.\''],
    });
    check('built-in: observer disabled="1" does not disable (read differently than written)', t, {
      has: ['### Loads, but not as written', `- \`${VALUES_EVENTS}:4\``, 'disabled="1" does not disable the observer'],
    });
    check('built-in: sortOrder="10abc" is read as (int) 10', t, { has: ['sortOrder="10abc" is read as (int) 10'] });
    check('built-in: broken file of a disabled module is marked', t, {
      has: [`- \`${OFF}:4\` _(module Acme_Off is disabled — not loaded now, fails once enabled)_`],
    });
    check('built-in: files under Test/ are not checked (Magento does not load them)', t, { hasNot: ['Test/Unit/etc/di.xml'] });
    check('built-in: valid files are not reported', t, { hasNot: ['Acme/Good/etc/di.xml`', 'Acme/Good/etc/events.xml`', 'module.xml`'] });

    t = await builtin.call('magento_validate_config', { path: 'app/code/Acme/Good' });
    check('built-in: scope to a module — no problems', t, {
      has: ['under `app/code/Acme/Good`', '_No problems found by the built-in check (schema not checked)._'],
    });
    t = await builtin.call('magento_validate_config', { path: VALUES_EVENTS });
    check('built-in: scope to a single file', t, { has: ['**Files:** 1 under', `${VALUES_EVENTS}:4`], hasNot: [VALUES_DI] });
    t = await builtin.call('magento_validate_config', { engine: 'native' });
    check('engine native without PHP: says so instead of falling back', t, { has: ['Native check not available: no app/autoload.php'] });

    // ── Notice in the DI / event tools ─────────────────────────────
    t = await builtin.call('magento_find_plugin', { targetClass: 'Acme\\Good\\Model\\Thing' });
    check('find_plugin: notice lists the rejected file of an enabled module', t, {
      has: ['**Magento rejects 2 configuration file(s)**', `\`${BROKEN}:5\` — Opening and ending tag mismatch: type line 3 and typ`, `\`${VALUES_DI}:4\``],
    });
    check('find_plugin: … not the one of a disabled module nor under Test/', t, { hasNot: [`${OFF}:`, 'Test/Unit/etc/di.xml'] });
    t = await builtin.call('magento_find_observer', { eventName: 'acme_good_saved' });
    check('find_observer: warns about the misread value in a file of this answer', t, {
      has: ['**Read differently than written**', `\`${VALUES_EVENTS}:4\` — <observer name="values_observer"> disabled="1" does not disable the observer`],
    });
  } finally {
    builtin.stop();
  }

  // ── Native check (fake PHP) ────────────────────────────────────
  const native = new McpClient({ MAGECTOR_PHP: `"${process.execPath}" "${path.join(FIXTURE_ROOT, 'fake-php.mjs')}"`, MAGECTOR_PHP_ROOT: '/srv/magento' });
  await native.start();
  try {
    const t = await native.call('magento_validate_config', {});
    check('native: engine, PHP and libxml versions are stated', t, {
      has: ['**Engine:** native — Magento\'s classes and readers via `"', 'fake-php.mjs"` (PHP 8.3.0-fake, libxml 2.9.14)'],
    });
    check('native: output after the marker is used, noise before it ignored', t, {
      has: [`FAKE-NATIVE production error for /srv/magento/${BROKEN}`], hasNot: ['Deprecated: noise'],
    });
    check('native: an area Magento\'s reader cannot load fails in every mode', t, {
      has: ['- **DI configuration, area frontend**', 'FAKE-NATIVE frontend reader error\n(Magento\'s reader, production and default mode)'],
    });
    check('native: developer mode comes from the reader (merged schema), not a per-file guess', t, {
      has: ['### Fails in developer mode (schema) (1)', '- **DI configuration, area global**', 'FAKE-NATIVE merged schema error'],
    });
    check('native: converter exception of a file whose area loads → masked by a later file', t, {
      has: ['FAKE-NATIVE converter error\n(Magento converts the merged configuration: a later file overrides this value'],
    });
    check('native: declared-schema violations are their own section, with the caveat', t, {
      has: ['### Violates the schema it declares (1)', 'FAKE-NATIVE declared schema error', 'module.xml is read without one'],
    });
    check('native: built-in warnings are added (Magento does not report them)', t, {
      has: ['### Loads, but not as written', 'disabled="1" does not disable the observer'],
    });
  } finally {
    native.stop();
  }

  const failing = new McpClient({ MAGECTOR_PHP: 'exit 3' });
  await failing.start();
  try {
    const t = await failing.call('magento_validate_config', {});
    check('native command failing: falls back to built-in with the reason', t, {
      has: ['Native check not available (exit 3 failed (exit 3)', '**Engine:** built-in'],
    });
  } finally {
    failing.stop();
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
