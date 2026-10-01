/**
 * Structural answers from webapi.xml, schema.graphqls, crontab.xml (+ config.xml), db_schema.xml and
 * module directories — `find_api`, `find_graphql`, `find_cron`, `find_db_schema`, `module_structure`.
 *
 * Why: these tools answered only from the vector index (or, for module_structure, from a guessed
 * vendor path capped at 100 files), so an answer could miss routes, resolvers, jobs, columns or files
 * that exist — and without an index they did not answer at all. Each case below names the Magento
 * behaviour it pins ("Magento: …") and what the tool did before ("was: …").
 *
 * Two layers:
 *  1. The merged models vs what Magento reads from the same fixture — tests/fixtures/config-models/
 *     magento-truth/*.json, produced by Magento's own readers (scripts/verify-magento/fixture-truth.php).
 *     Compared with scripts/verify-magento/compare.mjs, the check used on real projects.
 *  2. The MCP answers.
 *
 * Usage:
 *   node tests/config-models.test.js
 */

import { spawn, spawnSync } from 'child_process';
import { createInterface } from 'readline';
import { mkdtempSync, rmSync, cpSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { shortenEntityName, dbElementName, magentoGraphqlChunks } from '../src/magento-config.js';
import { parseConfigPhpModules } from '../src/di-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, '..', 'src', 'mcp-server.js');
const COMPARE = path.join(__dirname, '..', 'scripts', 'verify-magento', 'compare.mjs');
const FIXTURE = path.join(__dirname, 'fixtures', 'config-models');

let passed = 0;
let failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); } else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};
function check(name, text, { has = [], hasNot = [] }) {
  const missing = has.filter(s => !text.includes(s));
  const unexpected = hasNot.filter(s => text.includes(s));
  ok(name, !missing.length && !unexpected.length, [
    missing.length ? `missing: ${missing.map(s => JSON.stringify(s)).join(', ')}` : '',
    unexpected.length ? `unexpected: ${unexpected.map(s => JSON.stringify(s)).join(', ')}` : '',
  ].filter(Boolean).join('; '));
  if ((missing.length || unexpected.length) && process.env.CONFIG_MODELS_DEBUG) console.log(text);
}

class McpClient {
  constructor(root = FIXTURE, env = {}) { this.root = root; this.env = env; this.nextId = 1; this.pending = new Map(); }
  async start() {
    this.dbDir = mkdtempSync(path.join(os.tmpdir(), 'magector-cm-'));
    this.child = spawn(process.execPath, [SERVER_PATH], {
      cwd: this.root,
      env: { ...process.env, MAGENTO_ROOT: this.root, MAGECTOR_DB: path.join(this.dbDir, 'index.db'), MAGECTOR_AUTO_INDEX: '0', ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', () => {});
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id != null && this.pending.has(msg.id)) { this.pending.get(msg.id)(msg); this.pending.delete(msg.id); }
    });
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'config-models-test', version: '1.0' } });
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
  stop() { try { this.child.kill(); } catch { /* exited */ } rmSync(this.dbDir, { recursive: true, force: true }); }
}

async function main() {
  console.log('\nStructural config answers (fixture: tests/fixtures/config-models)\n');

  // ── 1. Models vs Magento's own readers on the same files ──────────
  for (const kind of ['webapi', 'graphql', 'cron', 'dbschema']) {
    const r = spawnSync(process.execPath, [COMPARE, kind, FIXTURE, path.join(FIXTURE, 'magento-truth', `${kind}.json`)], { encoding: 'utf-8' });
    ok(`${kind}: merged model = what Magento's readers return for the fixture (compare.mjs, 0 missing / different / extra)`,
      r.status === 0 && /extra \(Magector returns more\): 0/.test(r.stdout), (r.stdout + r.stderr).trim().split('\n').slice(0, 6).join(' | '));
  }

  // Values Magento computed (ResourceConnection::getIdxName / getFkName, Mage-OS 2.4.9)
  ok('db names: short index name kept (Pdo\\Mysql::getIndexName)', dbElementName('acme_note', 'index', { indexType: 'btree' }, ['store_id']) === 'ACME_NOTE_STORE_ID');
  ok('db names: > 64 chars shortened with ExpressionConverter\'s map (longest key first)',
    shortenEntityName('acme_customer_attribute_product_website_note_entity_customer_entity_id_product_attribute_id_website_id', 'idx_').toUpperCase() ===
    'ACME_CSTR_ATTR_PRD_WS_NOTE_ENTT_CSTR_ENTT_ID_PRD_ATTR_ID_WS_ID');
  ok('db names: still too long → prefix + md5', dbElementName('acme_very_long_custom_table_name_without_shortenable_words', 'constraint',
    { 'xsi:type': 'unique' }, ['first_column_xyz', 'second_column_xyz', 'third_column_xyz']) === 'UNQ_1CA9E983663E50E71215551B6DE71FD5');
  ok('db names: foreign key, long → FK_ + md5', dbElementName('acme_long_long_long_long_long_long_table', 'constraint',
    { 'xsi:type': 'foreign', column: 'long_long_long_column', referenceTable: 'another_long_long_long_table', referenceColumn: 'entity_id' }) === 'FK_29986411482D67E0DA5157B29BFE7798');
  ok('db names: foreign key shortened', dbElementName('acme_customer_product_attribute_note', 'constraint',
    { 'xsi:type': 'foreign', column: 'customer_entity_id', referenceTable: 'customer_entity', referenceColumn: 'entity_id' }) === 'ACME_CSTR_PRD_ATTR_NOTE_CSTR_ENTT_ID_CSTR_ENTT_ENTT_ID');
  ok('graphql: Magento cuts types out of the raw text — a type inside a # comment is read (GraphQlReader::parseTypes)',
    magentoGraphqlChunks('# type Ghost { a: String }\ntype Real { b: Int }').map(c => c.name).join() === 'Ghost,Real');
  ok('config.php: a module name with dots is a module (was: skipped, so the module counted as not installed)',
    parseConfigPhpModules("<?php return ['modules' => ['Amasty_Mage2.4.7Fix' => 1, 'A_B' => 0]];").map(m => `${m.name}:${m.enabled}`).join() === 'Amasty_Mage2.4.7Fix:true,A_B:false');

  // ── 2. MCP answers ───────────────────────────────────────────────
  const c = new McpClient();
  await c.start();
  try {
    let t = await c.call('magento_find_api', { query: '/V1/acme/notes' });
    check('find_api: answers without an index, from webapi.xml (was: vector search only — no index, no answer)', t, { has: ['## Web API routes matching `/V1/acme/notes`'] });
    check('find_api: Magento merges a route by (url, method); a later <service class> overrides only the class (was: two unrelated hits)', t, {
      has: ['**GET /V1/acme/notes/:id** → `Acme\\Ext\\Api\\ExtendedNoteRepositoryInterface::get`', 'also declared in `app/code/Acme/Ext/etc/webapi.xml:3` (Acme_Ext) — sets class'],
    });
    check('find_api: ACL resources of all declarations are merged (by ref)', t, { has: ['ACL: `Acme_Base::notes`, `Acme_Ext::notes_read`'] });
    check('find_api: the service interface resolves through its preference to the class that runs', t, { has: ['→ runs `Acme\\Ext\\Model\\NoteRepository` (preference, webapi_rest)'] });
    check('find_api: the url is trimmed as Magento\'s converter does', t, { has: ['**POST /V1/acme/notes** →'], hasNot: ['/V1/acme/notes '] });
    check('find_api: a commented-out route is not a route', t, { hasNot: ['/V1/acme/commented'] });
    t = await c.call('magento_find_api', { query: '/V1/acme' });
    check('find_api: the route of a module named with dots (Acme_Mage2.4Fix) is read', t, { has: ['**GET /V1/acme/fix**'] });
    check('find_api: a disabled module\'s webapi.xml is not read — and the answer says so', t, {
      has: ['_Not read — module disabled or not installed: Acme_Off'], hasNot: ['**GET /V1/acme/off**'],
    });
    t = await c.call('magento_find_api', { query: 'Acme\\Ext\\Model\\NoteRepository' });
    check('find_api: a class name finds the routes whose service resolves to it', t, { has: ['**GET /V1/acme/notes/:id**'], hasNot: ['POST /V1/acme/notes**'] });

    t = await c.call('magento_find_graphql', { query: 'acmeNotes' });
    check('find_graphql: a resolver on a multi-line @resolver( class: … ) is found (was: line-based match)', t, {
      has: ['**Query.acmeNotes** → `Acme\\Base\\Model\\Resolver\\Notes`'],
    });
    t = await c.call('magento_find_graphql', { query: 'acme', schemaType: 'query' });
    check('find_graphql: `extend type Query` in another module adds its fields to Query', t, { has: ['**Query.acmeExtNotes** → `Acme\\Ext\\Model\\Resolver\\ExtNotes`'] });
    check('find_graphql: @cache identity is shown', t, { has: ['cache: `Acme\\Base\\Model\\Resolver\\Note\\Identity`'] });
    check('find_graphql: only etc/schema.graphqls is read — not etc/graphql/*.graphqls (was: every *.graphqls)', t, { hasNot: ['acmeNotRead'] });
    check('find_graphql: a disabled module\'s schema is not read', t, { hasNot: ['acmeOff'] });
    t = await c.call('magento_find_graphql', { query: 'AcmeNote' });
    check('find_graphql: interface fields are copied into the implementing type, with the interface\'s resolver', t, {
      has: ['  - author → `Acme\\Base\\Model\\Resolver\\Author` (from AcmeNoteInterface)'],
    });
    check('find_graphql: a field the type declares replaces the interface\'s field whole — body has no resolver on AcmeNote', t, {
      hasNot: ['  - body → `Acme\\Base\\Model\\Resolver\\Body` (from AcmeNoteInterface)'],
    });
    check('find_graphql: a later declaration without @resolver keeps the earlier resolver (array_replace_recursive)', t, { has: ['  - title → `Acme\\Base\\Model\\Resolver\\Title`'] });
    t = await c.call('magento_find_graphql', { query: 'AcmeRoutable' });
    check('find_graphql: typeResolver written before `implements` is read (Magento accepts it)', t, { has: ['**AcmeRoutable** [interface] implements AcmeNoteInterface · typeResolver `Acme\\Base\\Model\\Resolver\\RoutableTypeResolver`'] });
    check('find_graphql: an interface does not get the fields of an interface it "implements"', t, { has: ['**AcmeRoutable** [interface] implements AcmeNoteInterface · typeResolver `Acme\\Base\\Model\\Resolver\\RoutableTypeResolver` · 1 fields'] });
    t = await c.call('magento_find_graphql', { query: 'AcmeNote' });
    check('find_graphql: enum values are values, not fields', t, { has: ['**AcmeNoteState** [enum] · 2 values'] });
    check('find_graphql: schema readers registered in DI besides schema.graphqls are named (their fields come from elsewhere)', t, {
      has: ['`acmeDynamicReader` → `Acme\\Base\\Model\\GraphQl\\DynamicAttributeReader`'],
    });
    t = await c.call('magento_find_graphql', { query: 'Ghost', schemaType: 'resolver' });
    check('find_graphql: a type written in a # comment is read, as Magento reads it', t, { has: ['**Commented.ghost** → `Acme\\Base\\Ghost`'] });

    // Found by an adversarial review, confirmed by Magento's readers on the fixture (Acme_Edge)
    t = await c.call('magento_find_graphql', { query: 'EdgeUsesObject' });
    check('find_graphql: fields of an object type named in `implements` are copied too (Magento\'s source check is always true; was: interfaces only)', t, {
      has: ['  - a → `Acme\\Edge\\A` (from EdgeBase)'],
    });
    t = await c.call('magento_find_graphql', { query: 'EdgeMulti' });
    check('find_graphql: with two interfaces the one defined first wins a shared field (was: the order of the implements list)', t, {
      has: ['  - x → `Acme\\Edge\\FromOne` (from EdgeIone)'], hasNot: ['FromTwo` (from'],
    });
    t = await c.call('magento_find_graphql', { query: 'EdgeRepeated' });
    check('find_graphql: the first @resolver of a field wins (FieldMetaReader; was: the last)', t, { has: ['  - rep → `Acme\\Edge\\First`'] });
    t = await c.call('magento_find_graphql', { query: 'EdgePrice' });
    check('find_graphql: a type swallowed into the chunk of a body-less `scalar` is still read (was: dropped)', t, { has: ['  - amount → `Acme\\Edge\\Price`'] });

    t = await c.call('magento_find_cron', { jobName: 'acme' });
    check('find_cron: jobs merge by group + name; a later module replaces instance and schedule (was: vector search only)', t, {
      has: ['**default/acme_notes_cleanup** → `Acme\\Ext\\Cron\\BetterCleanup::execute` · schedule `*/15 * * * *`'],
    });
    check('find_cron: a schedule read from config shows its path', t, { has: ['**default/acme_notes_export** → `Acme\\Base\\Cron\\Export::execute` · schedule from config `acme/notes/export_schedule`'] });
    check('find_cron: config.xml <default><crontab> sets the schedule of a crontab.xml job', t, { has: ['**acme_group/acme_group_job** → `Acme\\Ext\\Cron\\GroupJob::run` · schedule `5 * * * *`'] });
    check('find_cron: a job defined only in config.xml runs its run/model (Converter\\Db::_processRunModel)', t, {
      has: ['**acme_group/acme_config_only_job** → `Acme\\Ext\\Model\\Legacy::run` · schedule `0 1 * * *`'],
    });
    check('find_cron: says that admin-saved schedules (core_config_data) are not in files', t, { has: ['core_config_data'] });
    check('find_cron: config.xml job keys are taken as they are — <instance>, <method>, a text <schedule> (Converter\\Db; was: ignored)', t, {
      has: ['**default/acme_edge_job** → `Acme\\Edge\\Cron\\Job::go` · schedule `5 * * * *`'],
    });

    t = await c.call('magento_find_db_schema', { tableName: 'acme_note' });
    check('find_db_schema: columns of all modules, merged by name (was: vector search only)', t, { has: ['`rating` decimal (5,2) NULL — "Added by Acme_Ext" · Acme_Ext'] });
    check('find_db_schema: a column disabled by a later module is shown as removed', t, { has: ['~~`legacy_code`~~ disabled'] });
    check('find_db_schema: a later declaration with another xsi:type replaces the column whole — disabled and old attributes go (Config\\Dom; was: kept)', t, {
      has: ['`retyped` varchar (10) NULL · Acme_Base → Acme_Edge'], hasNot: ['~~`retyped`~~', 'int, disabled here'],
    });
    check('find_db_schema: index columns merge across modules; the name is the one Magento creates', t, {
      has: ['`ACME_NOTE_STORE_ID_CREATED_AT` [index btree] (store_id, created_at) · referenceId `ACME_NOTE_STORE`'],
    });
    check('find_db_schema: primary key is named PRIMARY; foreign key with its DB name and target', t, {
      has: ['`PRIMARY` [primary] (note_id)', '`ACME_NOTE_CUSTOMER_ID_CUSTOMER_ENTITY_ENTITY_ID` [foreign] customer_id → `customer_entity`.entity_id ON DELETE CASCADE'],
    });
    t = await c.call('magento_find_db_schema', { tableName: 'customer_entity' });
    check('find_db_schema: foreign keys pointing to the table are listed', t, { has: ['### Referenced by (1 foreign keys)', '`acme_note`.customer_id → entity_id ON DELETE CASCADE'] });
    t = await c.call('magento_find_db_schema', { tableName: 'acme_note_replica' });
    check('find_db_schema: index names of a _replica table use the origin table (TableNameResolver)', t, { has: ['`ACME_NOTE_STORE_ID` [index btree]'] });
    t = await c.call('magento_find_db_schema', { tableName: 'acme_very_long_custom_table_name_without_shortenable_words' });
    check('find_db_schema: a declared resource without its connection is flagged (Magento puts it on default)', t, { has: ['resource: `checkout` (without that connection'] });
    t = await c.call('magento_find_db_schema', { tableName: 'patch_list' });
    check('find_db_schema: app/etc/db_schema.xml is read too', t, { has: ['## Table `patch_list`', '`app/etc/db_schema.xml:3`'] });
    t = await c.call('magento_find_db_schema', { tableName: 'acme' });
    check('find_db_schema: a partial name lists the tables; a disabled module\'s table is not declared', t, { has: ['`acme_note` —', '`acme_note_replica` —'], hasNot: ['`acme_off`'] });

    // Module discovery (the fixture is a composer install: vendor/composer/autoload_files.php)
    t = await c.call('magento_find_api', { query: '/V1/acme/' });
    check('modules: a module registered by a registration.php that includes */registration.php is read (Mirakl\'s layout)', t, {
      has: ['**GET /V1/acme/multi-one**'],
    });
    check('modules: an unregistered copy of a module and a dev/tests file are not read — Magento never reads them (was: every etc/ file of the tree)', t, {
      hasNot: ['/V1/acme/unregistered', '/V1/acme/devtests'],
    });
    check('modules: a module of a composer path repository (vendor/ symlink) is read where it really is', t, {
      has: ['**GET /V1/acme/linked**', '`modules/linked/etc/webapi.xml:3`'], hasNot: ['vendor/acme/linked/etc/webapi.xml'],
    });
    t = await c.call('magento_module_structure', { moduleName: 'Acme_Linked' });
    check('module_structure: a path-repository module lists its files (was: 0 — glob does not descend into a symlinked cwd)', t, {
      has: ['## Module Acme_Linked — `modules/linked`', 'Model/Thing.php'],
    });
    t = await c.call('magento_module_structure', { moduleName: 'Acme_MultiOne' });
    check('modules: the nested module is where its registration.php is', t, { has: ['## Module Acme_MultiOne — `vendor/acme/multi/One`'] });

    // Tokens
    t = await c.call('magento_find_plugin', { targetClass: 'Acme\\Base\\Model\\NoteRepository' });
    check('find_plugin: a plugin class registered in two areas shows its code once (tokens)', t, {
      has: ['**acme_note_plugin** → `Acme\\Base\\Plugin\\NotePlugin` [graphql]', '**acme_note_plugin** → `Acme\\Base\\Plugin\\NotePlugin` [webapi_rest]', '_(code shown above)_'],
    });
    ok('find_plugin: … the body is printed exactly once', t.split('acme-note-plugin-body').length - 1 === 1, `${t.split('acme-note-plugin-body').length - 1} times`);
    check('find_plugin: no empty semantic block without an index (tokens)', t, { hasNot: ['{"results":[],"count":0}'] });
    t = await c.call('magento_batch', { queries: [{ tool: 'magento_find_plugin', args: { targetClass: 'Acme\\Base\\Model\\Busy' } }] });
    check('batch: says how many plugin registrations it left out (was: cut at 12 silently)', t, {
      has: ['- … 1 more registrations — call magento_find_plugin for all of them'],
    });

    t = await c.call('magento_module_structure', { moduleName: 'Acme_Weird' });
    check('module_structure: the module directory comes from the module index, not from its name (was: vendor path guessed from the name)', t, {
      has: ['## Module Acme_Weird — `vendor/acme/totally-different-name`'],
    });
    check('module_structure: every file is counted — no 100-file cap', t, { has: ['### Files (132)', '**Model/** (130)'] });
    t = await c.call('magento_module_structure', { moduleName: 'Acme_Ext' });
    check('module_structure: what the module declares, from the merged configuration', t, {
      has: ['Web API routes (1): GET /V1/acme/notes/:id', 'GraphQL types defined or extended (2): Query, AcmeNote', 'Cron jobs (3)', 'Tables declared or changed (1): `acme_note`'],
    });
    t = await c.call('magento_module_structure', { moduleName: 'Acme_Off' });
    check('module_structure: states a disabled module', t, { has: ['**disabled** in app/etc/config.php'] });
  } finally {
    c.stop();
  }

  // ── 3. Files changed mid-session (review of #31: session caches were never invalidated) ──
  const live = mkdtempSync(path.join(os.tmpdir(), 'magector-live-'));
  cpSync(FIXTURE, live, { recursive: true, verbatimSymlinks: true });
  const w = (rel, text) => { mkdirSync(path.dirname(path.join(live, rel)), { recursive: true }); writeFileSync(path.join(live, rel), text); };
  const lc = new McpClient(live, { MAGECTOR_FILE_LIST_TTL_MS: '0', MAGECTOR_PHP_LIST_TTL_MS: '0' });
  await lc.start();
  try {
    let t = await lc.call('magento_find_observer', { eventName: 'acme_fresh_event' });
    const before = t;
    await lc.call('magento_find_preference', { interfaceName: 'Acme\\Base\\Api\\FreshInterface' });
    await lc.call('magento_find_api', { query: '/V1/acme/late' });
    await lc.call('magento_find_event_dispatchers', { eventName: 'acme_fresh_event' });
    w('app/code/Acme/Base/etc/frontend/events.xml', '<?xml version="1.0"?>\n<config><event name="acme_fresh_event"><observer name="acme_fresh_observer" instance="Acme\\Base\\Observer\\Fresh"/></event></config>\n');
    const diPath = 'app/code/Acme/Base/etc/di.xml';
    w(diPath, readFileSync(path.join(live, diPath), 'utf-8').replace('</config>', '    <preference for="Acme\\Base\\Api\\FreshInterface" type="Acme\\Base\\Model\\Fresh"/>\n</config>'));
    w('app/code/Acme/Late/etc/module.xml', '<?xml version="1.0"?>\n<config><module name="Acme_Late"/></config>\n');
    w('app/code/Acme/Late/registration.php', "<?php\n\\Magento\\Framework\\Component\\ComponentRegistrar::register(\\Magento\\Framework\\Component\\ComponentRegistrar::MODULE, 'Acme_Late', __DIR__);\n");
    w('app/code/Acme/Late/etc/webapi.xml', '<?xml version="1.0"?>\n<routes><route url="/V1/acme/late" method="GET"><service class="Acme\\Late\\Api\\LateInterface" method="get"/><resources><resource ref="anonymous"/></resources></route></routes>\n');
    w('app/etc/config.php', readFileSync(path.join(live, 'app/etc/config.php'), 'utf-8').replace("'Acme_Off' => 0,", "'Acme_Off' => 0,\n        'Acme_Late' => 1,"));
    w('app/code/Acme/Base/Model/FreshDispatcher.php', "<?php\nnamespace Acme\\Base\\Model;\n\nclass FreshDispatcher\n{\n    public function run()\n    {\n        $this->eventManager->dispatch('acme_fresh_event', []);\n    }\n}\n");
    t = await lc.call('magento_find_observer', { eventName: 'acme_fresh_event' });
    check('fresh: an events.xml added mid-session is read (was: invisible until restart)', t, { has: ['acme_fresh_observer'] });
    ok('fresh: … and was not there before', !before.includes('acme_fresh_observer'));
    t = await lc.call('magento_find_preference', { interfaceName: 'Acme\\Base\\Api\\FreshInterface' });
    check('fresh: a preference added to an existing di.xml mid-session is read', t, { has: ['Acme\\Base\\Model\\Fresh'] });
    t = await lc.call('magento_find_api', { query: '/V1/acme/late' });
    check('fresh: a module enabled mid-session (config.php + registration) is read', t, { has: ['**GET /V1/acme/late**'] });
    t = await lc.call('magento_find_event_dispatchers', { eventName: 'acme_fresh_event' });
    check('fresh: a PHP dispatcher added mid-session is found', t, { has: ['FreshDispatcher'] });
  } finally {
    lc.stop();
    rmSync(live, { recursive: true, force: true });
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
