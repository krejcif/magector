#!/usr/bin/env node
/**
 * Compare Magector with ground truth taken from a Magento installation (see README.md).
 *
 *   node compare.mjs php     <magento-root> php-truth.json
 *   node compare.mjs xml     <magento-root> xml-truth.json
 *   node compare.mjs plugins <magento-root> runtime-plugins.json [area]
 *   node compare.mjs config  <magento-root> config-truth.json
 *
 * php     — src/di-config.js class / method reading vs PHP's tokenizer
 * xml     — src/di-config.js di.xml / events.xml reading vs DOMDocument (and files Magento rejects)
 * plugins — magento_find_plugin (MCP server, structural part) vs the plugins Magento runs
 * config  — the built-in configuration check (checkXmlWellFormed, checkConfigValues) vs Magento's
 *           own classes (src/php/validate-config.php): first libxml error, converter exceptions
 *
 * Exit code 1 when anything differs.
 */

import { readFileSync } from 'fs';
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  parsePhpTypes, parsePhpMembers, parseDiXml, parseXml, parseEventsXml, checkXmlWellFormed, checkConfigValues,
} from '../../src/di-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const [mode, rootArg, truthFile, areaArg] = process.argv.slice(2);
if (!mode || !rootArg || !truthFile) {
  console.error('usage: node compare.mjs php|xml|plugins|config <magento-root> <truth.json> [area]');
  process.exit(2);
}
const root = path.resolve(rootArg);
// config-truth.json is the raw output of validate-config.php: the JSON follows a marker line
const truthText = readFileSync(truthFile, 'utf-8');
const marker = truthText.lastIndexOf('@@MAGECTOR-VALIDATE-CONFIG@@');
const truth = JSON.parse(marker < 0 ? truthText : truthText.slice(marker + '@@MAGECTOR-VALIDATE-CONFIG@@'.length));
const show = (title, list, n = 15) => {
  console.log(`${title}: ${list.length}`);
  for (const l of list.slice(0, n)) console.log(`  ${l}`);
};

if (mode === 'php') {
  const miss = [], extra = [], methMiss = [], methWrong = [], methExtra = [];
  let files = 0, classes = 0;
  for (const [rel, cls] of Object.entries(truth)) {
    const src = readFileSync(path.join(root, rel), 'utf-8');
    files++;
    const got = new Map(parsePhpTypes(src).map(t => [t.fqcn.toLowerCase(), t]));
    for (const [fqcn, info] of Object.entries(cls)) {
      classes++;
      if (info.kind !== 'trait' && !got.has(fqcn.toLowerCase())) miss.push(`${rel} ${fqcn}`);
      const members = parsePhpMembers(src, fqcn.split('\\').pop());
      if (!members) { methMiss.push(`${rel} ${fqcn} (class not read)`); continue; }
      const want = Array.isArray(info.methods) ? {} : info.methods;
      for (const [m, [vis, isStatic, isFinal]] of Object.entries(want)) {
        const g = members.methods.get(m);
        if (!g) methMiss.push(`${rel} ${fqcn}::${m}`);
        else if (g.visibility !== vis || g.isStatic !== isStatic || g.isFinal !== isFinal) {
          methWrong.push(`${rel} ${fqcn}::${m} expected ${vis}/${isStatic}/${isFinal} got ${g.visibility}/${g.isStatic}/${g.isFinal}`);
        }
      }
      for (const k of members.methods.keys()) if (!(k in want)) methExtra.push(`${rel} ${fqcn}::${k}`);
    }
    for (const [k, t] of got) if (!Object.keys(cls).some(c => c.toLowerCase() === k)) extra.push(`${rel} ${t.fqcn}`);
  }
  console.log(`files ${files}, classes ${classes}`);
  show('classes missing', miss); show('classes extra', extra);
  show('methods missing', methMiss); show('methods wrong', methWrong); show('methods extra', methExtra);
  process.exit(miss.length + extra.length + methMiss.length + methWrong.length + methExtra.length ? 1 : 0);
}

if (mode === 'xml') {
  const bad = [], rejected = [];
  let files = 0;
  for (const [rel, t] of Object.entries(truth)) {
    files++;
    const content = readFileSync(path.join(root, rel), 'utf-8');
    const reported = checkXmlWellFormed(content).length > 0;
    if (t.error) {
      rejected.push(rel);
      if (!reported) bad.push(`${rel} Magento rejects it, the built-in check does not report it:\n    ${t.error.split('\n').join('\n    ')}`);
      continue;
    }
    if (reported) { bad.push(`${rel} loads in Magento, the built-in check reports ${JSON.stringify(checkXmlWellFormed(content)[0])}`); continue; }
    if (rel.endsWith('events.xml')) {
      const names = new Set();
      (function walk(n) { for (const c of n.children) { if (c.name === 'event' && c.attrs.name) names.add(c.attrs.name); walk(c); } })(parseXml(content));
      let obs = 0;
      for (const e of names) obs += parseEventsXml(content, rel, e).length;
      if (obs !== t.obs) bad.push(`${rel} observers expected ${t.obs} got ${obs}`);
    } else {
      const d = parseDiXml(content, rel);
      const all = [...d.types, ...d.virtualTypes];
      const got = {
        p: all.reduce((a, x) => a + x.plugins.length, 0),
        pref: d.preferences.length,
        obj: all.reduce((a, x) => a + x.objectRefs.length, 0),
      };
      for (const k of ['p', 'pref', 'obj']) if (got[k] !== t[k]) bad.push(`${rel} ${k} expected ${t[k]} got ${got[k]}`);
    }
  }
  console.log(`files ${files}`);
  show('differences', bad);
  show('files Magento rejects (reported by the built-in check too)', rejected, 5);
  process.exit(bad.length ? 1 : 0);
}

if (mode === 'plugins') {
  const area = areaArg || 'global';
  const expected = truth[area];
  if (!expected) { console.error(`no area "${area}" in ${truthFile}`); process.exit(2); }
  const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'src', 'mcp-server.js')], {
    cwd: root,
    env: { ...process.env, MAGENTO_ROOT: root },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const rl = createInterface({ input: child.stdout });
  const pending = new Map();
  rl.on('line', line => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  let id = 0;
  const request = (method, params) => new Promise(resolve => {
    const n = ++id;
    pending.set(n, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  let tp = 0, fn = 0, fp = 0;
  const missed = [], extraActive = [];
  for (const [cls, want] of Object.entries(expected)) {
    const res = await request('tools/call', { name: 'magento_find_plugin', arguments: { targetClass: cls } });
    const text = (res.result?.content || []).map(c => c.text || '').join('\n');
    const regs = [...text.matchAll(/^- \*\*(.+?)\*\* → (?:`[^`]*`|_\(no type[^)]*\)_)(?: \(virtual type of `[^`]*`\))? \[([a-z_]+)\]([^\n]*)/gm)];
    const byName = new Map();
    for (const [, name, a, rest] of regs) {
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push({ area: a, disabled: rest.includes('[DISABLED]'), notRunning: rest.includes('does not run') });
    }
    const effDisabled = new Set([...text.matchAll(/^- \*\*(.+?)\*\* \[([a-z_]+)\]: `[^`]*` — \*\*disabled\*\*/gm)]
      .filter(m => m[2] === area || m[2] === 'global').map(m => m[1]));
    const moduleOff = new Set([...text.matchAll(/^- \*\*(.+?)\*\*: declaration in `[^`]+` is ignored/gm)].map(m => m[1]));
    const active = [...byName].filter(([n, v]) => v.some(r => (r.area === 'global' || r.area === area) && !r.disabled && !r.notRunning)
      && !effDisabled.has(n) && !moduleOff.has(n)).map(([n]) => n);
    const wantSet = new Set(want.filter(w => !w.startsWith('__error__')));
    for (const w of wantSet) { if (byName.has(w)) tp++; else { fn++; missed.push(`${cls}: ${w}`); } }
    for (const a of active) if (!wantSet.has(a)) { fp++; extraActive.push(`${cls}: ${a}`); }
  }
  child.kill();
  const total = tp + fn;
  console.log(`area ${area}: classes ${Object.keys(expected).length}, plugins that run ${total}`);
  console.log(`recall ${total ? Math.round((100 * tp) / total) : 100} % (${tp}/${total}), reported as running but do not: ${fp}`);
  show('missed', missed); show('reported as running but do not', extraActive);
  process.exit(fn + fp ? 1 : 0);
}


if (mode === 'config') {
  // First fatal libxml error: same line and message (libxml appends the start of a comment / CDATA
  // section to some messages; the built-in check reports the stable prefix).
  const PREFIX_MESSAGES = ['Double hyphen within comment: <!--', 'CData section not finished', 'Comment not terminated'];
  const sameXmlError = (mine, native) => (!mine && !native) || (mine && native && mine.line === native.line &&
    (native.message === mine.message || native.message === `ValueError: ${mine.message}` ||
      (PREFIX_MESSAGES.includes(mine.message) && native.message.startsWith(mine.message))));
  // Converter exception text without the class, and without the file / line of a PHP warning
  const converterText = e => e.replace(/^[\w\\]+: /, '').replace(/^(Warning: .*?) in \/.*$/s, '$1');
  const xmlDiff = [], convertDiff = [], nativeOnly = [];
  let files = 0, invalid = 0, converterErrors = 0;
  for (const f of truth.files) {
    files++;
    const content = readFileSync(path.join(root, f.file), 'utf-8');
    const native = content === '' ? { line: 0, message: f.production } : f.xmlErrors.find(e => e.level === 3) || null;
    const mine = checkXmlWellFormed(content)[0] || null;
    if (native) invalid++;
    if (!sameXmlError(mine, native)) xmlDiff.push(`${f.file} native ${JSON.stringify(native)} built-in ${JSON.stringify(mine)}`);
    if (native || !/(^|\/)(di|events)\.xml$/.test(f.file)) continue;
    const errors = checkConfigValues(content, f.file).filter(p => p.severity === 'error');
    if (f.convert) {
      converterErrors++;
      const want = converterText(f.convert);
      if (/^Constant "/.test(want) || /init_parameter/.test(want)) { nativeOnly.push(`${f.file} ${want}`); continue; }
      if (!errors.length || !errors[0].message.includes(want)) convertDiff.push(`${f.file} native "${want}" built-in ${JSON.stringify(errors[0]?.message ?? null)}`);
    } else if (errors.length) {
      convertDiff.push(`${f.file} loads natively, built-in reports ${JSON.stringify(errors[0].message)}`);
    }
  }
  console.log(`files ${files}: ${invalid} not well-formed, ${converterErrors} with a converter exception (PHP ${truth.php}, libxml ${truth.libxml})`);
  show('first libxml error differs', xmlDiff);
  show('converter verdict differs', convertDiff);
  show('native only (needs PHP: const / init_parameter arguments)', nativeOnly, 5);
  process.exit(xmlDiff.length + convertDiff.length ? 1 : 0);
}

console.error(`unknown mode "${mode}"`);
process.exit(2);
