/**
 * Structural model of Magento DI and event configuration.
 *
 * Parses di.xml / events.xml with a small XML parser (comments, CDATA, self-closing elements and
 * entities handled) instead of regexes over raw text, and resolves what Magento resolves at runtime:
 * virtual types (transitively), preferences, plugins inherited from parent classes and interfaces,
 * and the DI area of each file. No I/O besides the file readers passed in, so it can be unit-tested.
 */

import { readFileSync } from 'fs';

// ─── XML ────────────────────────────────────────────────────────

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

/**
 * Parse an XML document into { name, attrs, children, text, seq, line } nodes. `seq` keeps the
 * child elements, text and CDATA sections in document order ({ node } | { text } | { cdata }).
 * Tolerant: unknown or unbalanced closing tags are ignored rather than thrown, so a broken file
 * yields what it can (checkXmlWellFormed says whether Magento loads it).
 */
export function parseXml(content) {
  const root = { name: '#document', attrs: {}, children: [], text: '', seq: [] };
  if (!content) return root;
  const src = content;
  const stack = [root];
  // Comments, processing instructions and DOCTYPE are tokens of the same scan as CDATA and tags, so
  // whichever starts first wins (a "<!--" inside CDATA is text, not the start of a comment).
  const tagRe = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE(?:[^[>]|\[[\s\S]*?\])*>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)|</g;
  let m;
  let line = 1, counted = 0;
  const lineAt = off => { for (; counted < off; counted++) if (src.charCodeAt(counted) === 10) line++; return line; };
  while ((m = tagRe.exec(src)) !== null) {
    const top = stack[stack.length - 1];
    if (m[3] === undefined && m[1] === undefined && m[6] === undefined) {
      continue;                         // comment, PI, DOCTYPE, or a stray "<"
    } else if (m[1] !== undefined) {    // CDATA
      top.text += m[1];
      top.seq.push({ cdata: m[1] });
    } else if (m[6] !== undefined) {    // text
      const text = decodeEntities(m[6]);
      top.text += text;
      top.seq.push({ text });
    } else if (m[2] === '/') {          // closing tag
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === m[3]) { stack.length = i; break; }
      }
    } else {                            // opening or self-closing tag
      const attrs = {};
      const attrRe = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = attrRe.exec(m[4])) !== null) attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? '');
      const node = { name: m[3], attrs, children: [], text: '', seq: [], line: lineAt(m.index) };
      top.children.push(node);
      top.seq.push({ node });
      if (m[5] !== '/') stack.push(node);
    }
  }
  return root;
}

function* walk(node) {
  for (const child of node.children) {
    yield child;
    yield* walk(child);
  }
}

/** xs:boolean as used by Magento's XSDs: true / 1 and false / 0; null when absent or invalid. */
export function xmlBoolean(value) {
  if (value === undefined || value === null) return null;
  const v = String(value).trim().toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return null;
}

// ─── Names and areas ────────────────────────────────────────────

/** `\Foo\\Bar` → `Foo\Bar` */
export function normalizeClassName(name) {
  if (!name) return '';
  return String(name).trim().replace(/\\\\/g, '\\').replace(/^\\/, '');
}

/**
 * DI area of a config file: `etc/<area>/di.xml` → `<area>`, `etc/di.xml` → `global`.
 * Works for events.xml, routes.xml, … as well.
 */
export function areaFromPath(relPath) {
  const m = /(?:^|\/)etc\/([^/]+)\/[^/]+\.xml$/.exec(relPath || '');
  return m ? m[1] : 'global';
}

// ─── DI model ───────────────────────────────────────────────────

function collectObjectRefs(node, path, out) {
  for (const child of node.children) {
    if (child.name !== 'argument' && child.name !== 'item') continue;
    const childPath = path ? `${path}.${child.attrs.name ?? ''}` : (child.attrs.name ?? '');
    const xsiType = child.attrs['xsi:type'];
    if (xsiType === 'object') {
      const value = normalizeClassName(child.text);
      if (value) out.push({ path: childPath, value });
    }
    collectObjectRefs(child, childPath, out);
  }
}

function argumentsOf(node) {
  // The XSD allows several <arguments> blocks per type (xs:choice maxOccurs="unbounded"); Magento
  // accumulates them.
  const argsNodes = node.children.filter(c => c.name === 'arguments');
  if (!argsNodes.length) return { args: [], objectRefs: [] };
  const argsNode = { name: 'arguments', attrs: {}, text: '', children: argsNodes.flatMap(n => n.children) };
  const args = argsNode.children.filter(c => c.name === 'argument').map(a => ({
    name: a.attrs.name ?? '',
    xsiType: a.attrs['xsi:type'] ?? '',
    value: a.text.trim().slice(0, 200),
    items: a.children.filter(i => i.name === 'item').map(i => ({
      name: i.attrs.name ?? '', xsiType: i.attrs['xsi:type'] ?? '', value: i.text.trim().slice(0, 200),
    })),
  }));
  const objectRefs = [];
  collectObjectRefs(argsNode, '', objectRefs);
  return { args, objectRefs };
}

/**
 * Parse one di.xml. Returns flat lists; `file` and `area` are attached to every entry.
 */
export function parseDiXml(content, relPath) {
  const area = areaFromPath(relPath);
  const doc = parseXml(content);
  const out = { preferences: [], virtualTypes: [], types: [] };
  const configNode = doc.children.find(c => c.name === 'config') || doc;
  for (const node of configNode.children) {
    if (node.name === 'preference') {
      out.preferences.push({
        for: normalizeClassName(node.attrs.for), type: normalizeClassName(node.attrs.type), file: relPath, area,
      });
    } else if (node.name === 'virtualType' || node.name === 'type') {
      const { args, objectRefs } = argumentsOf(node);
      const plugins = node.children.filter(c => c.name === 'plugin').map(p => ({
        name: p.attrs.name ?? '',
        type: normalizeClassName(p.attrs.type),
        disabled: xmlBoolean(p.attrs.disabled) === true,
        // null when the attribute is absent: a later declaration of the same name keeps the earlier value
        disabledAttr: xmlBoolean(p.attrs.disabled),
        sortOrder: p.attrs.sortOrder ?? null,
      }));
      const entry = { name: normalizeClassName(node.attrs.name), args, objectRefs, plugins, file: relPath, area };
      if (node.name === 'virtualType') {
        out.virtualTypes.push({ ...entry, type: normalizeClassName(node.attrs.type) });
      } else {
        out.types.push(entry);
      }
    }
  }
  return out;
}

/**
 * Build a DI model from `[{ relPath, content }]`.
 */
export function buildDiModel(diFiles) {
  const model = { preferences: [], virtualTypes: [], types: [], virtualByName: new Map() };
  for (const { relPath, content } of diFiles) {
    let parsed;
    try { parsed = parseDiXml(content, relPath); } catch { continue; }
    model.preferences.push(...parsed.preferences);
    model.virtualTypes.push(...parsed.virtualTypes);
    model.types.push(...parsed.types);
  }
  for (const vt of model.virtualTypes) {
    if (!model.virtualByName.has(vt.name)) model.virtualByName.set(vt.name, []);
    model.virtualByName.get(vt.name).push(vt);
  }
  return model;
}

/**
 * Sort declarations into module load order (stable; file order among equals), so "the last
 * declaration wins" matches Magento's merge. Call once after buildModuleIndex.
 */
export function applyModuleOrder(model, idx) {
  // One lookup per file, not per comparison (sorting ~10k declarations compared each file's module
  // O(n log n) times — 1.6 s of a 2.8 s first call on a 600-module project)
  const keys = new Map();
  const key = d => {
    let k = keys.get(d.file);
    if (k === undefined) { k = idx.orderOfFile(d.file); keys.set(d.file, k); }
    return k;
  };
  const byOrder = (a, b) => key(a) - key(b);
  model.preferences.sort(byOrder);
  model.virtualTypes.sort(byOrder);
  model.types.sort(byOrder);
  for (const list of model.virtualByName.values()) list.sort(byOrder);
  return model;
}

export function isVirtualType(model, name) {
  return model.virtualByName.has(normalizeClassName(name));
}

/**
 * Follow a virtual type to the PHP class it instantiates. Returns { real, chain } where chain
 * starts with `name`. Prefers the global declaration; cycles are cut.
 */
export function resolveVirtualType(model, name) {
  let cur = normalizeClassName(name);
  const chain = [cur];
  const seen = new Set([cur]);
  while (model.virtualByName.has(cur)) {
    const decls = model.virtualByName.get(cur);
    const globals = decls.filter(d => d.area === 'global');
    const decl = globals.length ? globals[globals.length - 1] : decls[decls.length - 1];
    if (!decl.type || seen.has(decl.type)) break;
    cur = decl.type;
    seen.add(cur);
    chain.push(cur);
  }
  return { real: cur, chain };
}

/** Preference declarations for a type, all areas. */
export function preferencesFor(model, name) {
  const n = normalizeClassName(name);
  return model.preferences.filter(p => p.for === n);
}

/**
 * The class that is instantiated for a requested type in the global area: preference (the last
 * global declaration seen; area-specific ones are reported separately) then virtual-type resolution.
 */
export function resolveInstance(model, name, area = 'global') {
  const n = normalizeClassName(name);
  const prefs = preferencesFor(model, n);
  let target = n;
  const steps = [];
  const seen = new Set([n]);
  // Preferences chain (I → J → K), like ObjectManager\Config::getPreference(); the area overrides global.
  for (;;) {
    const cands = preferencesFor(model, target).filter(p => p.area === 'global' || p.area === area);
    if (!cands.length) break;
    const areaOnes = cands.filter(p => p.area === area && area !== 'global');
    const next = (areaOnes.length ? areaOnes : cands)[(areaOnes.length ? areaOnes : cands).length - 1].type;
    if (!next || seen.has(next)) break;
    seen.add(next);
    target = next;
    steps.push(`preference ${target}`);
  }
  const { real, chain } = resolveVirtualType(model, target);
  if (chain.length > 1) steps.push(...chain.slice(1).map(c => `virtualType → ${c}`));
  return { real, steps, preferences: prefs };
}

/** Every virtual type that resolves (transitively) to `className`, with its chain. */
export function virtualTypesResolvingTo(model, className) {
  const target = normalizeClassName(className);
  const out = [];
  for (const vt of model.virtualTypes) {
    const { real, chain } = resolveVirtualType(model, vt.name);
    if (real === target && vt.name !== target) out.push({ ...vt, chain });
  }
  return out;
}

/**
 * Every DI argument (`xsi:type="object"`, in arguments or nested array items) whose value resolves
 * to `className` — directly, through virtual types, preferences, or as `<Class>Factory` / `<Class>\Proxy`.
 */
export function argumentInjectionsOf(model, className) {
  const target = normalizeClassName(className);
  const out = [];
  const owners = [...model.types.map(t => ({ ...t, kind: 'type' })), ...model.virtualTypes.map(v => ({ ...v, kind: 'virtualType' }))];
  for (const owner of owners) {
    for (const ref of owner.objectRefs) {
      let value = ref.value;
      let via = null;
      if (value.endsWith('\\Proxy')) { value = value.slice(0, -'\\Proxy'.length); via = 'Proxy'; }
      else if (/Factory$/.test(value) && !isVirtualType(model, value) && normalizeClassName(value.slice(0, -'Factory'.length)) === target) {
        value = value.slice(0, -'Factory'.length); via = 'Factory';
      }
      const { real, chain } = resolveVirtualType(model, value);
      // The object argument may be an interface: any area's preference (chain) can resolve it.
      const areas = new Set(['global', owner.area, ...preferencesFor(model, value).map(p => p.area)]);
      const hitArea = [...areas].find(a => resolveInstance(model, value, a).real === target);
      if (real === target || value === target || hitArea) {
        out.push({
          owner: owner.name, ownerKind: owner.kind, argument: ref.path, value: ref.value,
          chain: chain.length > 1 ? chain : null, via, file: owner.file, area: owner.area,
          preferenceArea: real === target || value === target ? null : hitArea,
        });
      }
    }
  }
  return out;
}

/** Plugin declarations on exactly `typeName` (all areas). */
export function pluginDeclarationsOn(model, typeName) {
  const n = normalizeClassName(typeName);
  const out = [];
  for (const t of [...model.types, ...model.virtualTypes]) {
    if (t.name !== n) continue;
    for (const p of t.plugins) out.push({ ...p, target: t.name, file: t.file, area: t.area });
  }
  return out;
}

/**
 * Plugins that apply to `className` the way Magento resolves them: declared on the class itself,
 * on its parent classes and interfaces (`ancestors`, nearest first), and — for a virtual type — on
 * its real class. Plugins declared only on a virtual type name never run (the interceptor looks
 * plugins up by the real class); they are returned with `onVirtualType: true`.
 */
export function effectivePluginDeclarations(model, className, ancestorsOf) {
  const requested = normalizeClassName(className);
  const virtual = isVirtualType(model, requested);
  const real = virtual ? resolveVirtualType(model, requested).real : requested;
  const lookup = [real, ...ancestorsOf(real)];
  const out = [];
  for (const [i, type] of lookup.entries()) {
    for (const d of pluginDeclarationsOn(model, type)) {
      out.push({ ...d, inheritedFrom: i === 0 ? null : type });
    }
  }
  if (virtual) {
    // Every virtual type name on the chain (requested → … → real): declared there, never run.
    for (const vt of resolveVirtualType(model, requested).chain.slice(0, -1)) {
      for (const d of pluginDeclarationsOn(model, vt)) out.push({ ...d, onVirtualType: true });
    }
  }
  return { real, virtual, declarations: out };
}

/**
 * How a plugin's declared type is resolved: its before/after/around methods are read from the
 * declared type (a virtual type → its base class), the instance comes from the object manager
 * (preference applied).
 */
export function resolvePluginType(model, pluginType) {
  const declared = normalizeClassName(pluginType);
  const methodsFrom = resolveVirtualType(model, declared).real;
  const inst = resolveInstance(model, declared);
  return { declared, methodsFrom, runs: inst.real };
}

// ─── Events ─────────────────────────────────────────────────────

/** Observer declarations for one event in one events.xml — including ones without `instance`. */
export function parseEventsXml(content, relPath, eventName) {
  const area = areaFromPath(relPath);
  const doc = parseXml(content);
  const out = [];
  for (const node of walk(doc)) {
    // Magento lower-cases event names in config and in dispatch() (mb_strtolower)
    if (node.name !== 'event' || String(node.attrs.name || '').toLowerCase() !== String(eventName).toLowerCase()) continue;
    for (const o of node.children.filter(c => c.name === 'observer')) {
      out.push({
        name: o.attrs.name ?? '',
        instance: o.attrs.instance ? normalizeClassName(o.attrs.instance) : null,
        method: o.attrs.method || 'execute',
        // Event\Config\Converter disables an observer only when disabled == 'true' ("1" does not disable,
        // unlike plugins, whose value goes through BooleanUtils). A present attribute still overrides an
        // earlier declaration of the same observer when the XML is merged.
        disabled: o.attrs.disabled === 'true',
        disabledAttr: o.attrs.disabled === undefined ? null : o.attrs.disabled === 'true',
        shared: o.attrs.shared ?? null,
        file: relPath,
        area,
      });
    }
  }
  return out;
}

// ─── PHP source ─────────────────────────────────────────────────

function skipQuoted(src, i) {
  const q = src[i];
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === '\\') { j += 2; continue; }
    if (src[j] === q) return j + 1;
    j++;
  }
  return src.length;
}

/**
 * Blank out everything in PHP source that is not code — comments (`//`, `#`, `/* … *\/`), string,
 * heredoc and nowdoc contents, attributes `#[…]`, inline HTML outside `<?php … ?>` — with a state
 * machine, so `'*\/*\/edit'`, `'image/*'`, `"a//b"` or `class X {` inside a string cannot break parsing.
 * Length and newlines are kept (offsets and brace depth stay valid). `keepStrings` keeps string contents.
 */
export function scanPhp(source, { keepStrings = false } = {}) {
  const src = String(source || '');
  const n = src.length;
  const parts = [];
  const keep = (from, to) => { if (to > from) parts.push(src.slice(from, to)); };
  const blank = (from, to) => { if (to > from) parts.push(src.slice(from, to).replace(/[^\n]/g, ' ')); };
  const openRe = /<\?(?:php\b|=)?/gi;
  const specialRe = /[?#\/'"`<]/g;                      // characters that can start a non-code token
  let i = 0;
  let inPhp = false;
  while (i < n) {
    if (!inPhp) {
      openRe.lastIndex = i;
      const r = openRe.exec(src);
      if (!r) { blank(i, n); break; }
      blank(i, r.index + r[0].length);
      i = r.index + r[0].length;
      inPhp = true;
      continue;
    }
    specialRe.lastIndex = i;
    const sp = specialRe.exec(src);
    if (!sp) { keep(i, n); break; }
    keep(i, sp.index);
    i = sp.index;
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '?' && c2 === '>') { blank(i, i + 2); i += 2; inPhp = false; continue; }
    if (c === '#' && c2 === '[') {                       // attribute, may nest and contain strings
      let depth = 0;
      let j = i + 1;
      for (; j < n; j++) {
        const ch = src[j];
        if (ch === '[') depth++;
        else if (ch === ']') { depth--; if (depth === 0) { j++; break; } }
        else if (ch === "'" || ch === '"') j = skipQuoted(src, j) - 1;
      }
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '#' || (c === '/' && c2 === '/')) {        // line comment (ends at newline or ?>)
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      const close = src.indexOf('?>', i);
      if (close >= 0 && close < j) j = close;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && c2 === '*') {
      const e = src.indexOf('*/', i + 2);
      const j = e < 0 ? n : e + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const j = skipQuoted(src, i);
      keep(i, i + 1);
      if (keepStrings) keep(i + 1, j - 1); else blank(i + 1, j - 1);
      keep(j - 1, j);
      i = j;
      continue;
    }
    if (c === '<' && src.startsWith('<<<', i)) {          // heredoc / nowdoc
      const h = /^<<<[ \t]*(["']?)([A-Za-z_]\w*)\1[ \t]*\r?\n/.exec(src.slice(i, i + 256));
      if (h) {
        const bodyStart = i + h[0].length;
        const endRe = new RegExp(`^[ \\t]*${h[2]}(?![A-Za-z0-9_])`, 'gm');
        endRe.lastIndex = bodyStart;
        const e = endRe.exec(src);
        const bodyEnd = e ? e.index : n;
        keep(i, bodyStart);
        if (keepStrings) keep(bodyStart, bodyEnd); else blank(bodyStart, bodyEnd);
        const after = e ? e.index + e[0].length : n;
        keep(bodyEnd, after);
        i = after;
        continue;
      }
    }
    keep(i, i + 1);
    i++;
  }
  return parts.join('');
}

function resolvePhpName(name, namespace, uses) {
  const n = String(name || '').replace(/\s+/g, '');
  if (!n) return '';
  if (n.startsWith('\\')) return n.slice(1);
  if (/^namespace\\/i.test(n)) return (namespace ? `${namespace}\\` : '') + n.slice('namespace\\'.length);
  const [first, ...rest] = n.split('\\');
  const hit = uses.get(first.toLowerCase());            // aliases are case-insensitive
  if (hit) return [hit, ...rest].join('\\');
  return namespace ? `${namespace}\\${n}` : n;
}

/** One `use …;` statement: plain, aliased, several, group (`A\{B, C as D}`, `A \{…}`); functions/consts skipped. */
function parseUseStatement(raw, uses) {
  const body = raw.replace(/\s+/g, ' ').trim();
  const add = (fq, alias) => {
    const clean = fq.replace(/\s+/g, '').replace(/^\\/, '').replace(/\\+$/, '');
    if (clean) uses.set((alias || clean.split('\\').pop()).toLowerCase(), clean);
  };
  if (/^(function|const)\b/i.test(body)) return;
  const group = /^([\w\\]+?)\s*\\?\s*\{([^}]*)\}$/.exec(body);
  if (group) {
    const prefix = group[1].replace(/\\+$/, '');
    for (const item of group[2].split(',')) {
      const im = /^\s*(?:(function|const)\s+)?([\w\\]+)(?:\s+as\s+(\w+))?\s*$/i.exec(item);
      if (im && !im[1]) add(`${prefix}\\${im[2]}`, im[3]);
    }
    return;
  }
  for (const item of body.split(',')) {
    const im = /^\s*([\w\\]+)(?:\s+as\s+(\w+))?\s*$/i.exec(item);
    if (im) add(im[1], im[2]);
  }
}

const TYPE_HEADER_WORDS = new Set(['extends', 'implements']);
const phpFileCache = new Map();

/**
 * Structural read of a PHP file: namespace segments (`namespace A;` and `namespace A { … }`, several
 * per file), top-level imports per segment, and every named class / interface / trait / enum with its
 * resolved parents, interfaces, own methods (only at the class body's brace depth — nested and
 * anonymous classes do not leak in) and used traits.
 */
export function parsePhpFile(source) {
  const key = source;
  if (phpFileCache.has(key)) return phpFileCache.get(key);
  const code = scanPhp(source);
  const n = code.length;
  const depthAt = new Int32Array(n + 1);
  let depth = 0;
  for (let k = 0; k < n; k++) {
    depthAt[k] = depth;
    const ch = code[k];
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
  }
  depthAt[n] = depth;

  const segments = [];
  const nsRe = /(?<![\w$\\>:])namespace\s+([A-Za-z_][\w\\]*)\s*([;{])/gi;
  let m;
  while ((m = nsRe.exec(code)) !== null) {
    if (depthAt[m.index] === 0) segments.push({ ns: m[1], start: m.index, baseDepth: m[2] === '{' ? 1 : 0 });
  }
  if (!segments.length || segments[0].start > 0) segments.unshift({ ns: '', start: 0, baseDepth: 0 });
  for (let i = 0; i < segments.length; i++) segments[i].end = i + 1 < segments.length ? segments[i + 1].start : n;

  const types = [];
  for (const seg of segments) {
    const slice = code.slice(seg.start, seg.end);
    const uses = new Map();
    const useRe = /(?<![\w$\\>:])use\s+([^;{]*(?:\{[^}]*\})?[^;{]*);/gi;
    while ((m = useRe.exec(slice)) !== null) {
      if (depthAt[seg.start + m.index] === seg.baseDepth) parseUseStatement(m[1], uses);
    }
    const declRe = /(?<![\w$\\>:])((?:(?:final|abstract|readonly)\s+)*)(class|interface|trait|enum)\s+([A-Za-z_]\w*)([^{;]*)\{/gi;
    while ((m = declRe.exec(slice)) !== null) {
      const shortName = m[3];
      if (TYPE_HEADER_WORDS.has(shortName.toLowerCase())) continue;
      if (/\bnew\s*$/i.test(slice.slice(Math.max(0, m.index - 16), m.index))) continue;   // anonymous class
      const kind = m[2].toLowerCase();
      const tail = kind === 'enum' ? m[4].replace(/^\s*:\s*[\w\\]+/, '') : m[4];
      const ext = (/\bextends\s+([\w\\\s,]+?)(?=\bimplements\b|$)/i.exec(tail) || [])[1] || '';
      const impl = (/\bimplements\s+([\w\\\s,]+)$/i.exec(tail.trim()) || [])[1] || '';
      const list = str => str.split(',').map(x => resolvePhpName(x, seg.ns, uses)).filter(Boolean);
      const open = seg.start + m.index + m[0].length - 1;
      const bodyDepth = depthAt[open] + 1;
      let close = n;
      for (let k = open + 1; k < n; k++) if (code[k] === '}' && depthAt[k] === bodyDepth) { close = k; break; }
      const methods = new Map();
      const traits = [];
      const body = code.slice(open + 1, close);
      const fnRe = /((?:\b(?:final|abstract|public|protected|private|static|var)\s+)*)function\s+&?\s*([A-Za-z_]\w*)\s*\(/gi;
      let f;
      while ((f = fnRe.exec(body)) !== null) {
        if (depthAt[open + 1 + f.index + f[1].length] !== bodyDepth) continue;
        const mods = f[1];
        if (!methods.has(f[2].toLowerCase())) {
          methods.set(f[2].toLowerCase(), {
            name: f[2],
            visibility: /\bprivate\b/i.test(mods) ? 'private' : /\bprotected\b/i.test(mods) ? 'protected' : 'public',
            isStatic: /\bstatic\b/i.test(mods),
            isFinal: /\bfinal\b/i.test(mods),
          });
        }
      }
      const tRe = /(?<![\w$\\>:])use\s+([^;{]+)[;{]/gi;
      while ((f = tRe.exec(body)) !== null) {
        if (depthAt[open + 1 + f.index] !== bodyDepth) continue;
        for (const t of f[1].split(',')) { const r = resolvePhpName(t, seg.ns, uses); if (r) traits.push(r); }
      }
      const isAbstract = /\babstract\b/i.test(m[1]);
      types.push({
        fqcn: seg.ns ? `${seg.ns}\\${shortName}` : shortName,
        shortName,
        namespace: seg.ns,
        kind,
        isFinal: /\bfinal\b/i.test(m[1]),
        isAbstract,
        parents: kind === 'class' ? list(ext).slice(0, 1) : [],
        interfaces: kind === 'interface' ? list(ext) : (kind === 'trait' ? [] : list(impl)),
        methods,
        traits,
      });
    }
  }
  const result = { types };
  if (phpFileCache.size > 5000) phpFileCache.clear();
  phpFileCache.set(key, result);
  return result;
}

function typeIn(file, fqcn) {
  const lower = normalizeClassName(fqcn).toLowerCase();
  return file.types.find(t => t.fqcn.toLowerCase() === lower) || null;
}

/** Direct parent class and interfaces declared in a PHP source file for `shortName`. */
export function parsePhpDeclaration(source, shortName) {
  const t = parsePhpFile(source).types.find(x => x.shortName.toLowerCase() === String(shortName).toLowerCase());
  if (!t) return { namespace: '', parents: [], interfaces: [] };
  return { namespace: t.namespace, parents: t.parents, interfaces: t.interfaces };
}

/**
 * Returns `ancestorsOf(fqcn)` → parent classes and interfaces, nearest first, transitive, with the
 * declared spelling of each name (PHP class names are case-insensitive).
 * `findFile(fqcn)` returns the PHP file path or ''.
 */
export function createAncestorResolver(findFile, readFile = p => readFileSync(p, 'utf-8')) {
  const declCache = new Map();
  function declOf(fqcn) {
    const key = normalizeClassName(fqcn).toLowerCase();
    if (declCache.has(key)) return declCache.get(key);
    declCache.set(key, null);
    let decl = null;
    try {
      const file = findFile(normalizeClassName(fqcn));
      if (file) decl = typeIn(parsePhpFile(readFile(file)), fqcn);
    } catch { decl = null; }
    declCache.set(key, decl);
    return decl;
  }
  const canonical = name => declOf(name)?.fqcn || name;
  const ancestorsOf = function ancestorsOf(fqcn) {
    const out = [];
    const start = normalizeClassName(fqcn);
    const seen = new Set([start.toLowerCase()]);
    const first = declOf(start);
    const queue = first ? [...first.parents, ...first.interfaces] : [];
    while (queue.length) {
      const next = canonical(queue.shift());
      if (seen.has(next.toLowerCase())) continue;
      seen.add(next.toLowerCase());
      out.push(next);
      const d = declOf(next);
      if (d) queue.push(...d.parents, ...d.interfaces);
    }
    return out;
  };
  ancestorsOf.declOf = declOf;
  return ancestorsOf;
}

// ─── Modules, load order and the configuration cascade ─────────

/** `<module name="…"><sequence><module name="…"/></sequence></module>` */
export function parseModuleXml(content) {
  const doc = parseXml(content);
  for (const node of walk(doc)) {
    if (node.name !== 'module' || !node.attrs.name) continue;
    const seq = node.children.find(c => c.name === 'sequence');
    return {
      name: node.attrs.name,
      sequence: seq ? seq.children.filter(c => c.name === 'module' && c.attrs.name).map(c => c.attrs.name) : [],
    };
  }
  return null;
}

/** Module list of app/etc/config.php, in file order (= the load order written by setup:upgrade). */
export function parseConfigPhpModules(content) {
  const out = [];
  const code = scanPhp(content || '', { keepStrings: true });   // comments removed, strings kept
  const start = /(['"])modules\1\s*=>\s*(?:array\s*\(|\[)/i.exec(code);
  if (!start) return out;
  // The modules array ends at its matching bracket
  let depth = 0;
  let end = code.length;
  for (let k = start.index + start[0].length - 1; k < code.length; k++) {
    const ch = code[k];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') { depth--; if (depth === 0) { end = k; break; } }
  }
  const block = code.slice(start.index + start[0].length, end);
  // A module name is whatever registration.php registers — "Amasty_Mage2.4.7Fix" has dots
  const re = /(['"])([^'"\\\s]+)\1\s*=>\s*(1|0|true|false)\b/gi;
  let m;
  while ((m = re.exec(block)) !== null) out.push({ name: m[2], enabled: m[3] === '1' || m[3].toLowerCase() === 'true' });
  return out;
}

/**
 * Module index: which module a config file belongs to, whether it is enabled, its load order and its
 * declared dependencies (<sequence> — the soft, load-order dependency — and composer `require`).
 *
 * @param moduleXmls   [{ relPath: 'app/code/V/M/etc/module.xml', content }]
 * @param configPhp    content of app/etc/config.php or null
 * @param composerJson (moduleDir) => parsed composer.json or null
 */
export function buildModuleIndex(moduleXmls, configPhp, composerJson = () => null) {
  const modules = new Map();
  for (const { relPath, content } of moduleXmls) {
    let parsed;
    try { parsed = parseModuleXml(content); } catch { parsed = null; }
    if (!parsed || modules.has(parsed.name)) continue;
    const dir = relPath.replace(/\/etc\/module\.xml$/, '');
    let composer = null;
    try { composer = composerJson(dir); } catch { composer = null; }
    modules.set(parsed.name, {
      name: parsed.name, dir, sequence: parsed.sequence, enabled: null, order: null,
      package: composer?.name || null, requires: Object.keys(composer?.require || {}),
    });
  }
  const listed = parseConfigPhpModules(configPhp);
  let orderSource = 'sequence';
  if (listed.length) {
    orderSource = 'config.php';
    listed.forEach((m, i) => {
      const mod = modules.get(m.name);
      if (mod) { mod.enabled = m.enabled; mod.order = i; }
    });
  } else {
    // No config.php: topological order by <sequence>, alphabetical among unrelated modules.
    const names = [...modules.keys()].sort();
    const visited = new Set();
    let i = 0;
    const visit = (n, stack = new Set()) => {
      if (visited.has(n) || stack.has(n)) return;
      stack.add(n);
      for (const dep of modules.get(n)?.sequence || []) if (modules.has(dep)) visit(dep, stack);
      visited.add(n);
      modules.get(n).order = i++;
    };
    names.forEach(n => visit(n));
  }
  const byPackage = new Map([...modules.values()].filter(m => m.package).map(m => [m.package, m.name]));
  const dirs = [...modules.values()].sort((a, b) => b.dir.length - a.dir.length);
  const depCache = new Map();
  const moduleOfCache = new Map();

  function dependsOn(a, b) {
    if (!a || !b || a === b) return false;
    const key = `${a}>${b}`;
    if (depCache.has(key)) return depCache.get(key);
    depCache.set(key, false);
    const seen = new Set();
    const queue = [a];
    let found = false;
    while (queue.length && !found) {
      const cur = modules.get(queue.shift());
      if (!cur || seen.has(cur.name)) continue;
      seen.add(cur.name);
      const next = [...cur.sequence, ...cur.requires.map(r => byPackage.get(r)).filter(Boolean)];
      if (next.includes(b)) found = true;
      queue.push(...next);
    }
    depCache.set(key, found);
    return found;
  }

  return {
    modules,
    orderSource,
    moduleOf(relPath) {
      if (moduleOfCache.has(relPath)) return moduleOfCache.get(relPath);
      const hit = dirs.find(m => relPath === m.dir || relPath.startsWith(m.dir + '/'));
      const name = hit ? hit.name : null;
      moduleOfCache.set(relPath, name);
      return name;
    },
    isEnabled(name) { return name && modules.has(name) ? modules.get(name).enabled : null; },
    orderOf(name) {
      const o = name && modules.has(name) ? modules.get(name).order : null;
      return o === null || o === undefined ? Number.MAX_SAFE_INTEGER : o;
    },
    /**
     * Load position of a config file. Magento reads app/etc/di.xml and app/etc/*\/di.xml (primary
     * scope) before any module, and never reads a file outside app/etc and the modules — a
     * dev/tests sandbox, the magento2-base copy of app/etc, an unregistered copy of a module — so
     * those rank lowest and never override real configuration.
     */
    orderOfFile(relPath, module = this.moduleOf(relPath)) {
      if (module) return this.orderOf(module);
      return /^app\/etc\/(?:[^/]+\/)?[^/]+\.xml$/.test(relPath || '') ? -1 : -2;
    },
    dependsOn,
  };
}

/**
 * Order declarations of the same key the way Magento merges them for `area`: global first, then the
 * area; within a scope in module load order. Declarations of disabled modules are set aside.
 * `ambiguous` lists pairs in the same scope whose modules have neither a <sequence> nor a composer
 * dependency on each other — their relative order is incidental and can change with an update.
 */
export function orderDeclarations(decls, idx, area = 'global', conflicts = () => true) {
  const withModule = decls.map(d => ({ ...d, module: d.module ?? idx.moduleOf(d.file) }));
  const disabledModule = withModule.filter(d => idx.isEnabled(d.module) === false);
  const scoped = withModule
    .filter(d => idx.isEnabled(d.module) !== false && (d.area === 'global' || d.area === area))
    .map(d => ({ d, scope: d.area === 'global' ? 0 : 1, order: idx.orderOfFile(d.file, d.module) }))
    .sort((a, b) => a.scope - b.scope || a.order - b.order);
  const ambiguous = [];
  for (let i = 0; i < scoped.length; i++) {
    for (let j = i + 1; j < scoped.length; j++) {
      const a = scoped[i].d;
      const b = scoped[j].d;
      if (scoped[i].scope !== scoped[j].scope || !a.module || !b.module || a.module === b.module) continue;
      if (idx.dependsOn(a.module, b.module) || idx.dependsOn(b.module, a.module)) continue;
      if (conflicts(a, b)) ambiguous.push({ first: a, second: b });
    }
  }
  return { ordered: scoped.map(x => x.d), disabledModule, ambiguous };
}

/**
 * Keep only the ambiguous pairs whose swap would change the outcome: an incidental order matters
 * only when it decides something (the winning preference, the class that runs, enabled/disabled).
 */
function outcomeDependent(ordered, ambiguous, outcome) {
  const base = JSON.stringify(outcome(ordered));
  return ambiguous.filter(({ first, second }) => {
    const i = ordered.indexOf(first);
    const j = ordered.indexOf(second);
    if (i < 0 || j < 0) return false;
    const swapped = [...ordered];
    swapped[i] = second;
    swapped[j] = first;
    return JSON.stringify(outcome(swapped)) !== base;
  });
}

/** Effective preference for `forName` in `area`, with the superseded declarations. */
export function preferenceCascade(model, idx, forName, area = 'global') {
  const decls = model.preferences.filter(p => p.for === normalizeClassName(forName));
  const res = orderDeclarations(decls, idx, area, (a, b) => a.type !== b.type);
  const { ordered, disabledModule } = res;
  const winner = ordered[ordered.length - 1] || null;
  const ambiguous = outcomeDependent(ordered, res.ambiguous, list => list[list.length - 1]?.type ?? null);
  return { winner, superseded: ordered.slice(0, -1), disabledModule, ambiguous };
}

/**
 * Merge declarations of one named plugin (on one type) or one named observer (on one event):
 * attributes of later declarations override earlier ones, absent attributes are kept.
 */
export function mergeNamedDeclarations(decls, idx, area = 'global', instanceKey = 'type') {
  const differs = (a, b) =>
    (a[instanceKey] && b[instanceKey] && a[instanceKey] !== b[instanceKey]) ||
    (a.disabledAttr !== null && b.disabledAttr !== null && a.disabledAttr !== b.disabledAttr) ||
    (a.disabledAttr === null) !== (b.disabledAttr === null);
  const res = orderDeclarations(decls, idx, area, differs);
  const { ordered, disabledModule } = res;
  const fold = list => {
    let inst = null;
    let dis = false;
    for (const d of list) {
      if (d[instanceKey]) inst = d[instanceKey];
      if (d.disabledAttr !== null && d.disabledAttr !== undefined) dis = d.disabledAttr;
    }
    return { inst, dis };
  };
  // Order-dependent only if it decides what runs: a disabled result stays "does not run" either way.
  const ambiguous = outcomeDependent(ordered, res.ambiguous, list => {
    const r = fold(list);
    return r.dis ? 'disabled' : r.inst;
  });
  let instance = null;
  let instanceFrom = null;
  let disabled = false;
  let disabledBy = null;
  let sortOrder = null;
  for (const d of ordered) {
    if (d[instanceKey]) { instance = d[instanceKey]; instanceFrom = d; }
    if (d.disabledAttr !== null && d.disabledAttr !== undefined) { disabled = d.disabledAttr; disabledBy = d.disabledAttr ? d : null; }
    if (d.sortOrder !== null && d.sortOrder !== undefined) sortOrder = d.sortOrder;
  }
  return { instance, instanceFrom, disabled, disabledBy, sortOrder, ordered, disabledModule, ambiguous };
}

// ─── Interceptability ───────────────────────────────────────────

export const NONINTERCEPTABLE_INTERFACE = 'Magento\\Framework\\ObjectManager\\NoninterceptableInterface';
// Mirrors Magento\Framework\Interception\Code\Generator\Interceptor::isInterceptedMethod()
const NOT_INTERCEPTED_METHODS = ['__construct', '__destruct', '__sleep', '__wakeup', '__clone', '_resetState'];

/** Class modifiers, method signatures (visibility, static, final) and traits of `shortName` in a PHP file. */
export function parsePhpMembers(source, shortName) {
  const t = parsePhpFile(source).types.find(x => x.shortName.toLowerCase() === String(shortName).toLowerCase());
  if (!t) return null;
  return { kind: t.kind, isFinal: t.isFinal, isAbstract: t.isAbstract, methods: t.methods, traits: t.traits };
}

/** `membersOf(fqcn)` → parsePhpMembers-like result for exactly that FQCN, or null when not found. */
export function createMemberResolver(findFile, readFile = p => readFileSync(p, 'utf-8')) {
  const cache = new Map();
  return function membersOf(fqcn) {
    const n = normalizeClassName(fqcn);
    const key = n.toLowerCase();
    if (cache.has(key)) return cache.get(key);
    let info = null;
    try {
      const file = findFile(n);
      if (file) {
        const t = typeIn(parsePhpFile(readFile(file)), n);
        if (t) info = { kind: t.kind, isFinal: t.isFinal, isAbstract: t.isAbstract, methods: t.methods, traits: t.traits };
      }
    } catch { info = null; }
    cache.set(key, info);
    return info;
  };
}

/** Method declared on a type or (recursively) on the traits it uses. */
function findMethod(type, key, membersOf, seen = new Set()) {
  if (seen.has(type.toLowerCase())) return { method: null, unknown: false };
  seen.add(type.toLowerCase());
  const info = membersOf(type);
  if (!info) return { method: null, unknown: true };
  if (info.methods.has(key)) return { method: info.methods.get(key), unknown: false };
  let unknown = false;
  for (const tr of info.traits || []) {
    const r = findMethod(tr, key, membersOf, seen);
    if (r.method) return r;
    unknown = unknown || r.unknown;
  }
  return { method: null, unknown };
}

/**
 * Whether plugins on `className` (and on `methodName`, when given) can run.
 * Returns { interceptable: true } / { interceptable: false, reason } / { interceptable: null } (unknown).
 */
export function interceptionStatus(className, methodName, ancestorsOf, membersOf) {
  const n = normalizeClassName(className);
  const own = membersOf(n);
  if (!own) return { interceptable: null };
  const ancestors = ancestorsOf(n);
  const nonInterceptable = NONINTERCEPTABLE_INTERFACE.toLowerCase();
  if (n.toLowerCase() === nonInterceptable || ancestors.some(a => a.toLowerCase() === nonInterceptable)) {
    return { interceptable: false, reason: `implements \`${NONINTERCEPTABLE_INTERFACE}\` — no interceptor is generated` };
  }
  if (own.kind === 'class' && own.isFinal) {
    return { interceptable: false, reason: 'the class is final — it cannot be intercepted' };
  }
  if (!methodName) return { interceptable: true };
  const key = methodName.toLowerCase();
  // PHP method resolution: the class (and its traits), then the parent chain, then interfaces
  const classes = [];
  const ifaces = [];
  for (const a of ancestors) {
    const info = membersOf(a);
    (info && info.kind === 'interface' ? ifaces : classes).push(a);
  }
  let unknown = false;
  for (const type of [n, ...classes, ...ifaces]) {
    const { method, unknown: u } = findMethod(type, key, membersOf);
    unknown = unknown || u;
    if (!method) continue;
    if (NOT_INTERCEPTED_METHODS.some(x => x.toLowerCase() === key)) {
      return { interceptable: false, reason: `\`${method.name}()\` is never intercepted` };
    }
    if (method.visibility !== 'public') return { interceptable: false, reason: `\`${method.name}()\` is ${method.visibility} — only public methods are intercepted` };
    if (method.isStatic) return { interceptable: false, reason: `\`${method.name}()\` is static — not intercepted` };
    if (method.isFinal) return { interceptable: false, reason: `\`${method.name}()\` is final — not intercepted` };
    return { interceptable: true };
  }
  if (unknown) return { interceptable: null };
  return { interceptable: false, reason: `no \`${methodName}()\` method on the class or its parents — the plugin method never runs (magic __call methods are not intercepted)` };
}

// ─── Reverse class hierarchy (instanceof) ───────────────────────

/** All class / interface / enum declarations in a PHP file with their resolved parents and interfaces. */
export function parsePhpTypes(source) {
  return parsePhpFile(source).types
    .filter(t => t.kind !== 'trait')
    .map(t => ({
      fqcn: t.fqcn,
      kind: t.kind === 'class' && t.isAbstract ? 'abstract class' : t.kind,
      parents: t.parents,
      interfaces: t.interfaces,
    }));
}

/**
 * Build { types: Map lowercase fqcn → decl+file, children: Map lowercase fqcn → [{ child, relation }] }.
 * Keys are lower-cased because PHP class names are case-insensitive.
 */
export function buildClassHierarchy(entries) {
  const types = new Map();
  const children = new Map();
  const add = (parent, child, relation) => {
    const k = parent.toLowerCase();
    if (!children.has(k)) children.set(k, []);
    children.get(k).push({ child, relation });
  };
  for (const { relPath, source } of entries) {
    let decls;
    try { decls = parsePhpTypes(source); } catch { continue; }
    for (const t of decls) {
      const k = t.fqcn.toLowerCase();
      if (types.has(k)) continue;
      types.set(k, { ...t, file: relPath });
      for (const p of t.parents) add(p, t.fqcn, 'extends');
      for (const i of t.interfaces) add(i, t.fqcn, t.kind === 'interface' ? 'extends' : 'implements');
    }
  }
  return { types, children };
}

/**
 * Everything that is `instanceof` `fqcn`: implementors, extending interfaces, their implementors
 * and all subclasses, transitively. Each entry carries the path from `fqcn`.
 */
export function instancesOf(hierarchy, fqcn) {
  const root = normalizeClassName(fqcn);
  const out = [];
  const seen = new Set([root.toLowerCase()]);
  const queue = [{ name: root, path: [root] }];
  while (queue.length) {
    const { name, path } = queue.shift();
    for (const { child, relation } of hierarchy.children.get(name.toLowerCase()) || []) {
      if (seen.has(child.toLowerCase())) continue;
      seen.add(child.toLowerCase());
      const decl = hierarchy.types.get(child.toLowerCase());
      const childPath = [...path, child];
      out.push({ fqcn: child, kind: decl?.kind || 'class', file: decl?.file || null, relation, via: name, depth: path.length, path: childPath });
      queue.push({ name: child, path: childPath });
    }
  }
  return out;
}

// ─── Configuration validation (what Magento rejects) ────────────
//
// Magento\Framework\Config\Dom::_initDom() loads each file with DOMDocument; a file that is not
// well-formed fails in every mode with Config\Reader\Filesystem's message. Schema (XSD) errors fail
// only when validation is required (developer mode). Values are then read by the converters:
// ObjectManager\Config\Mapper\Dom → BooleanUtils::toBoolean() (strict) for plugin disabled / type
// shared, (int) for sortOrder; Event\Config\Converter disables an observer only on disabled == 'true'.

/** Config\Dom::ERROR_FORMAT_DEFAULT */
export const MAGENTO_XML_ERROR_FORMAT = '%message%\nLine: %line%\n';

/** The text Config\Reader\Filesystem::_readFiles() throws for a file DOMDocument cannot load. */
export function magentoInvalidXmlMessage(file, errors) {
  const body = errors.map(e => MAGENTO_XML_ERROR_FORMAT.replace('%message%', e.message).replace('%line%', String(e.line))).join('\n');
  return `The XML in file "${file}" is invalid:\n${body}\nVerify the XML and try again.`;
}

/** var_export() of BooleanUtils' allowed values, as in its exception message. */
export const BOOLEAN_UTILS_MESSAGE = "Boolean value is expected, supported values: array (\n  0 => true,\n  1 => 1,\n  2 => 'true',\n  3 => '1',\n  4 => false,\n  5 => 0,\n  6 => 'false',\n  7 => '0',\n)";

const XML_NAME = /[A-Za-z_:][\w:.-]*/y;

/**
 * Well-formedness check without PHP. Returns [] for a well-formed document, otherwise the first error
 * libxml reports, with libxml's wording and line (checked against libxml 2.9 — see
 * tests/di-parsing.test.js). libxml usually adds follow-up errors; only a native check lists them all.
 * An empty file is not an XML error in Magento: DOMDocument::loadXML('') throws a ValueError (PHP 8).
 */
export function checkXmlWellFormed(content) {
  const src = String(content ?? '');
  const lineAt = (() => {
    const starts = [0];
    for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
    return off => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; } return lo + 1; };
  })();
  const err = (off, message) => [{ line: lineAt(off), message }];
  if (src === '') return [{ line: 0, message: 'DOMDocument::loadXML(): Argument #1 ($source) must not be empty' }];
  const skipBlanks = off => { let k = off; while (k < src.length && /[ \t\r\n]/.test(src[k])) k++; return k; };
  const firstContent = skipBlanks;
  // <?xml version="…" encoding="…" standalone="…"?> — the checks and messages of xmlParseXMLDecl()
  const parseXmlDecl = () => {
    let j = skipBlanks(5);
    const VALUE_CHARS = { encoding: /[\w.-]/, standalone: /[a-z]/ };
    const value = (attr, at) => {
      let k = skipBlanks(at + attr.length);
      if (src[k] !== '=') return { error: err(k, "expected '='") };
      k = skipBlanks(k + 1);
      const q = src[k];
      if (q !== '"' && q !== "'") return { error: err(k, 'String not started expecting \' or "') };
      let end = k + 1;
      if (attr === 'version') {                               // xmlParseVersionNum(): [0-9]+ '.' [0-9]*
        const num = /^[0-9]+\.[0-9]*/.exec(src.slice(end));
        end += num ? num[0].length : 0;
        if (src[end] !== q) return { error: err(end, 'String not closed expecting " or \'') };
        if (!num) return { error: err(end + 1, 'Malformed declaration expecting version') };
        return { end: end + 1, value: num[0] };
      }
      while (end < src.length && VALUE_CHARS[attr].test(src[end])) end++;
      if (src[end] !== q) return { error: err(end, 'String not closed expecting " or \'') };
      return { end: end + 1, value: src.slice(k + 1, end) };
    };
    if (!src.startsWith('version', j)) return { error: err(j, 'Malformed declaration expecting version') };
    let v = value('version', j);
    if (v.error) return v;
    j = v.end;
    // a blank is required after version, and after encoding when it is present
    let needBlank = true;
    for (const attr of ['encoding', 'standalone']) {
      if (needBlank) {
        if (src.startsWith('?>', j)) return { end: j + 2 };
        if (skipBlanks(j) === j) return { error: err(j, 'Blank needed here') };
      }
      j = skipBlanks(j);
      needBlank = false;
      if (!src.startsWith(attr, j)) continue;
      v = value(attr, j);
      if (v.error) return v;
      j = v.end;
      needBlank = attr === 'encoding';
    }
    j = skipBlanks(j);
    if (src.startsWith('?>', j)) return { end: j + 2 };
    return { error: err(j, "parsing XML declaration: '?>' expected") };
  };
  const stack = [];
  const declaredEntities = new Set();   // <!ENTITY name …> in the internal DTD subset
  let rootClosed = false;
  let sawRoot = false;
  const checkText = (from, to) => {
    const t = src.slice(from, to);
    const amp = /&/g;
    let m;
    while ((m = amp.exec(t)) !== null) {
      const rest = t.slice(m.index + 1);
      if (/^(#x[0-9a-fA-F]+|#\d+);/.test(rest)) continue;
      const named = /^([A-Za-z_:][\w.:-]*)(;?)/.exec(rest);
      if (!named) return err(from + m.index, 'xmlParseEntityRef: no name');
      if (!named[2]) return err(from + m.index, "EntityRef: expecting ';'");
      if (!['amp', 'lt', 'gt', 'quot', 'apos'].includes(named[1]) && !declaredEntities.has(named[1])) return err(from + m.index, `Entity '${named[1]}' not defined`);
    }
    return null;
  };
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    const textEnd = lt < 0 ? src.length : lt;
    if (textEnd > i) {
      const text = src.slice(i, textEnd);
      if (text.trim() && (!stack.length)) {
        return err(firstContent(i), sawRoot ? 'Extra content at the end of the document' : "Start tag expected, '<' not found");
      }
      const e = checkText(i, textEnd);
      if (e) return e;
    }
    if (lt < 0) break;
    i = lt;
    if (src.startsWith('<!--', i)) {
      const e = src.indexOf('-->', i + 4);
      const dash = src.indexOf('--', i + 4);
      if (dash >= 0 && (e < 0 || dash < e)) {
        // libxml's fast path (ASCII) and complex path word the same error differently
        const before = src.slice(i + 4, dash);
        return err(dash, /[^\x00-\x7f]/.test(before) ? "Comment must not contain '--' (double-hyphen)" : 'Double hyphen within comment: <!--');
      }
      if (e < 0) return err(src.length, 'Comment not terminated');
      i = e + 3; continue;
    }
    if (src.startsWith('<![CDATA[', i)) {
      const e = src.indexOf(']]>', i + 9);
      if (e < 0) return err(src.length, 'CData section not finished');
      i = e + 3; continue;
    }
    if (src.startsWith('<?', i)) {
      if (i === 0 && /^<\?xml\s/.test(src)) {                   // xmlParseXMLDecl()
        const d = parseXmlDecl();
        if (d.error) return d.error;
        i = d.end; continue;
      }
      XML_NAME.lastIndex = i + 2;
      const target = XML_NAME.exec(src);
      if (target && target[0].toLowerCase() === 'xml') return err(i + 2 + target[0].length, 'XML declaration allowed only at the start of the document');
      if (!target) return err(i + 2, 'xmlParsePI : no target name');
      const after = i + 2 + target[0].length;
      if (!src.startsWith('?>', after) && skipBlanks(after) === after) return err(after, `ParsePI: PI ${target[0]} space expected`);
      const e = src.indexOf('?>', i + 2);
      if (e < 0) return err(i, 'ParsePI: PI xml never end ...');
      i = e + 2; continue;
    }
    if (src.startsWith('<!DOCTYPE', i)) {
      const m = /^<!DOCTYPE(?:[^[>]|\[[\s\S]*?\])*>/.exec(src.slice(i));
      if (!m) return err(i, 'DOCTYPE improperly terminated');
      for (const d of m[0].matchAll(/<!ENTITY\s+([A-Za-z_][\w.-]*)\s/g)) declaredEntities.add(d[1]);
      i += m[0].length; continue;
    }
    if (src[i + 1] === '/') {                                   // closing tag
      if (!sawRoot) return err(i + 1, 'StartTag: invalid element name');
      XML_NAME.lastIndex = i + 2;
      const nm = XML_NAME.exec(src);
      const name = nm ? nm[0] : '';
      let j = nm ? XML_NAME.lastIndex : i + 2;
      while (/\s/.test(src[j] || '')) j++;
      if (!name || src[j] !== '>') return err(j, "expected '>'");
      const open = stack.pop();
      if (!open) return err(i, 'Extra content at the end of the document');
      if (open.name !== name) return err(i, `Opening and ending tag mismatch: ${open.name} line ${open.line} and ${name}`);
      i = j + 1;
      if (!stack.length) rootClosed = true;
      continue;
    }
    // start tag
    XML_NAME.lastIndex = i + 1;
    const nm = XML_NAME.exec(src);
    if (!nm) return err(i, 'StartTag: invalid element name');
    if (rootClosed) return err(i, 'Extra content at the end of the document');
    const name = nm[0];
    const tagLine = lineAt(i);
    let j = XML_NAME.lastIndex;
    const seen = new Set();
    j = skipBlanks(j);
    for (;;) {
      if (src[j] === '>') { stack.push({ name, line: tagLine }); sawRoot = true; j++; break; }
      if (src[j] === '/' && src[j + 1] === '>') { sawRoot = true; if (!stack.length) rootClosed = true; j += 2; break; }
      if (j >= src.length) return err(j, `Couldn't find end of Start Tag ${name} line ${tagLine}`);
      XML_NAME.lastIndex = j;
      const an = XML_NAME.exec(src);
      if (!an) return err(j, 'error parsing attribute name');
      const local = an[0].slice(an[0].indexOf(':') + 1) || an[0];      // libxml names the QName's local part
      j = skipBlanks(XML_NAME.lastIndex);
      if (src[j] !== '=') return err(j, 'Specification mandates value for attribute ' + local);
      j = skipBlanks(j + 1);
      const q = src[j];
      if (q !== '"' && q !== "'") return err(j, 'AttValue: " or \' expected');
      let close = j + 1;
      while (close < src.length && src[close] !== q && src[close] !== '<') close++;
      if (src[close] === '<') return err(close, "Unescaped '<' not allowed in attributes values");
      if (close >= src.length) return err(close, 'AttValue: \' expected');
      const e = checkText(j + 1, close);
      if (e) return e;
      if (seen.has(an[0])) return err(close, `Attribute ${an[0]} redefined`);
      seen.add(an[0]);
      j = close + 1;
      if (src[j] === '>' || (src[j] === '/' && src[j + 1] === '>')) continue;
      const k = skipBlanks(j);
      if (k === j) return err(j, 'attributes construct error');
      j = k;
    }
    i = j;
  }
  if (stack.length) {
    const open = stack[stack.length - 1];
    return err(src.length, `Premature end of data in tag ${open.name} line ${open.line}`);
  }
  if (!sawRoot) return err(src.length, "Start tag expected, '<' not found");
  return [];
}

// ─── DI arguments, as Magento reads them ─────────────────────────
// ObjectManager\Config\Mapper\ArgumentParser converts an <argument> with Config\Converter\Dom\Flat
// (items keyed by name on paths argument(/item)+), then the interpreters of
// ObjectManagerFactory::createArgumentInterpreter() evaluate it. Both are ported here with their
// order and messages; `const` / `init_parameter` need PHP's defined() and stay with the native check.

class MagentoException extends Error {
  constructor(cls, message, node) { super(message); this.cls = cls; this.node = node; }
}

/**
 * Config\Converter\Dom\Flat::convert(): element children first (depth-first), the first non-blank
 * text or CDATA child ends the scan and becomes the value. Returns { data, dropped } — dropped:
 * element children discarded because a text / CDATA child made the node a scalar.
 */
function flatConvert(node, basePath, onDropped) {
  let value = {};
  let isScalar = false;
  let elements = 0;
  for (const entry of node.seq || []) {
    if (entry.node) {
      const child = entry.node;
      const nodePath = `${basePath}/${child.name}`;
      const isArrayNode = /^argument(\/item)+$/.test(nodePath);
      if (value[child.name] !== undefined && !isArrayNode) {
        throw new MagentoException('UnexpectedValueException', `Node path '${nodePath}' is not unique, but it has not been marked as array.`, child);
      }
      const data = flatConvert(child, nodePath, onDropped);
      elements++;
      if (isArrayNode) {
        if (!(data && typeof data === 'object' && data.name !== undefined)) {
          throw new MagentoException('UnexpectedValueException', "Array is expected to contain value for key 'name'.", child);
        }
        (value[child.name] ||= new Map()).set(data.name, data);
      } else {
        value[child.name] = data;
      }
    } else if (entry.cdata !== undefined || (entry.text !== undefined && entry.text.trim() !== '')) {
      if (elements) onDropped(node, elements, (entry.cdata ?? entry.text).trim());
      value = entry.cdata ?? entry.text;
      isScalar = true;
      break;
    }
  }
  const attrs = { ...node.attrs };
  if (!isScalar) {
    const result = { ...attrs, ...value };
    return Object.keys(result).length ? result : '';
  }
  return Object.keys(attrs).length ? { ...attrs, value: value.trim() } : value.trim();
}

const BOOLEAN_VALUES = ['true', '1', 'false', '0'];
const PHP_NUMERIC = /^[ \t\n\r\v\f]*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?[ \t\n\r\v\f]*$/;

/** Magento\Framework\ObjectManager\Helper\SortItems (single level): stable, by (int) sortOrder. */
function sortArrayItems(items) {
  const list = [...items.values()];
  if (!list.some(i => i && typeof i === 'object' && i.sortOrder !== undefined)) return list;
  return list.map((item, index) => ({ item, index, order: phpIntCast(item?.sortOrder ?? 0) }))
    .sort((a, b) => a.order - b.order || a.index - b.index).map(x => x.item);
}

/** Data\Argument\Interpreter\Composite and the interpreters it dispatches to. */
function evaluateArgument(data, node) {
  if (!data || typeof data !== 'object' || data['xsi:type'] === undefined) {
    throw new MagentoException('InvalidArgumentException', 'Value for key "xsi:type" is missing in the argument data.', node);
  }
  const type = data['xsi:type'];
  const has = k => data[k] !== undefined && data[k] !== null;
  switch (type) {
    case 'boolean':
      if (!has('value')) throw new MagentoException('InvalidArgumentException', 'Boolean value is missing.', node);
      if (!BOOLEAN_VALUES.includes(data.value)) throw new MagentoException('InvalidArgumentException', BOOLEAN_UTILS_MESSAGE, node);
      return;
    case 'string':
      if (has('value') && typeof data.value !== 'string') throw new MagentoException('InvalidArgumentException', 'String value is expected.', node);
      return;
    case 'number':
      if (!has('value') || typeof data.value !== 'string' || !PHP_NUMERIC.test(data.value)) {
        throw new MagentoException('InvalidArgumentException', 'Numeric value is expected.', node);
      }
      return;
    case 'null':
      return;
    case 'object':
      if (!has('value')) throw new MagentoException('Exception', 'Warning: Undefined array key "value"', node);
      if (has('shared') && !BOOLEAN_VALUES.includes(data.shared)) throw new MagentoException('InvalidArgumentException', BOOLEAN_UTILS_MESSAGE, node);
      return;
    case 'const':
    case 'init_parameter':
      if (!has('value')) throw new MagentoException('InvalidArgumentException', 'Constant name is expected.', node);
      return;                                                   // defined() — native check only
    case 'array': {
      const items = data.item ?? new Map();
      if (!(items instanceof Map)) throw new MagentoException('InvalidArgumentException', 'Array items are expected.', node);
      for (const item of sortArrayItems(items)) evaluateArgument(item, node);
      return;
    }
    default:
      throw new MagentoException('InvalidArgumentException', `Argument interpreter named '${type}' has not been defined.`, node);
  }
}

/** PHP's (int) cast of a string: leading whitespace, numeric prefix (exponent included), truncated. */
export function phpIntCast(value) {
  const m = /^[ \t\n\r\v\f]*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(String(value));
  return m ? Math.trunc(Number(m[1])) : 0;
}

const nullAttributeMessage = (converter) =>
  `Warning: Attempt to read property "nodeValue" on null in ${converter} (Magento's ErrorHandler throws it as an exception)`;

/**
 * Checks a well-formed di.xml / events.xml the way Magento's converters read it
 * (ObjectManager\Config\Mapper\Dom, Event\Config\Converter). Returns [{ severity, line, message }]:
 * 'error' — Magento throws in every mode; 'warning' — loads, but not as written. Schema (XSD)
 * validation, which only runs in developer mode, is not reproduced here — the native check does it.
 */
export function checkConfigValues(content, relPath) {
  const out = [];
  const doc = parseXml(String(content ?? ''));
  const root = doc.children[0];
  if (!root) return out;
  const isEvents = /(^|\/)events\.xml$/.test(relPath || '');
  const add = (severity, node, message) => out.push({ severity, line: node.line || 0, message });
  const label = n => (n.attrs.name ? `<${n.name} name="${n.attrs.name}">` : `<${n.name}>`);
  const BOOLEAN = ['true', '1', 'false', '0'];
  if (isEvents) {
    const CONVERTER = 'Magento\\Framework\\Event\\Config\\Converter';
    for (const ev of walk(root)) {
      if (ev.name !== 'event') continue;
      if (ev.attrs.name === undefined) add('error', ev, `<event> without name: ${nullAttributeMessage(CONVERTER)}`);
      for (const o of ev.children.filter(c => c.name === 'observer')) {
        if (o.attrs.name === undefined) { add('error', o, "<observer> without name: InvalidArgumentException 'Attribute name is missed'"); continue; }
        if (o.attrs.disabled !== undefined && o.attrs.disabled !== 'true' && o.attrs.disabled !== 'false') {
          add('warning', o, `${label(o)} disabled="${o.attrs.disabled}" does not disable the observer — ${CONVERTER} disables only on disabled="true"`);
        }
        if (o.attrs.shared !== undefined && o.attrs.shared !== 'true' && o.attrs.shared !== 'false') {
          add('warning', o, `${label(o)} shared="${o.attrs.shared}" is ignored — ${CONVERTER} reads only shared="false"`);
        }
      }
    }
    return out;
  }
  const MAPPER = 'Magento\\Framework\\ObjectManager\\Config\\Mapper\\Dom';
  const thrown = (e, node, where) => {
    if (!(e instanceof MagentoException)) throw e;
    add('error', e.node || node, `${where}: ${e.cls} '${e.message}'`);
  };
  // Mapper\Dom::convert() order: direct children of <config>; per type shared, then its children in
  // order, then its name; per plugin disabled, then its name; per argument its name, then Flat, then
  // the interpreters.
  for (const node of root.children) {
    if (node.name === 'preference') {
      if (node.attrs.for === undefined || node.attrs.type === undefined) {
        add('error', node, `<preference> without ${node.attrs.for === undefined ? 'for' : 'type'}: ${nullAttributeMessage(MAPPER)}`);
      }
      continue;
    }
    if (node.name !== 'type' && node.name !== 'virtualType') {
      add('error', node, `Exception 'Invalid application config. Unknown node: ${node.name}.'`);
      continue;
    }
    if (node.attrs.shared !== undefined && !BOOLEAN.includes(node.attrs.shared)) {
      add('error', node, `${label(node)} shared="${node.attrs.shared}": InvalidArgumentException '${BOOLEAN_UTILS_MESSAGE}'`);
    }
    for (const child of node.children) {
      if (child.name === 'arguments') {
        for (const arg of child.children) {
          if (arg.attrs.name === undefined) {
            add('error', arg, `<${arg.name}> without name in ${label(node)}: ${nullAttributeMessage(MAPPER)}`);
            continue;
          }
          const where = `${label(node)} argument "${arg.attrs.name}"`;
          try {
            const dropped = [];
            const data = flatConvert(arg, 'argument', (n, count, text) => dropped.push({ n, count, text }));
            for (const d of dropped) {
              add('warning', d.n, `${where}: text "${d.text.slice(0, 40)}" next to ${d.count} child element(s) — Magento's Config\\Converter\\Dom\\Flat reads the text as the value and drops the elements`);
            }
            evaluateArgument(data, arg);
          } catch (e) {
            thrown(e, arg, where);
          }
        }
      } else if (child.name === 'plugin') {
        const a = child.attrs;
        if (a.sortOrder !== undefined && !/^[+-]?\d+$/.test(a.sortOrder)) {
          add('warning', child, `${label(child)} sortOrder="${a.sortOrder}" is read as (int) ${phpIntCast(a.sortOrder)}`);
        }
        if (a.disabled !== undefined && !BOOLEAN.includes(a.disabled)) {
          add('error', child, `${label(child)} disabled="${a.disabled}": InvalidArgumentException '${BOOLEAN_UTILS_MESSAGE}'`);
        }
        if (a.name === undefined) add('error', child, `<plugin> without name in ${label(node)}: ${nullAttributeMessage(MAPPER)}`);
      } else {
        add('error', child, `Exception 'Invalid application config. Unknown node: ${child.name}.'`);
      }
    }
    if (node.attrs.name === undefined) add('error', node, `<${node.name}> without name: ${nullAttributeMessage(MAPPER)}`);
  }
  return out;
}
