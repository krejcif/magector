#!/usr/bin/env node
/**
 * Compare Magector with ground truth taken from a Magento installation (see README.md).
 *
 *   node compare.mjs php     <magento-root> php-truth.json
 *   node compare.mjs xml     <magento-root> xml-truth.json
 *   node compare.mjs plugins <magento-root> runtime-plugins.json [area]
 *   node compare.mjs config  <magento-root> config-truth.json
 *   node compare.mjs webapi|graphql|cron|dbschema <magento-root> <kind>-truth.json   (config-truth.php)
 *
 * php     — src/di-config.js class / method reading vs PHP's tokenizer
 * xml     — src/di-config.js di.xml / events.xml reading vs DOMDocument (and files Magento rejects)
 * plugins — magento_find_plugin (MCP server, structural part) vs the plugins Magento runs
 * config  — the built-in configuration check (checkXmlWellFormed, checkConfigValues) vs Magento's
 *           own classes (src/php/validate-config.php): first libxml error, converter exceptions
 * webapi / graphql / cron / dbschema — src/magento-config.js merged models vs what Magento reads
 *           (routes → service, type fields → resolver, cron jobs, declared tables / columns / keys).
 *           Missing = Magector returns less (must be 0); extra = more (listed, should be explainable)
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
  buildModuleIndex,
} from '../../src/di-config.js';
import {
  moduleConfigFiles, buildWebapiModel, buildGraphqlModel, buildCronModel, buildDbSchemaModel, discoverModules,
} from '../../src/magento-config.js';
import { existsSync } from 'fs';
import { glob } from 'glob';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const [mode, rootArg, truthFile, areaArg] = process.argv.slice(2);
if (!mode || !rootArg || !truthFile) {
  console.error('usage: node compare.mjs php|xml|plugins|config|webapi|graphql|cron|dbschema <magento-root> <truth.json> [area]');
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

if (['webapi', 'graphql', 'cron', 'dbschema', 'modules'].includes(mode)) {
  // the module discovery the MCP server uses (registrations), so the check covers it too
  const moduleXmls = (await discoverModules(root)).moduleXmls
    .map(rel => ({ relPath: rel, content: readFileSync(path.join(root, rel), 'utf-8') }));
  let configPhp = null;
  try { configPhp = readFileSync(path.join(root, 'app/etc/config.php'), 'utf-8'); } catch { /* not installed */ }
  const idx = buildModuleIndex(moduleXmls, configPhp);
  const exists = rel => existsSync(path.join(root, rel));
  const load = fileName => moduleConfigFiles(idx, exists, fileName)
    .map(f => ({ ...f, content: readFileSync(path.join(root, f.relPath), 'utf-8') }));
  const missing = [], wrong = [], extra = [], dynamicTypes = [];
  let compared = 0;
  if (mode === 'webapi') {
    const model = buildWebapiModel(load('webapi.xml'));
    for (const [url, methods] of Object.entries(truth)) {
      for (const [method, want] of Object.entries(methods)) {
        compared++;
        const got = model.get(`${url} ${method}`);
        if (!got) { missing.push(`${method} ${url}`); continue; }
        if (got.serviceClass !== want.class || got.serviceMethod !== want.method) wrong.push(`${method} ${url}: Magento ${want.class}::${want.method}, Magector ${got.serviceClass}::${got.serviceMethod}`);
        const res = [...got.resources].sort().join(','), wantRes = [...want.resources].sort().join(',');
        if (res !== wantRes) wrong.push(`${method} ${url}: ACL Magento [${wantRes}] Magector [${res}]`);
      }
    }
    for (const r of model.values()) if (!truth[r.url]?.[r.method]) extra.push(`${r.method} ${r.url}`);
  } else if (mode === 'graphql') {
    const { types, errors } = buildGraphqlModel(load('schema.graphqls'));
    for (const e of errors) wrong.push(`parse error ${e.relPath}:${e.line} ${e.message}`);
    let dynamic = 0;
    for (const [name, want] of Object.entries(truth)) {
      dynamic += Object.keys(want.dynamicFields || {}).length;
      if (want.fromFiles === false) { dynamicTypes.push(name); continue; }
      const got = types.get(name);
      if (!got) { missing.push(`type ${name}`); continue; }
      for (const [field, resolver] of Object.entries(want.fields || {})) {
        compared++;
        const f = got.fields.get(field);
        if (!f) { missing.push(`${name}.${field}`); continue; }
        if ((f.resolver || null) !== (resolver || null)) wrong.push(`${name}.${field}: Magento ${resolver}, Magector ${f.resolver}`);
      }
      if ((want.typeResolver || null) !== (got.typeResolver || null)) wrong.push(`${name} typeResolver: Magento ${want.typeResolver}, Magector ${got.typeResolver}`);
      for (const field of got.fields.keys()) if (!(field in (want.fields || {}))) extra.push(`${name}.${field}`);
    }
    for (const name of types.keys()) if (!truth[name]) extra.push(`type ${name}`);
    console.log(`graphql: ${dynamic} fields and ${dynamicTypes.length} types come from the other schema readers (EAV), not from files`);
  } else if (mode === 'cron') {
    const model = buildCronModel(load('crontab.xml'), load('config.xml'));
    const db = truth.__core_config_data__ || {};
    delete truth.__core_config_data__;
    const fromDb = (group, name) => Object.keys(db).some(p => p.startsWith(`crontab/${group}/jobs/${name}/`));
    const dbOnly = [];
    for (const [group, jobs] of Object.entries(truth)) {
      for (const [name, want] of Object.entries(jobs)) {
        compared++;
        const got = model.get(`${group}/${name}`);
        if (!got) { (fromDb(group, name) ? dbOnly : missing).push(`${group}/${name}`); continue; }
        for (const [k, gk] of [['instance', 'instance'], ['method', 'method'], ['schedule', 'schedule'], ['config_path', 'configPath']]) {
          if ((want[k] ?? null) !== (got[gk] ?? null)) {
            (fromDb(group, name) ? dbOnly : wrong).push(`${group}/${name} ${k}: Magento ${JSON.stringify(want[k])}, Magector ${JSON.stringify(got[gk] ?? null)}`);
          }
        }
      }
    }
    for (const j of model.values()) if (!truth[j.group]?.[j.name]) extra.push(`${j.group}/${j.name}`);
    show('from core_config_data (saved in the admin, not in any file)', dbOnly);
  } else if (mode === 'modules') {
    // module directories and load order: every module Magento registers must be found where it is
    const enabledOrder = Object.entries(truth).filter(([, m]) => m.enabled).sort((a, b) => a[1].order - b[1].order).map(([n]) => n);
    const ours = [...idx.modules.values()].filter(m => m.enabled === true).sort((a, b) => idx.orderOf(a.name) - idx.orderOf(b.name)).map(m => m.name);
    for (const [name, want] of Object.entries(truth)) {
      compared++;
      const got = idx.modules.get(name);
      if (!got) { missing.push(`${name} (${want.dir})`); continue; }
      if (got.dir !== want.dir) wrong.push(`${name}: Magento ${want.dir}, Magector ${got.dir}`);
      if ((got.enabled === true) !== want.enabled) wrong.push(`${name}: enabled Magento ${want.enabled}, Magector ${got.enabled}`);
    }
    if (enabledOrder.join() !== ours.join()) wrong.push('load order of the enabled modules differs');
    for (const name of idx.modules.keys()) if (!truth[name]) extra.push(`${name} (${idx.modules.get(name).dir}) — module.xml without registration.php`);
  } else {
    const files = load('db_schema.xml');
    if (exists('app/etc/db_schema.xml')) files.push({ relPath: 'app/etc/db_schema.xml', module: null, content: readFileSync(path.join(root, 'app/etc/db_schema.xml'), 'utf-8') });
    const model = buildDbSchemaModel(files);
    var shardFallback = 0;
    for (const [name, want] of Object.entries(truth)) {
      compared++;
      const got = model.get(name);
      if (!got || got.disabled) { missing.push(`table ${name}`); continue; }
      // A declared resource without a connection in app/etc/env.php falls back to default (Sharding)
      if (got.resource !== want.resource && want.resource !== 'default') wrong.push(`${name} resource: Magento ${want.resource}, Magector ${got.resource}`);
      if (got.resource !== want.resource && want.resource === 'default') shardFallback++;
      for (const [kind, map] of [['columns', got.columns], ['indexes', got.indexes], ['constraints', got.constraints]]) {
        const live = [...map.values()].filter(v => !v.disabled).map(v => v.dbName);
        for (const k of want[kind]) if (!live.includes(k)) missing.push(`${name} ${kind} ${k}`);
        for (const k of live) if (!want[kind].includes(k)) extra.push(`${name} ${kind} ${k}`);
      }
    }
    for (const [name, t] of model) if (!t.disabled && !truth[name]) extra.push(`table ${name}`);
  }
  console.log(`${mode}: ${compared} compared`);
  if (mode === 'dbschema' && shardFallback) console.log(`declared resource without a connection (runs on default): ${shardFallback} tables`);
  show('missing (Magector returns less)', missing);
  show('different', wrong);
  show('extra (Magector returns more)', extra);
  process.exit(missing.length + wrong.length ? 1 : 0);
}

console.error(`unknown mode "${mode}"`);
process.exit(2);
