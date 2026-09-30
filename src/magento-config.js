/**
 * Structural readers for webapi.xml, schema.graphqls, crontab.xml (+ config.xml crontab defaults),
 * db_schema.xml and module directories — merged the way Magento merges them, so the tools that
 * answer from them return what Magento loads (or more, marked), never less.
 *
 * Magento behaviour ported here (Mage-OS 2.4.9; verified with scripts/verify-magento/config-truth.php):
 * - Files: `<module dir>/etc/<file>` of the enabled modules, in app/etc/config.php order
 *   (Module\Dir\Reader::getConfigurationFiles); db_schema.xml also app/etc/db_schema.xml, read last.
 * - webapi.xml: Webapi\Model\Config\Reader merges routes by (url, method), resources by ref; a later
 *   <service> overrides class / method attribute by attribute. Converter trims the url.
 * - schema.graphqls: GraphQlReader merges types of the same name with array_replace_recursive in file
 *   order (`extend type X` is read as `type X`), then copies every implemented interface's fields into
 *   the type (array_replace: a field the type declares replaces the interface's field whole).
 * - crontab.xml: Cron\Model\Config\Reader\Xml merges groups by id, jobs by name; then the `crontab`
 *   section of the system config (config.xml defaults, then core_config_data) is merged over it —
 *   schedule / config_path / run model; a job can exist only there.
 * - db_schema.xml: tables by name, columns by name, constraints / indexes by referenceId; an element
 *   with disabled="true" is dropped from the declaration.
 */

import { createHash } from 'crypto';
import { readFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import { glob } from 'glob';
import { parseXml, normalizeClassName } from './di-config.js';

// ─── Registered modules ─────────────────────────────────────────
// Magento reads configuration only from the etc/ of registered modules and app/etc. Files outside
// them (dev/tests sandboxes, the magento2-base copy of app/etc, unregistered copies of a module) are
// never read by Magento.

// app/etc/registration_globlist.php of Magento 2.4 (used when the project has none)
const DEFAULT_REGISTRATION_GLOBS = [
  'app/code/*/*/registration.php', 'app/design/*/*/*/registration.php', 'app/i18n/*/*/registration.php',
  'lib/internal/*/*/registration.php', 'lib/internal/*/*/*/registration.php', 'setup/src/*/*/registration.php',
];
export const MODULE_XML_IGNORE = ['**/dev/tests/**', '**/Test/**', '**/node_modules/**'];
/**
 * etc/module.xml of every registered module ({ moduleXmls, installed }): registration.php files composer autoloads
 * (vendor/composer/autoload_files.php) and those app/etc/registration_globlist.php names — what
 * Magento's ComponentRegistrar sees. Without a composer install (a partial checkout, a fixture) every
 * etc/module.xml of the tree counts.
 */
export async function discoverModules(root) {
  const dirs = new Set();
  let composerList = false;
  try {
    const src = readFileSync(path.join(root, 'vendor', 'composer', 'autoload_files.php'), 'utf-8');
    composerList = true;
    for (const m of src.matchAll(/\$(vendorDir|baseDir)\s*\.\s*'([^']*\/registration\.php)'/g)) {
      const abs = path.join(m[1] === 'vendorDir' ? path.join(root, 'vendor') : root, m[2]);
      dirs.add(path.relative(root, path.dirname(abs)));
    }
  } catch { /* no composer install */ }
  let patterns = DEFAULT_REGISTRATION_GLOBS;
  try {
    const list = readFileSync(path.join(root, 'app', 'etc', 'registration_globlist.php'), 'utf-8');
    const found = [...list.matchAll(/'([^']+\/registration\.php)'/g)].map(m => m[1]);
    if (found.length) patterns = found;
  } catch { /* default list */ }
  for (const p of patterns) {
    try { for (const f of await glob(p, { cwd: root, nodir: true })) dirs.add(path.dirname(f)); } catch { /* none */ }
  }
  // A registration.php may register modules below it (Mirakl's includes */registration.php), so the
  // modules one and two levels below a registration count too — tests and dev sandboxes excepted
  const skip = new Set(['Test', 'Tests', 'test', 'tests', 'dev', 'node_modules', 'etc', 'view', 'i18n']);
  const candidates = new Set();
  for (const d of dirs) {
    candidates.add(`${d}/etc/module.xml`);
    const walk = (rel, depth) => {
      if (depth > 2) return;
      let entries;
      try { entries = readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (!e.isDirectory() || skip.has(e.name)) continue;
        candidates.add(`${rel}/${e.name}/etc/module.xml`);
        walk(`${rel}/${e.name}`, depth + 1);
      }
    };
    walk(d, 1);
  }
  let rels = [...candidates].filter(r => existsSync(path.join(root, r)));
  if (!composerList) {
    rels = [...new Set([...rels, ...await glob('**/etc/module.xml', { cwd: root, nodir: true, ignore: MODULE_XML_IGNORE })])];
  }
  return { moduleXmls: rels.sort(), installed: composerList };
}

function listFilesRecursive(absDir, relDir, out) {
  let entries;
  try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const rel = `${relDir}/${e.name}`;
    if (e.isDirectory()) listFilesRecursive(path.join(absDir, e.name), rel, out);
    else if (e.isFile()) out.push(rel);
  }
}

/** Every file under the etc/ of each module of the index and under app/etc (relative paths, sorted). */
export function listModuleEtcFiles(root, idx) {
  const out = [];
  for (const m of idx.modules.values()) listFilesRecursive(path.join(root, m.dir, 'etc'), `${m.dir}/etc`, out);
  listFilesRecursive(path.join(root, 'app', 'etc'), 'app/etc', out);
  return [...new Set(out)].sort();
}

/** `**\/etc/<rest>` glob pattern → RegExp over a relative path (**, *, {a,b}). */
export function etcPatternRegExp(pattern) {
  const rest = pattern.replace(/^\*\*\/etc\//, '');
  let re = '';
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (rest.startsWith('**/', i)) { re += '(?:[^/]+/)*'; i += 2; } else if (c === '*') re += '[^/]*';
    else if (c === '{') { const end = rest.indexOf('}', i); re += `(?:${rest.slice(i + 1, end).split(',').map(s => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`; i = end; } else re += c.replace(/[.+^$()|[\]\\?]/g, '\\$&');
  }
  return new RegExp(`(?:^|/)etc/${re}$`);
}

// ─── Which files Magento reads ──────────────────────────────────

/**
 * `<module dir>/etc/[<scope>/]<fileName>` of the enabled modules in load order — the files
 * Module\Dir\Reader::getConfigurationFiles() returns. Without app/etc/config.php every module
 * counts (order approximated from <sequence>). `exists(relPath)` says whether the file is there.
 */
export function moduleConfigFiles(idx, exists, fileName, scope = 'global') {
  const withConfig = idx.orderSource === 'config.php';
  return [...idx.modules.values()]
    .filter(m => (withConfig ? m.enabled === true : true))
    .sort((a, b) => idx.orderOf(a.name) - idx.orderOf(b.name))
    .map(m => ({ module: m.name, relPath: `${m.dir}/etc/${scope === 'global' ? '' : scope + '/'}${fileName}` }))
    .filter(f => exists(f.relPath));
}

/** Modules whose file is not read: disabled in config.php, or not listed there (not installed). */
export function unreadModuleConfigFiles(idx, exists, fileName, scope = 'global') {
  if (idx.orderSource !== 'config.php') return [];
  return [...idx.modules.values()]
    .filter(m => m.enabled !== true)
    .map(m => ({ module: m.name, enabled: m.enabled, relPath: `${m.dir}/etc/${scope === 'global' ? '' : scope + '/'}${fileName}` }))
    .filter(f => exists(f.relPath));
}

const elements = (node, name) => node.children.filter(c => c.name === name);
function* descendants(node, name) {
  for (const c of node.children) {
    if (c.name === name) yield c;
    yield* descendants(c, name);
  }
}

// ─── webapi.xml ─────────────────────────────────────────────────

/** Routes of one webapi.xml: { url, method, serviceClass, serviceMethod, resources, secure, line, relPath }. */
export function parseWebapiXml(content, relPath) {
  const doc = parseXml(content);
  const out = [];
  for (const route of descendants(doc, 'route')) {
    const service = descendants(route, 'service').next().value;
    out.push({
      url: route.attrs.url ?? '', method: route.attrs.method ?? '',
      serviceClass: service?.attrs.class !== undefined ? normalizeClassName(service.attrs.class) : undefined,
      serviceMethod: service?.attrs.method,
      resources: [...descendants(route, 'resource')].map(r => r.attrs.ref).filter(r => r !== undefined),
      secure: route.attrs.secure,
      line: route.line, relPath,
    });
  }
  return out;
}

/**
 * Merged routes: Map `${url} ${method}` → { url, method, serviceClass, serviceMethod, resources,
 * declarations: [{ relPath, line, serviceClass, serviceMethod, module }] } (declarations in load order).
 */
export function buildWebapiModel(files) {
  const routes = new Map();
  for (const { relPath, content, module } of files) {
    for (const r of parseWebapiXml(content, relPath)) {
      // Config\Dom merges on the raw attributes; the converter keys the result by the trimmed url
      const key = `${r.url.trim()} ${r.method}`;
      let e = routes.get(key);
      if (!e) {
        e = { url: r.url.trim(), method: r.method, serviceClass: undefined, serviceMethod: undefined, resources: [], declarations: [] };
        routes.set(key, e);
      }
      if (r.serviceClass !== undefined) e.serviceClass = r.serviceClass;
      if (r.serviceMethod !== undefined) e.serviceMethod = r.serviceMethod;
      for (const ref of r.resources) if (!e.resources.includes(ref)) e.resources.push(ref);
      e.declarations.push({ relPath, line: r.line, serviceClass: r.serviceClass, serviceMethod: r.serviceMethod, module });
    }
  }
  return routes;
}

// ─── schema.graphqls ────────────────────────────────────────────

/** GraphQL SDL tokens: names, punctuators, strings (incl. block strings), numbers; comments dropped. */
function tokenizeGraphql(src) {
  const tokens = [];
  let i = 0, line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === ',' || c === '﻿') { i++; continue; }
    if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
    if (src.startsWith('"""', i)) {
      const start = line;
      let j = i + 3, v = '';
      while (j < n && !src.startsWith('"""', j)) {
        if (src.startsWith('\\"""', j)) { v += '"""'; j += 4; continue; }
        if (src[j] === '\n') line++;
        v += src[j++];
      }
      tokens.push({ t: 'str', v, line: start });
      i = Math.min(n, j + 3);
      continue;
    }
    if (c === '"') {
      let j = i + 1, v = '';
      while (j < n && src[j] !== '"' && src[j] !== '\n') {
        if (src[j] === '\\' && j + 1 < n) {
          const e = src[j + 1];
          // GraphQL escapes; an unknown one (\M in "Magento\Model") is kept as written
          v += e === '\\' ? '\\' : e === '"' ? '"' : e === '/' ? '/' : e === 'n' ? '\n' : e === 't' ? '\t' : '\\' + e;
          j += 2;
          continue;
        }
        v += src[j++];
      }
      tokens.push({ t: 'str', v, line });
      i = j + 1;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i + 1;
      while (j < n && /[_0-9A-Za-z]/.test(src[j])) j++;
      tokens.push({ t: 'name', v: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (/[-0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9.eE+-]/.test(src[j])) j++;
      tokens.push({ t: 'num', v: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (src.startsWith('...', i)) { tokens.push({ t: 'p', v: '...', line }); i += 3; continue; }
    tokens.push({ t: 'p', v: c, line });
    i++;
  }
  return tokens;
}

const GRAPHQL_KINDS = { type: 'graphql_type', interface: 'graphql_interface', input: 'graphql_input', enum: 'graphql_enum', union: 'graphql_union', scalar: 'graphql_scalar' };

/**
 * Type definitions of one .graphqls file: [{ kind, name, extend, implements, typeResolver,
 * fields: [{ name, resolver, cache, line }], line }] and parse errors ({ line, message }).
 */
export function parseGraphqlSdl(content) {
  const tk = tokenizeGraphql(String(content ?? ''));
  const defs = [];
  const errors = [];
  let p = 0;
  const peek = (o = 0) => tk[p + o];
  const is = (v, o = 0) => peek(o) && peek(o).v === v && peek(o).t !== 'str';
  const skipBalanced = (open, close) => {          // from an opening punctuator to its match
    let depth = 0;
    do {
      const t = tk[p++];
      if (!t) return;
      if (t.t === 'p' && t.v === open) depth++;
      else if (t.t === 'p' && t.v === close) depth--;
    } while (depth > 0);
  };
  /** Directives at the current position → [{ name, args: { key: string } }] */
  const readDirectives = () => {
    const out = [];
    while (is('@')) {
      p++;
      const name = tk[p++]?.v;
      const args = {};
      if (is('(')) {
        const start = p;
        skipBalanced('(', ')');
        for (let k = start + 1; k < p - 1; k++) {
          if (tk[k].t === 'name' && tk[k + 1]?.v === ':' && tk[k + 2]) args[tk[k].v] = tk[k + 2].v;
        }
      }
      out.push({ name, args });
    }
    return out;
  };
  const skipType = () => {                          // Type := Name | [ Type ], then an optional !
    if (is('[')) { p++; skipType(); if (is(']')) p++; } else if (peek()?.t === 'name') p++;
    if (is('!')) p++;
  };
  while (p < tk.length) {
    if (peek().t === 'str') { p++; continue; }       // description
    const kw = peek().v;
    let extend = false;
    if (kw === 'extend') { extend = true; p++; }
    const kind = peek()?.v;
    if (kind === 'schema') { p++; readDirectives(); if (is('{')) skipBalanced('{', '}'); continue; }
    if (kind === 'directive') {
      p++;
      while (p < tk.length && !(peek().t === 'name' && ['type', 'interface', 'input', 'enum', 'union', 'scalar', 'extend', 'schema', 'directive'].includes(peek().v) && tk[p - 1]?.v !== 'on' && tk[p - 1]?.v !== '|')) p++;
      continue;
    }
    if (!GRAPHQL_KINDS[kind]) {
      errors.push({ line: peek().line, message: `Unexpected ${JSON.stringify(peek().v)}` });
      p++;
      continue;
    }
    const line = peek().line;
    p++;
    const name = peek()?.t === 'name' ? tk[p++].v : null;
    if (!name) { errors.push({ line, message: `${kind} without a name` }); continue; }
    const def = { kind: GRAPHQL_KINDS[kind], name, extend, implements: [], typeResolver: null, fields: [], line };
    // `implements` and directives in any order: Magento turns "implements A & B" into an annotation
    // wherever it stands (GraphQlReader::convertInterfacesToAnnotations), before or after @typeResolver
    while (is('implements') || is('@')) {
      if (is('@')) {
        // InterfaceType / UnionType readers take the first @typeResolver with a class
        for (const d of readDirectives()) if (d.name === 'typeResolver' && d.args.class && !def.typeResolver) def.typeResolver = normalizeClassName(d.args.class);
        continue;
      }
      p++;
      while (peek() && !is('{') && !is('@') && !(peek().t === 'name' && (GRAPHQL_KINDS[peek().v] || peek().v === 'extend' || peek().v === 'implements'))) {
        if (peek().t === 'name') def.implements.push(peek().v);
        p++;
      }
    }
    if (kind === 'union') {
      if (is('=')) {
        p++;
        while (peek() && (is('|') || (peek().t === 'name' && !GRAPHQL_KINDS[peek().v] && peek().v !== 'extend'))) p++;
      }
      defs.push(def);
      continue;
    }
    if (is('{')) {
      p++;
      while (p < tk.length && !is('}')) {
        if (peek().t === 'str') { p++; continue; }
        if (peek().t !== 'name') { errors.push({ line: peek().line, message: `Unexpected ${JSON.stringify(peek().v)} in ${name}` }); p++; continue; }
        const field = { name: tk[p].v, resolver: null, cache: null, line: tk[p].line };
        p++;
        if (is('(')) skipBalanced('(', ')');
        if (is(':')) { p++; skipType(); }
        if (is('=')) {                               // input default value
          p++;
          if (is('{')) skipBalanced('{', '}'); else if (is('[')) skipBalanced('[', ']'); else p++;
        }
        for (const d of readDirectives()) {
          // FieldMetaReader takes the first @resolver with a class
          if (d.name === 'resolver' && d.args.class && !field.resolver) field.resolver = normalizeClassName(d.args.class);
          // CacheAnnotationReader array_merges the arguments of every @cache
          if (d.name === 'cache') {
            field.cacheArgs = { ...(field.cacheArgs || {}), ...d.args };
            const id = field.cacheArgs.cacheIdentity ? normalizeClassName(field.cacheArgs.cacheIdentity) : null;
            field.cache = [id, field.cacheArgs.cacheable === 'false' ? 'not cacheable' : null].filter(Boolean).join(', ') || null;
          }
        }
        def.fields.push(field);
      }
      p++;
    }
    defs.push(def);
  }
  return { defs, errors };
}

/**
 * GraphQlReader::parseTypesWithUnionHandling(): how Magento cuts a .graphqls file into type chunks
 * before the GraphQL parser sees them — a regular expression over the raw text, so a type inside a
 * `#` comment is read, a `{` / `}` inside a type body cuts it short, and a union (no braces) swallows
 * the text up to the next body, which is split off again at the last blank line. Returns
 * [{ name, text, offset }] in file order; a later chunk of the same name in one file replaces the
 * earlier (array_combine).
 */
export function magentoGraphqlChunks(content) {
  const src = String(content ?? '');
  const re = /(type|interface|union|enum|input|scalar)[\s\t\n\r]+([_A-Za-z][_0-9A-Za-z]+)[\s\t\n\r]+([^{}]*)(\{[^}]*\})/gi;
  const parse = (text, base) => {
    const out = new Map();
    let m;
    const r = new RegExp(re.source, 'gi');
    while ((m = r.exec(text)) !== null) {
      out.delete(m[2]);                               // array_combine: the last one wins, in its position
      out.set(m[2], { name: m[2], text: m[0], offset: base + m.index });
    }
    return out;
  };
  const chunks = parse(src, 0);
  for (const c of [...chunks.values()]) {
    if (!c.text.includes('union ') || !c.text.includes('\n\n')) continue;
    const parts = c.text.split('\n\n');
    const tail = parts[parts.length - 1];
    const tailOffset = c.offset + c.text.lastIndexOf(tail);
    const extra = [...parse(tail, tailOffset).values()][0];
    c.text = c.text.replace(tail, '');
    if (extra) { chunks.delete(extra.name); chunks.set(extra.name, extra); }
  }
  return [...chunks.values()];
}

/**
 * Merged schema: Map type name → { kind, implements, typeResolver, fields: Map name → { resolver,
 * cache, relPath, line, from } , declarations: [{ relPath, line, module }] }. `from` is the interface
 * a field was copied from (Magento copies interface fields into implementing types).
 */
export function buildGraphqlModel(files) {
  const types = new Map();
  const errors = [];
  for (const { relPath, content, module } of files) {
    const src = String(content ?? '');
    const lineOf = off => src.slice(0, off).split('\n').length;
    const defs = [];
    for (const chunk of magentoGraphqlChunks(src)) {
      const firstLine = lineOf(chunk.offset);
      const parsed = parseGraphqlSdl(chunk.text);
      for (const e of parsed.errors) errors.push({ relPath, line: e.line + firstLine - 1, message: e.message });
      // Every definition in the chunk reaches the GraphQL parser — also the ones a body-less
      // definition (scalar, union, type without a body) swallowed after it
      for (const d of parsed.defs) {
        d.line += firstLine - 1;
        for (const f of d.fields) f.line += firstLine - 1;
        defs.push(d);
      }
    }
    for (const d of defs) {
      let t = types.get(d.name);
      if (!t) {
        t = { name: d.name, kind: d.kind, implements: [], typeResolver: null, fields: new Map(), declarations: [] };
        types.set(d.name, t);
      }
      t.kind = d.kind;
      for (const i of d.implements) if (!t.implements.includes(i)) t.implements.push(i);
      if (d.typeResolver) t.typeResolver = d.typeResolver;
      if (d.kind === 'graphql_enum') {                // enum values are items, not fields
        t.values = [...new Set([...(t.values || []), ...d.fields.map(f => f.name)])];
        t.declarations.push({ relPath, line: d.line, module, extend: d.extend });
        continue;
      }
      for (const f of d.fields) {
        const prev = t.fields.get(f.name);
        // array_replace_recursive: a later field without @resolver keeps the earlier resolver
        t.fields.set(f.name, {
          resolver: f.resolver || prev?.resolver || null,
          cache: f.cache || prev?.cache || null,
          relPath: f.resolver || !prev ? relPath : prev.relPath,
          line: f.resolver || !prev ? f.line : prev.line,
          from: null,
        });
      }
      t.declarations.push({ relPath, line: d.line, module, extend: d.extend });
    }
  }
  // GraphQlReader::copyInterfaceFieldsToConcreteTypes(): every type is a possible source (its check
  // `$interface['type'] ?? '' == …` is always true), sources are taken in definition order with
  // their own fields (a snapshot, not what they inherit), and an object type implementing one keeps
  // what it already has — so the earlier source wins a shared field.
  const snapshot = new Map([...types].map(([n, t]) => [n, new Map(t.fields)]));
  for (const [sourceName, sourceFields] of snapshot) {
    for (const t of types.values()) {
      if (t.kind !== 'graphql_type' || !t.implements.includes(sourceName)) continue;   // only ObjectType records implements
      const merged = new Map();
      for (const [k, f] of sourceFields) merged.set(k, { ...f, from: f.from || sourceName });
      for (const [k, f] of t.fields) merged.set(k, f);
      t.fields = merged;
    }
  }
  return { types, errors };
}

// ─── crontab.xml + crontab system config ────────────────────────

/** Jobs of one crontab.xml: [{ group, name, instance, method, schedule, configPath, line, relPath }]. */
export function parseCrontabXml(content, relPath) {
  const doc = parseXml(content);
  const out = [];
  for (const group of descendants(doc, 'group')) {
    for (const job of elements(group, 'job')) {
      const firstText = tag => elements(job, tag).map(n => n.text).find(t => t !== '') ?? undefined;
      out.push({
        group: group.attrs.id, name: job.attrs.name,
        instance: job.attrs.instance !== undefined ? normalizeClassName(job.attrs.instance) : undefined,
        method: job.attrs.method,
        schedule: firstText('schedule'), configPath: firstText('config_path'),
        line: job.line, relPath,
      });
    }
  }
  return out;
}

/** `default/crontab/<group>/jobs/<job>` of one config.xml: schedule / config_path / run model. */
export function parseConfigXmlCrontab(content, relPath) {
  const doc = parseXml(content);
  const out = [];
  const config = elements(doc, 'config')[0];
  const crontab = config && elements(config, 'default').flatMap(d => elements(d, 'crontab'))[0];
  if (!crontab) return out;
  for (const group of crontab.children) {
    for (const jobs of elements(group, 'jobs')) {
      for (const job of jobs.children) {
        const schedule = elements(job, 'schedule')[0];
        const run = elements(job, 'run')[0];
        const text = (node, tag) => (node ? elements(node, tag)[0]?.text : undefined);
        const direct = tag => { const n = elements(job, tag)[0]; return n && !n.children.length ? n.text : undefined; };
        // Converter\Db copies the job's keys as they are; a <schedule> with children is read as
        // cron_expr / config_path, a text <schedule> is the schedule itself
        const scheduleIsText = schedule && !schedule.children.length;
        out.push({
          group: group.name, name: job.name,
          schedule: scheduleIsText ? schedule.text : text(schedule, 'cron_expr'),
          configPath: scheduleIsText ? direct('config_path') : (text(schedule, 'config_path') ?? direct('config_path')),
          instance: direct('instance') !== undefined ? normalizeClassName(direct('instance')) : undefined,
          method: direct('method'),
          runModel: text(run, 'model'), line: job.line, relPath,
        });
      }
    }
  }
  return out;
}

/**
 * Merged jobs: Map `${group}/${name}` → { group, name, instance, method, schedule, configPath,
 * runModel, declarations: [{ relPath, line, module, source }] }. `configFiles` are config.xml files
 * (the system config's defaults); values saved in the admin (core_config_data) are not in files.
 */
export function buildCronModel(crontabFiles, configFiles = []) {
  const jobs = new Map();
  const get = (group, name) => {
    const key = `${group}/${name}`;
    if (!jobs.has(key)) jobs.set(key, { group, name, instance: undefined, method: undefined, schedule: undefined, configPath: undefined, runModel: undefined, declarations: [] });
    return jobs.get(key);
  };
  for (const { relPath, content, module } of crontabFiles) {
    for (const j of parseCrontabXml(content, relPath)) {
      if (j.group === undefined || !j.name) continue;
      const e = get(j.group, j.name);
      for (const k of ['instance', 'method', 'schedule', 'configPath']) if (j[k] !== undefined) e[k] = j[k];
      e.declarations.push({ relPath, line: j.line, module, source: 'crontab.xml' });
    }
  }
  for (const { relPath, content, module } of configFiles) {
    for (const j of parseConfigXmlCrontab(content, relPath)) {
      const e = get(j.group, j.name);
      for (const k of ['schedule', 'configPath', 'runModel', 'instance', 'method']) if (j[k] !== undefined) e[k] = j[k];
      // Converter\Db::_processRunModel(): "Class::method" replaces instance and method; an empty or
      // incomplete run model changes nothing
      const [cls, fn] = String(j.runModel ?? '').split('::');
      if (cls && fn) { e.instance = normalizeClassName(cls); e.method = fn; }
      e.declarations.push({ relPath, line: j.line, module, source: 'config.xml' });
    }
  }
  return jobs;
}

// ─── db_schema.xml ──────────────────────────────────────────────

const isDisabled = node => node.attrs.disabled === 'true' || node.attrs.disabled === '1';

// Magento\Framework\DB\ExpressionConverter::$_translateMap
const TRANSLATE_MAP = {
  address: 'addr', admin: 'adm', attribute: 'attr', enterprise: 'ent', catalog: 'cat', category: 'ctgr',
  customer: 'cstr', notification: 'ntfc', product: 'prd', session: 'sess', user: 'usr', entity: 'entt',
  datetime: 'dtime', decimal: 'dec', varchar: 'vchr', index: 'idx', compare: 'cmp', bundle: 'bndl',
  option: 'opt', gallery: 'glr', media: 'mda', value: 'val', link: 'lnk', title: 'ttl', super: 'spr',
  label: 'lbl', website: 'ws', aggregat: 'aggr', minimal: 'min', inventory: 'inv', status: 'sts',
  agreement: 'agrt', layout: 'lyt', resource: 'res', directory: 'dir', downloadable: 'dl', element: 'elm',
  fieldset: 'fset', checkout: 'chkt', newsletter: 'nlttr', shipping: 'shpp', calculation: 'calc',
  search: 'srch', query: 'qr',
};
const TRANSLATE_KEYS = Object.keys(TRANSLATE_MAP).sort((a, b) => b.length - a.length);

/** PHP strtr($name, $map): longest key first at each position, replaced text is not scanned again. */
function phpStrtr(name) {
  let out = '';
  for (let i = 0; i < name.length;) {
    const key = TRANSLATE_KEYS.find(k => name.startsWith(k, i));
    if (key) { out += TRANSLATE_MAP[key]; i += key.length; } else { out += name[i++]; }
  }
  return out;
}

/** ExpressionConverter::shortenEntityName() — identifiers longer than 64 characters (MySQL's limit). */
export function shortenEntityName(entityName, prefix) {
  if (entityName.length <= 64) return entityName;
  const short = phpStrtr(entityName);
  if (short.length <= 64) return short;
  const hash = createHash('md5').update(entityName).digest('hex');
  if ((prefix + hash).length <= 64) return prefix + hash;
  const diff = hash.length + prefix.length - 64;          // trimHash()
  const superfluous = Math.floor(diff / 2);
  return hash.slice(superfluous, hash.length - (superfluous + diff % 2));
}

/**
 * The name Magento gives a declared index / constraint (SchemaBuilder + ElementNameResolver, no table
 * prefix): PRIMARY; Pdo\Mysql::getIndexName() for unique / fulltext / other indexes;
 * getForeignKeyName() for foreign keys.
 */
export function dbElementName(declaredTable, kind, attrs, columns) {
  const table = declaredTable.replace(/^(\S+)_replica$/i, '$1');   // TableNameResolver::getNameOfOriginTable
  if (kind === 'constraint' && attrs['xsi:type'] === 'primary') return 'PRIMARY';
  if (kind === 'constraint' && attrs['xsi:type'] === 'foreign') {
    return shortenEntityName(`${table}_${attrs.column}_${attrs.referenceTable}_${attrs.referenceColumn}`, 'fk_').toUpperCase();
  }
  const type = kind === 'constraint' ? attrs['xsi:type'] : attrs.indexType;
  const prefix = type === 'unique' ? 'unq_' : type === 'fulltext' ? 'fti_' : 'idx_';
  return shortenEntityName(`${table}_${(columns || []).join('_')}`, prefix).toUpperCase();
}

/**
 * Merged declarative schema: Map table → { name, resource, disabled, columns / indexes / constraints:
 * Map id → { attrs, disabled, relPath, line, module, declarations } , declarations }.
 * Elements with disabled="true" stay in the model, marked, so a tool can list them as removed.
 */
export function buildDbSchemaModel(files) {
  const tables = new Map();
  let tableName = '';
  const mergeInto = (map, id, node, relPath, module) => {
    let prev = map.get(id);
    // Config\Dom::_mergeNode replaces the whole node when both declare a different xsi:type
    // (typeAttributeName of the db_schema reader): earlier attributes, columns and `disabled` go
    const replaced = prev && node.attrs['xsi:type'] !== undefined && prev.attrs['xsi:type'] !== undefined && node.attrs['xsi:type'] !== prev.attrs['xsi:type'];
    if (replaced) prev = { declarations: prev.declarations };
    const attrs = { ...(prev?.attrs || {}), ...node.attrs };
    const columns = node.name === 'column' ? null : [...new Set([...(prev?.columns || []), ...elements(node, 'column').map(c => c.attrs.name)])];
    map.set(id, {
      attrs, disabled: node.attrs.disabled !== undefined ? isDisabled(node) : !!prev?.disabled,
      columns, relPath, line: node.line, module,
      dbName: node.name === 'column' ? id : dbElementName(tableName, node.name, attrs, columns),
      declarations: [...(prev?.declarations || []), { relPath, line: node.line, module }],
    });
  };
  for (const { relPath, content, module } of files) {
    const doc = parseXml(content);
    const schema = elements(doc, 'schema')[0];
    if (!schema) continue;
    for (const t of elements(schema, 'table')) {
      const name = t.attrs.name;
      if (!name) continue;
      let e = tables.get(name);
      if (!e) {
        e = { name, resource: 'default', disabled: false, columns: new Map(), indexes: new Map(), constraints: new Map(), declarations: [] };
        tables.set(name, e);
      }
      tableName = name;
      if (t.attrs.resource) e.resource = t.attrs.resource;
      if (t.attrs.disabled !== undefined) e.disabled = isDisabled(t);
      e.declarations.push({ relPath, line: t.line, module });
      for (const c of elements(t, 'column')) if (c.attrs.name) mergeInto(e.columns, c.attrs.name, c, relPath, module);
      for (const c of elements(t, 'index')) if (c.attrs.referenceId) mergeInto(e.indexes, c.attrs.referenceId, c, relPath, module);
      for (const c of elements(t, 'constraint')) if (c.attrs.referenceId) mergeInto(e.constraints, c.attrs.referenceId, c, relPath, module);
    }
  }
  return tables;
}
