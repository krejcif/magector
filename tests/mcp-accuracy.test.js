/**
 * Magector MCP Accuracy Test Suite
 *
 * End-to-end accuracy tests that call each MCP tool via stdio JSON-RPC
 * against the REAL Magento 2.4.7 index and compare against deterministic
 * ground truth derived from the actual filesystem.
 *
 * Metrics per tool: Precision@K, Recall, MRR, NDCG@10, empty rate, latency.
 *
 * Usage:
 *   node tests/mcp-accuracy.test.js              # full suite
 *   node tests/mcp-accuracy.test.js --verbose    # show per-query details
 *   node tests/mcp-accuracy.test.js --json       # output JSON report
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { existsSync } from 'fs';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, '..', 'src', 'mcp-server.js');
const PROJECT_ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.MAGECTOR_DB || path.join(PROJECT_ROOT, 'magector.db');
const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');
const JSON_OUTPUT = process.argv.includes('--json');

// ─── Ground Truth ────────────────────────────────────────────────
// Derived from real Magento 2.4.7 filesystem via grep/find.

const GROUND_TRUTH = {
  // ─── magento_find_class (10 queries) ──────────────────────────
  find_class: [
    {
      tool: 'magento_find_class',
      args: { className: 'ProductRepository' },
      expect: { minResults: 1, mustContainClass: ['ProductRepository'], mustContainPathFragment: ['ProductRepository', 'Catalog'] }
    },
    {
      tool: 'magento_find_class',
      args: { className: 'AbstractModel' },
      expect: { minResults: 1, mustContainPathFragment: ['AbstractModel', 'Model'] }
    },
    {
      tool: 'magento_find_class',
      args: { className: 'CartManagement' },
      expect: { minResults: 1, mustContainPathFragment: ['Cart', 'Management', 'Quote'] }
    },
    {
      tool: 'magento_find_class',
      args: { className: 'OrderRepository' },
      expect: { minResults: 1, mustContainPathFragment: ['OrderRepository', 'Sales', 'Order'] }
    },
    {
      tool: 'magento_find_class',
      args: { className: 'CustomerRepository' },
      expect: { minResults: 1, mustContainPathFragment: ['CustomerRepository', 'Customer'] }
    },
    {
      tool: 'magento_find_class',
      args: { className: 'CategoryRepository' },
      expect: { minResults: 1, mustContainPathFragment: ['CategoryRepository', 'Catalog'] }
    },
    {
      tool: 'magento_find_class',
      args: { className: 'InvoiceRepository' },
      expect: { minResults: 1, mustContainPathFragment: ['InvoiceRepository', 'Sales'] }
    },
    {
      tool: 'magento_find_class',
      args: { className: 'StockItemRepository' },
      expect: { minResults: 1, mustContainPathFragment: ['Stock', 'Inventory', 'CatalogInventory'] }
    },
    {
      tool: 'magento_find_class',
      args: { className: 'Topmenu' },
      expect: { minResults: 1, mustContainPathFragment: ['Topmenu', 'Theme', 'Block'] }
    },
    {
      tool: 'magento_find_class',
      args: { className: 'AbstractAction', namespace: 'Controller' },
      expect: { minResults: 1, mustContainPathFragment: ['AbstractAction', 'Controller'] }
    },
  ],

  // ─── magento_find_method (8 queries) ──────────────────────────
  find_method: [
    {
      tool: 'magento_find_method',
      args: { methodName: 'getPrice' },
      expect: { minResults: 1, mustContainPathFragment: ['Price', 'getPrice', 'Item', 'Product', 'Catalog'] }
    },
    {
      tool: 'magento_find_method',
      args: { methodName: 'execute' },
      expect: { minResults: 3, mustContainPathFragment: ['Controller', 'Command', 'Observer', 'execute', 'Plugin', 'Cron', 'Action', 'Handler', 'Processor', 'Job', 'Task', 'Queue', 'Consumer', 'Operation', 'Runner'] }
    },
    {
      tool: 'magento_find_method',
      args: { methodName: 'save' },
      expect: { minResults: 1, mustContainPathFragment: ['Repository', 'Model', 'save'] }
    },
    {
      tool: 'magento_find_method',
      args: { methodName: 'getList' },
      expect: { minResults: 1, mustContainPathFragment: ['Repository', 'getList', 'List'] }
    },
    {
      tool: 'magento_find_method',
      args: { methodName: 'toHtml' },
      expect: { minResults: 1, mustContainPathFragment: ['Block', 'toHtml', 'Template', 'Widget', 'View', 'AbstractBlock'] }
    },
    {
      tool: 'magento_find_method',
      args: { methodName: 'dispatch' },
      expect: { minResults: 1, mustContainPathFragment: ['dispatch', 'Event', 'Controller', 'Action'] }
    },
    {
      tool: 'magento_find_method',
      args: { methodName: 'getById' },
      expect: { minResults: 1, mustContainPathFragment: ['Repository', 'getById', 'Get', 'Model'] }
    },
    {
      tool: 'magento_find_method',
      args: { methodName: 'beforeSave' },
      expect: { minResults: 1, mustContainPathFragment: ['Model', 'beforeSave', 'Before'] }
    },
  ],

  // ─── magento_find_controller (7 queries) ──────────────────────
  find_controller: [
    {
      tool: 'magento_find_controller',
      args: { route: 'catalog/product/view' },
      expect: { minResults: 1, mustContainPathFragment: ['Controller', 'controller', 'routes.xml', 'Action', 'execute'], pathShouldContain: ['Catalog', 'Product'] }
    },
    {
      tool: 'magento_find_controller',
      args: { route: 'checkout/cart/add' },
      expect: { minResults: 1, mustContainPathFragment: ['Controller', 'controller', 'routes.xml', 'Action', 'execute'], pathShouldContain: ['Checkout', 'Cart'] }
    },
    {
      tool: 'magento_find_controller',
      args: { route: 'customer/account/login' },
      expect: { minResults: 1, mustContainPathFragment: ['Controller', 'controller', 'routes.xml', 'Action', 'execute'], pathShouldContain: ['Customer', 'Account'] }
    },
    {
      tool: 'magento_find_controller',
      args: { route: 'catalog/category/view' },
      expect: { minResults: 1, mustContainPathFragment: ['Controller', 'controller', 'routes.xml', 'Action', 'execute'], pathShouldContain: ['Catalog', 'Category'] }
    },
    {
      tool: 'magento_find_controller',
      args: { route: 'sales/order/view' },
      expect: { minResults: 1, mustContainPathFragment: ['Controller', 'controller', 'routes.xml', 'Action', 'execute'], pathShouldContain: ['Sales', 'Order'] }
    },
    {
      tool: 'magento_find_controller',
      args: { route: 'wishlist/index/add' },
      expect: { minResults: 1, mustContainPathFragment: ['Controller', 'controller', 'routes.xml', 'Action', 'execute'], pathShouldContain: ['Wishlist'] }
    },
    {
      tool: 'magento_find_controller',
      args: { route: 'cms/page/view' },
      expect: { minResults: 1, mustContainPathFragment: ['Controller', 'controller', 'routes.xml', 'Action', 'execute'], pathShouldContain: ['Cms'] }
    },
  ],

  // ─── magento_find_observer (5 queries) ────────────────────────
  find_observer: [
    {
      tool: 'magento_find_observer',
      args: { eventName: 'sales_order_place_after' },
      expect: { minResults: 1, mustContainPathFragment: ['Observer', 'events.xml'] }
    },
    {
      tool: 'magento_find_observer',
      args: { eventName: 'checkout_cart_add_product_complete' },
      expect: { minResults: 1, mustContainPathFragment: ['Wishlist', 'Observer', 'events.xml'] }
    },
    {
      tool: 'magento_find_observer',
      args: { eventName: 'customer_login' },
      expect: { minResults: 1, mustContainPathFragment: ['Observer', 'events.xml', 'Customer'] }
    },
    {
      tool: 'magento_find_observer',
      args: { eventName: 'catalog_product_save_after' },
      expect: { minResults: 1, mustContainPathFragment: ['Observer', 'events.xml', 'Catalog'] }
    },
    {
      tool: 'magento_find_observer',
      args: { eventName: 'controller_action_predispatch' },
      expect: { minResults: 1, mustContainPathFragment: ['Observer', 'events.xml'] }
    },
  ],

  // ─── magento_find_plugin (5 queries) ──────────────────────────
  find_plugin: [
    {
      tool: 'magento_find_plugin',
      args: { targetClass: 'ProductRepository' },
      expect: { minResults: 1, mustContainPathFragment: ['Plugin', 'di.xml'] }
    },
    {
      tool: 'magento_find_plugin',
      args: { targetClass: 'CartManagement' },
      expect: { minResults: 1, mustContainPathFragment: ['Plugin', 'di.xml'] }
    },
    {
      tool: 'magento_find_plugin',
      args: { targetClass: 'Topmenu' },
      expect: { minResults: 1, mustContainPathFragment: ['Plugin', 'di.xml'] }
    },
    {
      tool: 'magento_find_plugin',
      args: { targetClass: 'CustomerRepository' },
      expect: { minResults: 1, mustContainPathFragment: ['Plugin', 'di.xml'] }
    },
    {
      tool: 'magento_find_plugin',
      args: { targetClass: 'OrderRepository', targetMethod: 'save' },
      expect: { minResults: 1, mustContainPathFragment: ['Plugin', 'di.xml', 'Sales', 'Order', 'Repository'] }
    },
  ],

  // ─── magento_find_preference (5 queries) ──────────────────────
  find_preference: [
    {
      tool: 'magento_find_preference',
      args: { interfaceName: 'ProductRepositoryInterface' },
      expect: { minResults: 1, mustContainPathFragment: ['di.xml'] }
    },
    {
      tool: 'magento_find_preference',
      args: { interfaceName: 'CustomerRepositoryInterface' },
      expect: { minResults: 1, mustContainPathFragment: ['di.xml'] }
    },
    {
      tool: 'magento_find_preference',
      args: { interfaceName: 'OrderRepositoryInterface' },
      expect: { minResults: 1, mustContainPathFragment: ['di.xml'] }
    },
    {
      tool: 'magento_find_preference',
      args: { interfaceName: 'StoreManagerInterface' },
      expect: { minResults: 1, mustContainPathFragment: ['di.xml'] }
    },
    {
      tool: 'magento_find_preference',
      args: { interfaceName: 'LoggerInterface' },
      expect: { minResults: 1, mustContainPathFragment: ['di.xml'] }
    },
  ],

  // ─── magento_find_api (5 queries) ─────────────────────────────
  find_api: [
    {
      tool: 'magento_find_api',
      args: { query: '/V1/products' },
      expect: { minResults: 1, mustContainPathFragment: ['webapi.xml'] }
    },
    {
      tool: 'magento_find_api',
      args: { query: '/V1/customers' },
      expect: { minResults: 1, mustContainPathFragment: ['webapi.xml'] }
    },
    {
      tool: 'magento_find_api',
      args: { query: '/V1/orders' },
      expect: { minResults: 1, mustContainPathFragment: ['webapi.xml'] }
    },
    {
      tool: 'magento_find_api',
      args: { query: '/V1/carts' },
      expect: { minResults: 1, mustContainPathFragment: ['webapi.xml'] }
    },
    {
      tool: 'magento_find_api',
      args: { query: '/V1/categories' },
      expect: { minResults: 1, mustContainPathFragment: ['webapi.xml'] }
    },
  ],

  // ─── magento_find_cron (5 queries) ────────────────────────────
  find_cron: [
    {
      tool: 'magento_find_cron',
      args: { jobName: 'indexer' },
      expect: { minResults: 1, mustContainPathFragment: ['crontab.xml', 'Cron'] }
    },
    {
      tool: 'magento_find_cron',
      args: { jobName: 'catalog' },
      expect: { minResults: 1, mustContainPathFragment: ['crontab.xml', 'Cron'] }
    },
    {
      tool: 'magento_find_cron',
      args: { jobName: 'sitemap' },
      expect: { minResults: 1, mustContainPathFragment: ['crontab.xml', 'Cron', 'Sitemap'] }
    },
    {
      tool: 'magento_find_cron',
      args: { jobName: 'currency' },
      expect: { minResults: 1, mustContainPathFragment: ['crontab.xml', 'Cron', 'Currency', 'Directory'] }
    },
    {
      tool: 'magento_find_cron',
      args: { jobName: 'newsletter' },
      expect: { minResults: 1, mustContainPathFragment: ['crontab.xml', 'Cron', 'Newsletter'] }
    },
  ],

  // ─── magento_find_db_schema (5 queries) ───────────────────────
  find_db_schema: [
    {
      tool: 'magento_find_db_schema',
      args: { tableName: 'catalog_product' },
      expect: { minResults: 1, mustContainPathFragment: ['db_schema.xml'] }
    },
    {
      tool: 'magento_find_db_schema',
      args: { tableName: 'sales_order' },
      expect: { minResults: 1, mustContainPathFragment: ['db_schema.xml'] }
    },
    {
      tool: 'magento_find_db_schema',
      args: { tableName: 'customer_entity' },
      expect: { minResults: 1, mustContainPathFragment: ['db_schema.xml'] }
    },
    {
      tool: 'magento_find_db_schema',
      args: { tableName: 'quote' },
      expect: { minResults: 1, mustContainPathFragment: ['db_schema.xml'] }
    },
    {
      tool: 'magento_find_db_schema',
      args: { tableName: 'cms_page' },
      expect: { minResults: 1, mustContainPathFragment: ['db_schema.xml'] }
    },
  ],

  // ─── magento_find_graphql (5 queries) ─────────────────────────
  find_graphql: [
    {
      tool: 'magento_find_graphql',
      args: { query: 'products' },
      expect: { minResults: 1, mustContainPathFragment: ['Resolver', 'graphqls'] }
    },
    {
      tool: 'magento_find_graphql',
      args: { query: 'createCustomer' },
      expect: { minResults: 1, mustContainPathFragment: ['Resolver', 'graphqls', 'Customer'] }
    },
    {
      tool: 'magento_find_graphql',
      args: { query: 'cart' },
      expect: { minResults: 1, mustContainPathFragment: ['Resolver', 'graphqls', 'Cart', 'Quote'] }
    },
    {
      tool: 'magento_find_graphql',
      args: { query: 'categoryList' },
      expect: { minResults: 1, mustContainPathFragment: ['Resolver', 'graphqls', 'Category', 'Catalog'] }
    },
    {
      tool: 'magento_find_graphql',
      args: { query: 'placeOrder' },
      expect: { minResults: 1, mustContainPathFragment: ['Resolver', 'graphqls', 'Order', 'Checkout'] }
    },
  ],

  // ─── magento_find_block (5 queries) ───────────────────────────
  find_block: [
    {
      tool: 'magento_find_block',
      args: { query: 'product view' },
      expect: { minResults: 1, mustContainPathFragment: ['Block'] }
    },
    {
      tool: 'magento_find_block',
      args: { query: 'cart totals' },
      expect: { minResults: 1, mustContainPathFragment: ['Block'] }
    },
    {
      tool: 'magento_find_block',
      args: { query: 'category listing' },
      expect: { minResults: 1, mustContainPathFragment: ['Block', 'Category', 'Catalog'] }
    },
    {
      tool: 'magento_find_block',
      args: { query: 'customer account navigation' },
      expect: { minResults: 1, mustContainPathFragment: ['Block', 'Customer', 'Account'] }
    },
    {
      tool: 'magento_find_block',
      args: { query: 'order view' },
      expect: { minResults: 1, mustContainPathFragment: ['Block', 'Sales', 'Order'] }
    },
  ],

  // ─── magento_find_config (7 queries) ──────────────────────────
  find_config: [
    {
      tool: 'magento_find_config',
      args: { query: 'preference type for', configType: 'di' },
      expect: { minResults: 1, mustContainPathFragment: ['di.xml', 'preference', 'Di'] }
    },
    {
      tool: 'magento_find_config',
      args: { query: 'routes.xml', configType: 'routes' },
      expect: { minResults: 1, mustContainPathFragment: ['routes.xml', 'routes', 'Route'] }
    },
    {
      tool: 'magento_find_config',
      args: { query: 'events.xml observer', configType: 'events' },
      expect: { minResults: 1, mustContainPathFragment: ['events.xml', 'Observer', 'event', 'Event'] }
    },
    {
      tool: 'magento_find_config',
      args: { query: 'system.xml configuration section', configType: 'system' },
      expect: { minResults: 1, mustContainPathFragment: ['system.xml', 'System'] }
    },
    {
      tool: 'magento_find_config',
      args: { query: 'webapi.xml REST endpoint', configType: 'webapi' },
      expect: { minResults: 1, mustContainPathFragment: ['webapi.xml'] }
    },
    {
      tool: 'magento_find_config',
      args: { query: 'layout xml handle', configType: 'layout' },
      expect: { minResults: 1, mustContainPathFragment: ['.xml'] }
    },
    {
      tool: 'magento_find_config',
      args: { query: 'module.xml setup_version', configType: 'module' },
      expect: { minResults: 1, mustContainPathFragment: ['module.xml', 'Module', 'module'] }
    },
  ],

  // ─── magento_find_template (5 queries) ────────────────────────
  find_template: [
    {
      tool: 'magento_find_template',
      args: { query: 'product listing' },
      expect: { minResults: 1, mustContainPathFragment: ['.phtml', 'product'] }
    },
    {
      tool: 'magento_find_template',
      args: { query: 'checkout form' },
      expect: { minResults: 1, mustContainPathFragment: ['.phtml'] }
    },
    {
      tool: 'magento_find_template',
      args: { query: 'customer account dashboard' },
      expect: { minResults: 1, mustContainPathFragment: ['.phtml', 'customer'] }
    },
    {
      tool: 'magento_find_template',
      args: { query: 'minicart' },
      expect: { minResults: 1, mustContainPathFragment: ['.phtml', 'cart', 'mini'] }
    },
    {
      tool: 'magento_find_template',
      args: { query: 'breadcrumbs navigation' },
      expect: { minResults: 1, mustContainPathFragment: ['.phtml'] }
    },
  ],

  // ─── magento_search (15 queries) ──────────────────────────────
  search: [
    {
      tool: 'magento_search',
      args: { query: 'product price calculation', limit: 10 },
      expect: { minResults: 3, mustContainPathFragment: ['Price', 'Pricing', 'Product'] }
    },
    {
      tool: 'magento_search',
      args: { query: 'customer authentication login', limit: 10 },
      expect: { minResults: 3, mustContainPathFragment: ['Customer', 'Account', 'Login', 'Auth'] }
    },
    {
      tool: 'magento_search',
      args: { query: 'shopping cart add item', limit: 10 },
      expect: { minResults: 3, mustContainPathFragment: ['Cart', 'Quote', 'Checkout', 'Item'] }
    },
    {
      tool: 'magento_search',
      args: { query: 'order placement workflow', limit: 10 },
      expect: { minResults: 3, mustContainPathFragment: ['Order', 'Sales', 'Place', 'Submit'] }
    },
    {
      tool: 'magento_search',
      args: { query: 'product image gallery', limit: 10 },
      expect: { minResults: 1, mustContainPathFragment: ['Image', 'Gallery', 'Media', 'Product'] }
    },
    {
      tool: 'magento_search',
      args: { query: 'payment method integration', limit: 10 },
      expect: { minResults: 1, mustContainPathFragment: ['Payment', 'Method'] }
    },
    {
      tool: 'magento_search',
      args: { query: 'shipping rate calculation', limit: 10 },
      expect: { minResults: 1, mustContainPathFragment: ['Shipping', 'Rate', 'Carrier'] }
    },
    {
      tool: 'magento_search',
      args: { query: 'email template transactional', limit: 10 },
      expect: { minResults: 1, mustContainPathFragment: ['Email', 'Template', 'Transport'] }
    },
    {
      tool: 'magento_search',
      args: { query: 'catalog search fulltext', limit: 10 },
      expect: { minResults: 1, mustContainPathFragment: ['Search', 'Fulltext', 'CatalogSearch'] }
    },
    {
      tool: 'magento_search',
      args: { query: 'admin user authentication', limit: 10 },
      expect: { minResults: 1, mustContainPathFragment: ['Admin', 'User', 'Auth', 'Backend'] }
    },
    {
      tool: 'magento_search',
      args: { query: 'coupon discount rule', limit: 10 },
      expect: { minResults: 1, mustContainPathFragment: ['Rule', 'Coupon', 'SalesRule'] }
    },
    {
      tool: 'magento_search',
      args: { query: 'product attribute EAV', limit: 10 },
      expect: { minResults: 1, mustContainPathFragment: ['Attribute', 'Eav', 'EAV'] }
    },
    {
      tool: 'magento_search',
      args: { query: 'URL rewrite routing', limit: 10 },
      expect: { minResults: 1, mustContainPathFragment: ['UrlRewrite', 'Rewrite', 'Url'] }
    },
    {
      tool: 'magento_search',
      args: { query: 'inventory stock source', limit: 10 },
      expect: { minResults: 1, mustContainPathFragment: ['Inventory', 'Stock', 'Source'] }
    },
    {
      tool: 'magento_search',
      args: { query: 'tax calculation rate', limit: 10 },
      expect: { minResults: 1, mustContainPathFragment: ['Tax', 'Calculation', 'Rate'] }
    },
    {
      tool: 'magento_search',
      args: { query: 'cache type management flush', limit: 10 },
      expect: { minResults: 1, mustContainPathFragment: ['Cache', 'Manager', 'Type'] }
    },
    {
      tool: 'magento_search',
      args: { query: 'import export product CSV', limit: 10 },
      expect: { minResults: 1, mustContainPathFragment: ['Import', 'Export'] }
    },
    {
      tool: 'magento_search',
      args: { query: 'ACL access control permission', limit: 10 },
      expect: { minResults: 1, mustContainPathFragment: ['Acl', 'acl.xml', 'Authorization', 'Permission', 'Role', 'Rule'] }
    },
  ],

  // ─── magento_module_structure (5 queries) ─────────────────────
  module_structure: [
    {
      tool: 'magento_module_structure',
      args: { moduleName: 'Magento_Catalog' },
      expect: { minResults: 1, mustContainPathFragment: ['Catalog'], mustContainText: ['Catalog'] }
    },
    {
      tool: 'magento_module_structure',
      args: { moduleName: 'Magento_Sales' },
      expect: { minResults: 1, mustContainPathFragment: ['Sales'], mustContainText: ['Sales'] }
    },
    {
      tool: 'magento_module_structure',
      args: { moduleName: 'Magento_Customer' },
      expect: { minResults: 1, mustContainPathFragment: ['Customer'], mustContainText: ['Customer'] }
    },
    {
      tool: 'magento_module_structure',
      args: { moduleName: 'Magento_Checkout' },
      expect: { minResults: 1, mustContainPathFragment: ['Checkout'], mustContainText: ['Checkout'] }
    },
    {
      tool: 'magento_module_structure',
      args: { moduleName: 'Magento_Cms' },
      expect: { minResults: 1, mustContainPathFragment: ['Cms'], mustContainText: ['Cms'] }
    },
  ],

  // ─── magento_stats ────────────────────────────────────────────
  stats: [
    {
      tool: 'magento_stats',
      args: {},
      expect: { minResults: 0, mustContainText: ['indexed vectors', 'dimensions'] }
    },
  ],
};

// ─── MCP Client ──────────────────────────────────────────────────

class McpTestClient {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
  }

  async start() {
    this.child = spawn('node', [SERVER_PATH], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        MAGENTO_ROOT: process.env.MAGENTO_ROOT || PROJECT_ROOT,
        MAGECTOR_DB: DB_PATH,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stderr.on('data', () => {}); // suppress

    this.rl = createInterface({ input: this.child.stdout });
    this.rl.on('line', (line) => {
      let parsed;
      try { parsed = JSON.parse(line); } catch { return; }
      const id = parsed.id;
      if (id != null && this.pending.has(id)) {
        const { resolve } = this.pending.get(id);
        this.pending.delete(id);
        resolve(parsed);
      }
    });

    await new Promise((r) => setTimeout(r, 500));
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout: ${method} (id=${id})`));
      }, 30000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
      });
      this.child.stdin.write(msg + '\n');
    });
  }

  async callTool(name, args = {}) {
    const start = Date.now();
    const resp = await this.send('tools/call', { name, arguments: args });
    const latency = Date.now() - start;
    return { result: resp.result, latency };
  }

  stop() { if (this.child) this.child.kill(); }
}

// ─── Metrics ─────────────────────────────────────────────────────

function extractResults(text) {
  // Try JSON format first (new structured output)
  try {
    const parsed = JSON.parse(text);
    if (parsed.results && Array.isArray(parsed.results)) {
      return parsed.results.map(r => ({
        path: r.path || '',
        className: r.className || '',
        methodName: r.methodName || '',
        module: r.module || '',
        score: r.score || 0,
        magentoType: r.magentoType || '',
        methods: r.methods || [],
        badges: r.badges || [],
      }));
    }
  } catch {
    // Not JSON — fall through to markdown parsing
  }

  // Fallback: parse markdown format (module_structure, stats, etc.)
  const results = [];
  const blocks = text.split(/---/).filter(b => b.includes('Result'));

  for (const block of blocks) {
    const pathMatch = block.match(/\*\*Path:\*\*\s*(.+)/);
    const classMatch = block.match(/\*\*Class:\*\*\s*(.+)/);
    const methodMatch = block.match(/\*\*Method:\*\*\s*(.+)/);
    const moduleMatch = block.match(/\*\*Module:\*\*\s*(.+)/);
    const scoreMatch = block.match(/score:\s*([\d.]+)/);
    const typeMatch = block.match(/\*\*Magento Type:\*\*\s*(.+)/);

    results.push({
      path: pathMatch?.[1]?.trim() || '',
      className: classMatch?.[1]?.trim() || '',
      methodName: methodMatch?.[1]?.trim() || '',
      module: moduleMatch?.[1]?.trim() || '',
      score: parseFloat(scoreMatch?.[1] || '0'),
      magentoType: typeMatch?.[1]?.trim() || '',
    });
  }

  return results;
}

function evaluateQuery(testCase, text, results) {
  const e = testCase.expect;
  const checks = [];

  // Check minimum result count
  if (e.minResults !== undefined) {
    const pass = results.length >= e.minResults;
    checks.push({ name: 'minResults', pass, detail: `${results.length} >= ${e.minResults}` });
  }

  // Check mustContainPath — at least one result path must contain each pattern
  if (e.mustContainPath) {
    for (const pattern of e.mustContainPath) {
      const pass = results.some(r => r.path.includes(pattern));
      checks.push({ name: `path contains "${pattern}"`, pass });
    }
  }

  // Check mustContainPathFragment — at least one result path must match ANY fragment
  if (e.mustContainPathFragment) {
    const anyMatch = results.some(r =>
      e.mustContainPathFragment.some(f => r.path.toLowerCase().includes(f.toLowerCase()))
    );
    checks.push({
      name: `path matches any of [${e.mustContainPathFragment.join(', ')}]`,
      pass: anyMatch,
    });
  }

  // Check pathShouldContain — top 3 results should contain these segments
  if (e.pathShouldContain) {
    const top3 = results.slice(0, 3);
    for (const seg of e.pathShouldContain) {
      const pass = top3.some(r => r.path.includes(seg));
      checks.push({ name: `top3 path contains "${seg}"`, pass });
    }
  }

  // Check mustContainClass
  if (e.mustContainClass) {
    for (const cls of e.mustContainClass) {
      const pass = results.some(r => r.className.includes(cls));
      checks.push({ name: `class contains "${cls}"`, pass });
    }
  }

  // Check mustContainText — for tools like stats that return prose
  if (e.mustContainText) {
    for (const t of e.mustContainText) {
      const pass = text.toLowerCase().includes(t.toLowerCase());
      checks.push({ name: `text contains "${t}"`, pass });
    }
  }

  const passed = checks.every(c => c.pass);
  const failedChecks = checks.filter(c => !c.pass);

  // Compute precision: how many results match ANY expected path fragment
  let precision = 0;
  if (e.mustContainPathFragment && results.length > 0) {
    const relevant = results.filter(r =>
      e.mustContainPathFragment.some(f => r.path.toLowerCase().includes(f.toLowerCase()))
    );
    precision = relevant.length / results.length;
  } else if (results.length > 0) {
    precision = passed ? 1 : 0;
  }

  // Compute MRR: reciprocal rank of first relevant result
  let mrr = 0;
  if (e.mustContainPathFragment) {
    for (let i = 0; i < results.length; i++) {
      if (e.mustContainPathFragment.some(f => results[i].path.toLowerCase().includes(f.toLowerCase()))) {
        mrr = 1 / (i + 1);
        break;
      }
    }
  } else if (passed) {
    mrr = 1;
  }

  // Compute NDCG@10
  let ndcg = 0;
  if (e.mustContainPathFragment) {
    const k = Math.min(results.length, 10);
    let dcg = 0;
    let relevantCount = 0;
    for (let i = 0; i < k; i++) {
      const rel = e.mustContainPathFragment.some(f =>
        results[i].path.toLowerCase().includes(f.toLowerCase())
      ) ? 1 : 0;
      if (rel) relevantCount++;
      dcg += rel / Math.log2(i + 2);
    }
    const idealCount = Math.min(relevantCount, k);
    let idcg = 0;
    for (let i = 0; i < idealCount; i++) {
      idcg += 1 / Math.log2(i + 2);
    }
    ndcg = idcg > 0 ? dcg / idcg : 0;
  }

  return { passed, checks, failedChecks, precision, mrr, ndcg };
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(DB_PATH)) {
    console.error(`ERROR: No index found at ${DB_PATH}. Run 'magector index' first.`);
    process.exit(1);
  }

  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║        MAGECTOR MCP ACCURACY TEST SUITE (E2E)               ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log(`  Database: ${DB_PATH}`);
  console.log(`  Mode: ${VERBOSE ? 'verbose' : 'summary'}\n`);

  const client = new McpTestClient();
  await client.start();

  // Initialize MCP
  await client.send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'accuracy-test', version: '1.0' },
  });

  const allResults = [];
  const toolMetrics = {};

  const categories = Object.entries(GROUND_TRUTH);
  let totalPassed = 0;
  let totalFailed = 0;
  let totalQueries = 0;

  for (const [category, testCases] of categories) {
    if (!toolMetrics[category]) {
      toolMetrics[category] = {
        queries: 0, passed: 0, failed: 0,
        totalPrecision: 0, totalMRR: 0, totalNDCG: 0,
        totalLatency: 0, emptyResults: 0,
        failures: [],
      };
    }

    const cat = toolMetrics[category];

    if (VERBOSE) console.log(`\n── ${category} ──`);

    for (const tc of testCases) {
      totalQueries++;
      cat.queries++;

      try {
        const { result, latency } = await client.callTool(tc.tool, tc.args);
        const text = result?.content?.[0]?.text || '';
        const isError = result?.isError;

        if (isError) {
          cat.failed++;
          totalFailed++;
          cat.failures.push({ args: tc.args, reason: `Tool error: ${text.slice(0, 100)}` });
          if (VERBOSE) console.log(`  \x1b[31m✗\x1b[0m ${tc.tool}(${JSON.stringify(tc.args)}) — ERROR`);
          allResults.push({ category, tool: tc.tool, args: tc.args, passed: false, reason: 'tool error', latency });
          continue;
        }

        const results = extractResults(text);
        const evaluation = evaluateQuery(tc, text, results);

        cat.totalLatency += latency;
        cat.totalPrecision += evaluation.precision;
        cat.totalMRR += evaluation.mrr;
        cat.totalNDCG += evaluation.ndcg;

        if (results.length === 0 && tc.expect.minResults > 0) {
          cat.emptyResults++;
        }

        if (evaluation.passed) {
          cat.passed++;
          totalPassed++;
          if (VERBOSE) {
            console.log(`  \x1b[32m✓\x1b[0m ${tc.tool}(${JSON.stringify(tc.args)}) — ${results.length} results, ${latency}ms, P=${evaluation.precision.toFixed(2)}, MRR=${evaluation.mrr.toFixed(2)}`);
          }
        } else {
          cat.failed++;
          totalFailed++;
          const reasons = evaluation.failedChecks.map(c => c.name).join('; ');
          cat.failures.push({ args: tc.args, reason: reasons });
          if (VERBOSE) {
            console.log(`  \x1b[31m✗\x1b[0m ${tc.tool}(${JSON.stringify(tc.args)}) — FAILED: ${reasons}`);
          }
        }

        allResults.push({
          category, tool: tc.tool, args: tc.args,
          passed: evaluation.passed,
          resultCount: results.length,
          precision: evaluation.precision,
          mrr: evaluation.mrr,
          ndcg: evaluation.ndcg,
          latency,
          failedChecks: evaluation.failedChecks.map(c => c.name),
        });

      } catch (e) {
        cat.failed++;
        totalFailed++;
        cat.failures.push({ args: tc.args, reason: e.message });
        if (VERBOSE) console.log(`  \x1b[31m✗\x1b[0m ${tc.tool}(${JSON.stringify(tc.args)}) — EXCEPTION: ${e.message}`);
        allResults.push({ category, tool: tc.tool, args: tc.args, passed: false, reason: e.message });
      }
    }
  }

  client.stop();

  // ─── Report ──────────────────────────────────────────────────

  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('                     ACCURACY REPORT');
  console.log('════════════════════════════════════════════════════════════════\n');

  // Per-tool summary table
  console.log('  Tool Category         Pass   Prec   MRR    NDCG   Latency  Empty');
  console.log('  ────────────────────  ─────  ─────  ─────  ─────  ───────  ─────');

  let globalPrecision = 0;
  let globalMRR = 0;
  let globalNDCG = 0;
  let globalLatency = 0;
  let globalEmpty = 0;

  for (const [category, m] of Object.entries(toolMetrics)) {
    const passRate = m.queries > 0 ? m.passed / m.queries : 0;
    const avgPrec = m.queries > 0 ? m.totalPrecision / m.queries : 0;
    const avgMRR = m.queries > 0 ? m.totalMRR / m.queries : 0;
    const avgNDCG = m.queries > 0 ? m.totalNDCG / m.queries : 0;
    const avgLat = m.queries > 0 ? m.totalLatency / m.queries : 0;

    globalPrecision += m.totalPrecision;
    globalMRR += m.totalMRR;
    globalNDCG += m.totalNDCG;
    globalLatency += m.totalLatency;
    globalEmpty += m.emptyResults;

    const status = passRate >= 1.0 ? '\x1b[32m✓\x1b[0m' : passRate >= 0.5 ? '\x1b[33m~\x1b[0m' : '\x1b[31m✗\x1b[0m';

    console.log(
      `  ${status} ${category.padEnd(20)} ${(passRate * 100).toFixed(0).padStart(4)}%  ` +
      `${(avgPrec * 100).toFixed(0).padStart(4)}%  ` +
      `${(avgMRR * 100).toFixed(0).padStart(4)}%  ` +
      `${(avgNDCG * 100).toFixed(0).padStart(4)}%  ` +
      `${avgLat.toFixed(0).padStart(5)}ms  ` +
      `${m.emptyResults}`
    );
  }

  console.log('  ────────────────────  ─────  ─────  ─────  ─────  ───────  ─────');

  const avgPrecision = totalQueries > 0 ? globalPrecision / totalQueries : 0;
  const avgMRR = totalQueries > 0 ? globalMRR / totalQueries : 0;
  const avgNDCG = totalQueries > 0 ? globalNDCG / totalQueries : 0;
  const avgLatency = totalQueries > 0 ? globalLatency / totalQueries : 0;
  const passRate = totalQueries > 0 ? totalPassed / totalQueries : 0;

  console.log(
    `  ${passRate >= 0.8 ? '\x1b[32m' : '\x1b[31m'}` +
    `  OVERALL              ${(passRate * 100).toFixed(0).padStart(4)}%  ` +
    `${(avgPrecision * 100).toFixed(0).padStart(4)}%  ` +
    `${(avgMRR * 100).toFixed(0).padStart(4)}%  ` +
    `${(avgNDCG * 100).toFixed(0).padStart(4)}%  ` +
    `${avgLatency.toFixed(0).padStart(5)}ms  ` +
    `${globalEmpty}\x1b[0m`
  );

  // Grade
  const score = (avgPrecision * 0.3 + (passRate) * 0.3 + avgMRR * 0.2 + avgNDCG * 0.2) * 100;
  let grade;
  if (score >= 95) grade = 'A+';
  else if (score >= 90) grade = 'A';
  else if (score >= 85) grade = 'B+';
  else if (score >= 80) grade = 'B';
  else if (score >= 75) grade = 'C+';
  else if (score >= 70) grade = 'C';
  else if (score >= 60) grade = 'D';
  else grade = 'F';

  console.log(`\n  Grade: ${grade} (${score.toFixed(1)}/100)`);
  console.log(`  Breakdown: Pass=${(passRate * 100).toFixed(1)}% Prec=${(avgPrecision * 100).toFixed(1)}% MRR=${(avgMRR * 100).toFixed(1)}% NDCG=${(avgNDCG * 100).toFixed(1)}%`);

  // Failed queries
  const allFailures = Object.entries(toolMetrics)
    .flatMap(([cat, m]) => m.failures.map(f => ({ category: cat, ...f })));

  if (allFailures.length > 0) {
    console.log(`\n── Failed Queries (${allFailures.length}) ──`);
    for (const f of allFailures.slice(0, 15)) {
      console.log(`  \x1b[31m✗\x1b[0m [${f.category}] ${JSON.stringify(f.args)}`);
      console.log(`    Reason: ${f.reason}`);
    }
    if (allFailures.length > 15) console.log(`  ... and ${allFailures.length - 15} more`);
  }

  console.log(`\n  Total: ${totalPassed} passed, ${totalFailed} failed, ${totalQueries} queries`);

  // Save JSON report
  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      totalQueries, totalPassed, totalFailed,
      passRate, avgPrecision, avgMRR, avgNDCG, avgLatency,
      grade, score: Math.round(score * 10) / 10,
      emptyResults: globalEmpty,
    },
    perTool: Object.fromEntries(
      Object.entries(toolMetrics).map(([cat, m]) => [cat, {
        queries: m.queries,
        passed: m.passed,
        failed: m.failed,
        passRate: m.queries > 0 ? m.passed / m.queries : 0,
        avgPrecision: m.queries > 0 ? m.totalPrecision / m.queries : 0,
        avgMRR: m.queries > 0 ? m.totalMRR / m.queries : 0,
        avgNDCG: m.queries > 0 ? m.totalNDCG / m.queries : 0,
        avgLatency: m.queries > 0 ? m.totalLatency / m.queries : 0,
        emptyResults: m.emptyResults,
        failures: m.failures,
      }])
    ),
    results: allResults,
  };

  await mkdir(path.join(PROJECT_ROOT, 'tests', 'results'), { recursive: true });
  const reportPath = path.join(PROJECT_ROOT, 'tests', 'results', 'accuracy-report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n  Report saved: tests/results/accuracy-report.json`);

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(report, null, 2));
  }

  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Test runner error:', e);
  process.exit(1);
});
