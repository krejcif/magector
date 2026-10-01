/**
 * DI / event resolution integration tests
 *
 * Deterministic, fixture-based (tests/fixtures/di-resolution — five anonymized modules). Does NOT need
 * an index: the tools under test answer from di.xml / events.xml / routes.xml / PHP sources. Each case
 * pins one way Magento resolves configuration at runtime:
 *   - plugins inherited from interfaces and parent classes; virtual types; plugin type resolution
 *   - XML parsing: comments, self-closing <type/>, attributes on several lines
 *   - areas (webapi_rest, adminhtml), module load order, disabled modules, ambiguous order
 *   - interceptability (final class / method, static, private, missing method, NoninterceptableInterface)
 *   - virtual type chains and DI argument injections, table usage, admin routes, relative MAGENTO_ROOT
 *
 * Usage:
 *   node tests/di-resolution.test.js
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, '..', 'src', 'mcp-server.js');
const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'di-resolution');

let passed = 0;
let failed = 0;

function log(status, name, detail = '') {
  const icon = status === 'PASS' ? '✓' : '✗';
  const color = status === 'PASS' ? '\x1b[32m' : '\x1b[31m';
  console.log(`  ${color}${icon}\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  if (status === 'PASS') passed++;
  else failed++;
}

class McpClient {
  constructor({ cwd, magentoRoot, dbDir, env = {} }) {
    this.opts = { cwd, magentoRoot, dbDir, env };
    this.nextId = 1;
    this.pending = new Map();
  }

  async start() {
    this.child = spawn('node', [SERVER_PATH], {
      cwd: this.opts.cwd,
      env: {
        ...process.env,
        MAGENTO_ROOT: this.opts.magentoRoot,
        // Keep any index away from the fixture; the tools under test do not need one,
        // and without MAGECTOR_AUTO_INDEX=0 the server would start indexing the fixture.
        MAGECTOR_DB: path.join(this.opts.dbDir, 'index.db'),
        MAGECTOR_AUTO_INDEX: '0',
        ...this.opts.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', (d) => {
      if (process.env.DI_RESOLUTION_DEBUG) process.stderr.write('[mcp-stderr] ' + d);
    });
    this.rl = createInterface({ input: this.child.stdout });
    this.rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg);
      }
    });
    await this.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'di-resolution-test', version: '1.0' },
    });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }

  request(method, params, timeoutMs = 60000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); } });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async call(name, args) {
    const res = await this.request('tools/call', { name, arguments: args });
    return (res.result?.content || []).map(c => c.text || '').join('\n');
  }

  stop() {
    try { this.child.stdin.end(); } catch { /* already closed */ }
    try { this.child.kill(); } catch { /* already exited */ }
  }
}

function check(name, text, { has = [], hasNot = [] }) {
  const missing = has.filter(s => !text.includes(s));
  const unexpected = hasNot.filter(s => text.includes(s));
  if (!missing.length && !unexpected.length) {
    log('PASS', name);
  } else {
    log('FAIL', name, [
      missing.length ? `missing: ${missing.map(s => JSON.stringify(s)).join(', ')}` : '',
      unexpected.length ? `unexpected: ${unexpected.map(s => JSON.stringify(s)).join(', ')}` : '',
    ].filter(Boolean).join('; '));
    if (process.env.DI_RESOLUTION_DEBUG) console.log(text);
  }
}

async function main() {
  console.log('\nDI / event resolution (fixture: tests/fixtures/di-resolution)\n');
  const dbDir = mkdtempSync(path.join(os.tmpdir(), 'magector-di-'));
  const client = new McpClient({ cwd: FIXTURE_ROOT, magentoRoot: FIXTURE_ROOT, dbDir });
  await client.start();
  try {
    // ── Plugins ──────────────────────────────────────────────────
    let t = await client.call('magento_find_plugin', { targetClass: 'Acme\\Core\\Model\\Repo', targetMethod: 'save' });
    check('find_plugin: plugin declared on an interface applies to the implementation', t, {
      has: ['core_repo_logger', 'declared on `Acme\\Core\\Api\\RepoInterface`'],
    });
    check('find_plugin: plugin disabled by another module — effective state', t, {
      has: ['**core_disable_me** [global]: `Acme\\Core\\Plugin\\DisableMe` — **disabled** by Acme_Ext'],
    });
    check('find_plugin: declaration of a module disabled in config.php is flagged', t, {
      has: ['declaration in `Acme_Off` is ignored — module disabled'],
    });
    check('find_plugin: area of etc/webapi_rest/di.xml', t, { has: ['**rest_only** → `Acme\\Core\\Plugin\\RestOnly` [webapi_rest]'] });
    check('find_plugin: commented-out declaration is ignored', t, { hasNot: ['commented_out_plugin'] });

    t = await client.call('magento_find_plugin', { targetClass: 'Acme\\Core\\Model\\Late' });
    check('find_plugin: plugin after a self-closing <type/> is found', t, { has: ['after_self_closing_type'] });
    t = await client.call('magento_find_plugin', { targetClass: 'Acme\\Core\\Model\\Notifier' });
    check('find_plugin: … and not attributed to the self-closing type', t, { hasNot: ['after_self_closing_type'] });

    t = await client.call('magento_find_plugin', { targetClass: 'Acme\\Core\\Model\\ChildService' });
    check('find_plugin: plugin declared on a parent class applies to the child', t, {
      has: ['base_audit', 'declared on `Acme\\Core\\Model\\BaseService`'],
    });

    t = await client.call('magento_find_plugin', { targetClass: 'Acme\\Core\\Model\\SpecialRepo' });
    check('find_plugin: virtual type — base class plugins apply, own declaration does not run', t, {
      has: ['is a virtual type of `Acme\\Core\\Model\\Repo`', 'core_repo_logger', 'virtual_only_plugin', 'declared on the virtual type — does not run'],
    });

    t = await client.call('magento_find_plugin', { targetClass: 'Acme\\Core\\Model\\Audited', targetMethod: 'save' });
    check('find_plugin: plugin type resolved (virtual type / interface / preference)', t, {
      has: [
        '`Acme\\Core\\Plugin\\VirtualLogger` (virtual type of `Acme\\Core\\Plugin\\RepoLogger`)',
        'Runs: `Acme\\Core\\Plugin\\AuditPluginImpl`',
        'Runs: `Acme\\Ext\\Plugin\\OverridePlugin`',
        'app/code/Acme/Ext/Plugin/OverridePlugin.php',
      ],
    });
    // The BasePlugin preference in Acme/Ext/etc/di.xml follows an argument whose CDATA holds "<!--".
    check('di.xml: a comment opener inside CDATA does not hide the declarations after it', t, {
      has: ['Runs: `Acme\\Ext\\Plugin\\OverridePlugin`'],
    });
    // The semantic block keeps its label ("Similar plugin code (semantic, not filtered by targetClass)")
    // when it has results; without any (no index here) it is left out instead of printing an empty one.
    check('find_plugin: no empty semantic block (tokens) — only the structural sections', t, {
      hasNot: ['{"results":[],"count":0}', '### Similar plugin code'],
      has: ['### DI Plugin Registrations for'],
    });

    t = await client.call('magento_find_plugin', { targetClass: 'Acme\\Core\\Model\\Guarded' });
    check('find_plugin: non-interceptable methods are flagged', t, {
      has: [
        '`locked()` is final', '`make()` is static', '`secret()` is private',
        'no `missing()` method on the class or its parents',
      ],
      hasNot: ['afterOpen()` **[does not run'],
    });
    t = await client.call('magento_find_plugin', { targetClass: 'Acme\\Core\\Model\\FinalService' });
    check('find_plugin: final class', t, { has: ['No plugin on this class runs:** the class is final'] });
    t = await client.call('magento_find_plugin', { targetClass: 'Acme\\Core\\Model\\NoIntercept' });
    check('find_plugin: NoninterceptableInterface', t, { has: ['implements `Magento\\Framework\\ObjectManager\\NoninterceptableInterface`'] });

    // ── Virtual types / DI arguments ─────────────────────────────
    t = await client.call('magento_trace_dependency', { className: 'Acme\\Core\\Model\\Repo' });
    check('trace_dependency: virtual type chains and injections are resolved', t, {
      has: ['`Acme\\Core\\Model\\Beta` extends `Acme\\Core\\Model\\Alpha`', '`Acme\\Api\\Model\\ChainConsumer` → argument `repo` = `Acme\\Core\\Model\\Beta`'],
    });
    check('trace_dependency: no name-substring false positives, no commented XML', t, {
      hasNot: ['VirtualLogger', 'ReporterVirtual', 'OtherVirtual', 'OldRepo', 'ReportConsumer', 'commented_out_plugin'],
    });

    t = await client.call('magento_find_di_wiring', { className: 'Acme\\Core\\Model\\Repo' });
    check('find_di_wiring: virtual types and injections', t, {
      has: ['### Virtual Types', 'Acme\\Core\\Model\\Beta', '### Injected Into', 'Acme\\Api\\Model\\ChainConsumer'],
    });

    t = await client.call('magento_trace_dependency', { className: 'Repo' });
    check('trace_dependency (short name, fuzzy): commented XML still ignored', t, { hasNot: ['OldRepo', 'commented_out_plugin'] });

    // ── No index, automatic indexing off ────────────────────────────
    t = await client.call('magento_search', { query: 'repository save' });
    check('MAGECTOR_AUTO_INDEX=0: semantic search reports the missing index instead of building one', t, {
      has: ['automatic indexing is off (MAGECTOR_AUTO_INDEX=0)'],
      hasNot: ['Re-indexing in progress'],
    });

    // ── Preferences ──────────────────────────────────────────────
    t = await client.call('magento_find_preference', { interfaceName: 'Acme\\Core\\Api\\NotifierInterface' });
    check('find_preference: effective preference in module load order', t, {
      has: ['[global] → **`Acme\\Api\\Model\\Notifier`**', 'superseded: `Acme\\Ext\\Model\\Notifier`'],
    });
    check('find_preference: ambiguous order without <sequence>/composer dependency', t, {
      has: ['Ambiguous order:** `Acme_Ext` and `Acme_Api`'],
    });
    t = await client.call('magento_find_preference', { interfaceName: 'Acme\\Core\\Api\\PriceInterface' });
    check('find_preference: area override', t, {
      has: ['[global] → **`Acme\\Core\\Model\\DefaultPrice`**', '[graphql] → **`Acme\\Core\\Model\\GraphQlPrice`**'],
    });
    t = await client.call('magento_find_preference', { interfaceName: 'Acme\\Core\\Api\\ClockInterface' });
    check('find_preference: a module overrides app/etc/di.xml (primary scope is read first)', t, {
      has: ['[global] → **`Acme\\Core\\Model\\ModuleClock`**', 'superseded: `Acme\\Core\\Model\\SystemClock`'],
    });
    t = await client.call('magento_find_preference', { interfaceName: 'Acme\\Core\\Api\\LocaleInterface' });
    check('find_preference: a di.xml outside app/etc and the modules (a magento2-base copy) never wins', t, {
      has: ['[global] → **`Acme\\Core\\Model\\DefaultLocale`**'],
      hasNot: ['**`Acme\\Core\\Model\\BaseCopyLocale`**'],
    });

    t = await client.call('magento_find_implementors', { interfaceName: 'Acme\\Core\\Api\\FormatterInterface' });
    check('find_implementors: preference in any attribute order, comments ignored', t, {
      has: ['`Acme\\Core\\Api\\FormatterInterface` → `Acme\\Core\\Model\\Formatter`'],
      hasNot: ['CommentedFormatter'],
    });

    t = await client.call('magento_find_implementors', { interfaceName: 'Acme\\Core\\Api\\FormatterInterface' });
    check('find_implementors: instanceof — direct, via extending interface, via parent classes', t, {
      has: [
        '`Acme\\Core\\Model\\Formatter` (',
        '`Acme\\Core\\Api\\RichFormatterInterface` [interface]',
        '`Acme\\Core\\Model\\RichFormatter` — implements `Acme\\Core\\Api\\RichFormatterInterface`',
        '`Acme\\Core\\Model\\HtmlFormatter` — extends `Acme\\Core\\Model\\Formatter`',
        '`Acme\\Ext\\Model\\SpecialHtmlFormatter` — extends `Acme\\Core\\Model\\HtmlFormatter`',
      ],
    });
    check('find_implementors: several interfaces per class, use-alias, listed once, no same-short-name type', t, {
      has: ['`Acme\\Core\\Model\\MultiFormatter` (', '`Acme\\Core\\Model\\DiamondFormatter` ('],
      hasNot: ['FakeFormatter', 'Acme\\Ext\\Api\\FormatterInterface'],
    });
    if ((t.match(/Acme\\Core\\Model\\DiamondFormatter`/g) || []).length !== 1) {
      log('FAIL', 'find_implementors: a class reached twice is listed once');
    } else {
      log('PASS', 'find_implementors: a class reached twice is listed once');
    }
    t = await client.call('magento_find_implementors', { interfaceName: 'Acme\\Core\\Api\\NotifierInterface' });
    check('find_implementors: the same class is instanceof each of its interfaces', t, {
      has: ['`Acme\\Core\\Model\\MultiFormatter` (', '`Acme\\Core\\Model\\Notifier` (', '`Acme\\Ext\\Model\\Notifier` ('],
    });

    t = await client.call('magento_find_plugin', { targetClass: 'Acme\\Core\\Model\\MultiRepo' });
    check('find_plugin: plugins of every implemented interface (implements A,B; one use statement)', t, {
      has: ['core_repo_logger', 'declared on `Acme\\Core\\Api\\RepoInterface`', 'formatter_plugin', 'declared on `Acme\\Core\\Api\\FormatterInterface`'],
    });
    t = await client.call('magento_find_plugin', { targetClass: 'Acme\\Core\\Model\\RichFormatter' });
    check('find_plugin: plugin on an interface reached through an interface extending several', t, {
      has: ['formatter_plugin', 'declared on `Acme\\Core\\Api\\FormatterInterface`'],
    });
    t = await client.call('magento_find_plugin', { targetClass: 'Acme\\Core\\Model\\OddlyFormatted' });
    check('find_plugin: unusual but valid layout (group use + alias, split declaration, comments)', t, {
      has: ['formatter_plugin', 'declared on `Acme\\Core\\Api\\FormatterInterface`'],
      hasNot: ['NotThisOne', 'OddlyFormattedTrait', 'no `format()` method'],
    });
    t = await client.call('magento_find_implementors', { interfaceName: 'Acme\\Core\\Api\\NotifierInterface' });
    check('find_implementors: unusual layout, group use alias', t, {
      has: ['`Acme\\Core\\Model\\OddlyFormatted` ('],
    });
    t = await client.call('magento_find_implementors', { interfaceName: 'Acme\\Core\\Api\\RepoInterface' });
    check('find_implementors: implements A,B without spaces', t, {
      has: ['`Acme\\Core\\Model\\MultiRepo` ('],
    });

    t = await client.call('magento_find_implementors', { interfaceName: 'Acme\\Core\\Api\\NotifierInterface' });
    check('find_implementors: enum, block namespace, upper-case keywords, namespace alias + relative name', t, {
      has: [
        '`Acme\\Core\\Model\\Mode` [enum]', '`Acme\\Ext\\Model\\BlockNsNotifier` (',
        '`Acme\\Ext\\Model\\UpperNotifier` (', '`Acme\\Ext\\Model\\AliasNsNotifier` (',
      ],
    });
    t = await client.call('magento_find_plugin', { targetClass: 'Acme\\Core\\Model\\Guarded' });
    check('find_plugin: disabled="1" (xs:boolean) disables the plugin', t, {
      has: ['**guard_plugin** [global]: `Acme\\Core\\Plugin\\GuardPlugin` — **disabled** by Acme_Ext'],
    });

    // ── Class file lookup by FQCN (two classes named Stock in different modules) ──
    t = await client.call('magento_find_method', { methodName: 'execute', className: 'Acme\\Core\\Observer\\Stock' });
    check('find_method: class file resolved by FQCN, not by file name', t, {
      has: ['app/code/Acme/Core/Observer/Stock.php'],
      hasNot: ['app/code/Acme/Mix/Observer/Stock.php'],
    });
    t = await client.call('magento_trace_call_chain', { className: 'Acme\\Core\\Observer\\Stock', methodName: 'execute' });
    check('trace_call_chain: start class resolved by FQCN, not by file name', t, {
      has: ['app/code/Acme/Core/Observer/Stock.php'],
      hasNot: ['app/code/Acme/Mix/Observer/Stock.php'],
    });

    // Seen on a Magento 2.4.5 project: Magento runs the plugins of the class a preference substitutes
    t = await client.call('magento_find_plugin', { targetClass: 'Acme\\Core\\Model\\Importer' });
    check('find_plugin: a plugin on the class a preference substitutes for the target runs too (was: missing)', t, {
      has: ['**better_importer_plugin** → `Acme\\Ext\\Plugin\\BetterImporterPlugin` [global] (on `Acme\\Ext\\Model\\BetterImporter` — the class that runs for this type, preference)'],
    });
    check('find_plugin: … also a plugin declared for one area on that class, when the preference is global (was: missing)', t, {
      has: ['**better_importer_frontend_plugin** → `Acme\\Ext\\Plugin\\BetterImporterPlugin` [frontend] (on `Acme\\Ext\\Model\\BetterImporter` — the class that runs for this type, preference [frontend])'],
    });
    t = await client.call('magento_find_plugin', { targetClass: 'Acme\\Core\\Model\\AbstractSource' });
    check('find_plugin: an abstract class is marked — its plugins run on its concrete subclasses, not on it (was: reported as running)', t, {
      has: ['**abstract_source_plugin**', '[abstract class — does not run on it directly; runs on its concrete subclasses]'],
    });
    t = await client.call('magento_find_plugin', { targetClass: 'Acme\\Core\\Model\\TableSource' });
    check('find_plugin: … and on a concrete subclass the inherited plugin runs, unmarked', t, {
      has: ['**abstract_source_plugin** → `Acme\\Ext\\Plugin\\SourcePlugin` [global] (declared on `Acme\\Core\\Model\\AbstractSource`)'], hasNot: ['[abstract class'],
    });

    // Review of #31: dependencies come from constructor hints as written — short names imported by
    // `use` (here one aliased) — and must be qualified by the file's namespace and imports
    t = await client.call('magento_trace_call_chain', { className: 'Acme\\Core\\Model\\Checkout', methodName: 'place', depth: 3 });
    check('trace_call_chain: a dependency hinted by a `use`-imported (aliased) short name resolves', t, {
      has: ['**Acme\\Core\\Model\\Validator\\BasketValidator::validate**'],
      hasNot: ['BasketValidator::validate** [unresolved]', 'Validator::validate** [unresolved]'],
    });
    check('trace_call_chain: an interface hint follows its own preference in module order, not another module\'s interface with the same short name', t, {
      has: ['**Acme\\Core\\Model\\BasketRepository::save**', '**Acme\\Core\\Model\\BasketRepository::persist**'],
      hasNot: ['GiftBasketRepository'],
    });

    t = await client.call('magento_batch', { queries: [
      { tool: 'magento_find_method', args: { methodName: 'execute', className: 'Acme\\Core\\Observer\\Stock' } },
      { tool: 'magento_find_class', args: { className: 'Acme\\Core\\Observer\\Stock' } },
    ] });
    check('magento_batch: find_method / find_class resolve the class file by FQCN', t, {
      has: ['app/code/Acme/Core/Observer/Stock.php'],
      hasNot: ['app/code/Acme/Mix/Observer/Stock.php'],
    });

    // ── Events ───────────────────────────────────────────────────
    t = await client.call('magento_find_observer', { eventName: 'acme_order_place_before' });
    check('find_observer: same-name declarations merged — re-declared observer stays disabled', t, {
      has: ['**stock** [global]: `Acme\\Mix\\Observer\\Stock` — **disabled** by Acme_Ext', '(no instance — changes the declaration of the same name)'],
    });
    check('find_observer: observer class mapped by FQCN', t, {
      has: ['`Acme\\Core\\Observer\\Stock` → app/code/Acme/Core/Observer/Stock.php'],
    });
    t = await client.call('magento_find_observer', { eventName: 'acme_order_place_after' });
    check('find_observer: area disable and disabled module', t, {
      has: ['**audit** [adminhtml]: `Acme\\Core\\Observer\\Audit` — **disabled**', 'declaration in `Acme_Off` is ignored'],
    });
    t = await client.call('magento_find_observer', { eventName: 'acme_cart_save' });
    check('find_observer: no ambiguity warning when the order does not change the outcome', t, {
      has: ['**log** [global]: `Acme\\Core\\Observer\\Audit` — **disabled**'],
      hasNot: ['Ambiguous order'],
    });
    t = await client.call('magento_find_event_flow', { eventName: 'acme_order_place_before' });
    check('find_event_flow: dispatchers are exact dispatch() calls only', t, {
      has: ["No `dispatch('acme_order_place_before')` call found"],
      hasNot: ['### Dispatchers ('],
    });

    // ── Impact / API / table / controller / class ────────────────
    t = await client.call('magento_impact_analysis', { className: 'Acme\\Core\\Api\\RepoInterface' });
    check('impact_analysis: webapi.xml exposure and consumers', t, {
      has: ['[webapi] POST /V1/acme/repo/:id', 'DirectCaller', 'RepoResolver'],
    });
    t = await client.call('magento_find_table_usage', { tableName: 'acme_log' });
    check('find_table_usage: owning ResourceModel (_init) is found', t, {
      has: ['app/code/Acme/Api/Model/ResourceModel/Log.php', 'app/code/Acme/Api/etc/db_schema.xml'],
    });
    t = await client.call('magento_find_controller', { route: 'acme/log/index', area: 'adminhtml' });
    check('find_controller: admin route via routes.xml', t, {
      has: ['`Acme\\Api\\Controller\\Adminhtml\\Log\\Index`', 'app/code/Acme/Api/Controller/Adminhtml/Log/Index.php'],
    });
    t = await client.call('magento_find_class', { className: 'Acme\\Core\\Model\\SpecialRepoLevel2' });
    check('find_class: virtual type resolves to its class', t, {
      has: ['is a virtual type', 'Instantiates `Acme\\Core\\Model\\Repo`'],
    });
  } finally {
    client.stop();
  }

  // ── Output cap ─────────────────────────────────────────────────
  const LIMIT = 1200;
  const capped = new McpClient({ cwd: FIXTURE_ROOT, magentoRoot: FIXTURE_ROOT, dbDir, env: { MAGECTOR_MAX_OUTPUT_CHARS: String(LIMIT) } });
  await capped.start();
  try {
    const t = await capped.call('magento_find_plugin', { targetClass: 'Acme\\Core\\Model\\Repo', targetMethod: 'save' });
    check('output cap: a long answer is cut at MAGECTOR_MAX_OUTPUT_CHARS with a note', t, { has: ['**Output truncated:**'] });
    const body = t.slice(0, t.indexOf('> ✂️'));
    const fences = (body.match(/^\s*```/gm) || []).length;
    log(body.length <= LIMIT + 10 && fences % 2 === 0 ? 'PASS' : 'FAIL',
      'output cap: cut at a line boundary within the limit, code fences closed', `${body.length} chars, ${fences} fences`);
  } finally {
    capped.stop();
  }

  // ── Relative MAGENTO_ROOT ──────────────────────────────────────
  const rel = new McpClient({ cwd: path.dirname(FIXTURE_ROOT), magentoRoot: path.basename(FIXTURE_ROOT), dbDir });
  await rel.start();
  try {
    const t = await rel.call('magento_find_class', { className: 'Acme\\Core\\Model\\SpecialRepo' });
    check('relative MAGENTO_ROOT: paths stay relative to the Magento root', t, {
      has: ['`app/code/Acme/Core/Model/Repo.php`'],
    });
  } finally {
    rel.stop();
    rmSync(dbDir, { recursive: true, force: true });
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
