#!/usr/bin/env node
/**
 * Broken variants of real configuration files, to compare the built-in configuration check with
 * Magento (compare.mjs config). Copies keep their file name (di.xml, events.xml, …) under
 * <out-dir>/<n>/, so the converters apply as for the original.
 *
 *   node mutate-xml.mjs <magento-root> <files.txt> <out-dir relative to the root> [count=600] [seed=1] [edits=1] [syntax|values]
 *
 * syntax (default) — 1–N edits at XML syntax characters (delete, insert, replace): mostly files that
 *                    are not well-formed, each in a different way.
 * values           — 1–N well-formed edits of what the converters read: disabled / sortOrder / shared /
 *                    xsi:type values, argument text, a dropped name attribute, text next to <item>s.
 *
 * Prints the list of copies (relative to the Magento root) for validate-config.php.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';

const [rootArg, listFile, outDir, countArg, seedArg, editsArg, kind = 'syntax'] = process.argv.slice(2);
if (!rootArg || !listFile || !outDir) {
  console.error('usage: node mutate-xml.mjs <magento-root> <files.txt> <out-dir> [count] [seed] [edits]');
  process.exit(2);
}
const root = path.resolve(rootArg);
const files = readFileSync(listFile, 'utf-8').split('\n').map(l => l.trim()).filter(Boolean);
const count = Number(countArg || 600);
const edits = Number(editsArg || 1);
let seed = Number(seedArg || 1);
const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const SYNTAX = ['<', '>', '"', "'", '/', '&', '=', ' ', '\n', '!', '-', '?', ']', '[', ':', ';', '#'];
const pick = list => list[rnd(list.length)];
const VALUES = {
  disabled: ['true', 'false', '1', '0', 'yes', 'True', '', ' true'],
  sortOrder: ['10', '10abc', '', ' 5', '1e2', '-3', 'x', '0x1A'],
  shared: ['true', 'false', '1', 'no', 'False', ''],
  'xsi:type': ['boolean', 'number', 'string', 'array', 'object', 'null', 'const', 'init_parameter', 'bool', 'Array', ''],
};
const TEXTS = ['true', 'false', '1', 'yes', '', '   ', ' 12 ', '1.5', '1e3', 'abc', 'TRUE', '0x1A'];

/** One well-formed edit of a value a converter reads (a generator, not a parser: plain text edits). */
function mutateValue(s) {
  const at = [];
  for (const m of s.matchAll(/\s(disabled|sortOrder|shared|xsi:type)="([^"]*)"/g)) at.push({ i: m.index, m, kind: 'attr' });
  for (const m of s.matchAll(/(<(?:argument|item)\b[^>]*>)([^<]*)(<\/(?:argument|item)>)/g)) at.push({ i: m.index, m, kind: 'text' });
  for (const m of s.matchAll(/<(plugin|observer|argument|item|type|event)\s+name="[^"]*"/g)) at.push({ i: m.index, m, kind: 'name' });
  for (const m of s.matchAll(/<argument\b[^>]*xsi:type="array"[^>]*>/g)) at.push({ i: m.index, m, kind: 'stray' });
  if (!at.length) return s;
  const { i, m, kind: k } = pick(at);
  const cut = (text) => s.slice(0, i) + text + s.slice(i + m[0].length);
  if (k === 'attr') return cut(` ${m[1]}="${pick(VALUES[m[1]])}"`);
  if (k === 'text') return cut(`${m[1]}${pick(TEXTS)}${m[3]}`);
  if (k === 'name') return cut(m[0].replace(/\s+name="[^"]*"/, ''));
  return cut(`${m[0]}!`);
}

const out = [];
for (let k = 0; k < count; k++) {
  const rel = files[rnd(files.length)];
  let s = readFileSync(path.join(root, rel), 'utf-8');
  for (let e = 0; e < edits; e++) {
    if (kind === 'values') { s = mutateValue(s); continue; }
    const at = [];
    for (let i = 0; i < s.length; i++) if (SYNTAX.includes(s[i])) at.push(i);
    if (!at.length) break;
    const i = at[rnd(at.length)];
    const c = SYNTAX[rnd(SYNTAX.length)];
    const op = rnd(3);
    s = op === 0 ? s.slice(0, i) + s.slice(i + 1) : op === 1 ? s.slice(0, i) + c + s.slice(i) : s.slice(0, i) + c + s.slice(i + 1);
  }
  const copy = path.join(outDir, String(k), path.basename(rel));
  mkdirSync(path.join(root, path.dirname(copy)), { recursive: true });
  writeFileSync(path.join(root, copy), s);
  out.push(copy);
}
console.log(out.join('\n'));
