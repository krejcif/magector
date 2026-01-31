/**
 * Magector SONA/MicroLoRA Comprehensive Benefit Evaluation (v2 — Extended)
 *
 * ~180 eval queries across 9 categories + ~120 training queries.
 * Focuses on harder/ambiguous queries where baselines are not perfect,
 * giving SONA more room to demonstrate benefit.
 *
 * Categories:
 *   plugin (25), observer (25), class (25), controller (20),
 *   config (25), block (20), crossgen (20), ambiguous (20)
 *
 * Phases:
 *   1. Baseline — run all eval queries with fresh SONA state
 *   2. Training — 120 training sequences × 3 rounds = 360 feedback signals
 *   3. Post-training — re-run all eval queries
 *   4. Analysis — direct vs cross-gen vs ambiguous reporting
 *
 * Usage:
 *   node tests/mcp-sona-eval.test.js              # full evaluation
 *   node tests/mcp-sona-eval.test.js --verbose     # per-query details
 *   node tests/mcp-sona-eval.test.js --json        # JSON report output
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { existsSync, unlinkSync } from 'fs';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, '..', 'src', 'mcp-server.js');
const PROJECT_ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.MAGECTOR_DB || path.join(PROJECT_ROOT, 'magector.db');
const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');
const JSON_OUTPUT = process.argv.includes('--json');

// ─── Eval Queries (~180 total) ────────────────────────────────────────

const EVAL_QUERIES = [
  // ── Plugin queries (25) ──────────────────────────────────────────
  // 10 original (easy — high baseline expected)
  { id: 'eval-plugin-01', query: 'product save interceptor', expectedFragments: ['Plugin', 'di.xml', 'Product'], category: 'plugin' },
  { id: 'eval-plugin-02', query: 'cart price modification hook', expectedFragments: ['Plugin', 'di.xml', 'Cart', 'Quote', 'Price'], category: 'plugin' },
  { id: 'eval-plugin-03', query: 'customer group plugin', expectedFragments: ['Plugin', 'di.xml', 'Customer', 'Group'], category: 'plugin' },
  { id: 'eval-plugin-04', query: 'catalog product type interceptor', expectedFragments: ['Plugin', 'di.xml', 'Catalog', 'Product', 'Type'], category: 'plugin' },
  { id: 'eval-plugin-05', query: 'order management plugin override', expectedFragments: ['Plugin', 'di.xml', 'Order', 'Sales'], category: 'plugin' },
  { id: 'eval-plugin-06', query: 'shipping rate interceptor', expectedFragments: ['Plugin', 'di.xml', 'Shipping'], category: 'plugin' },
  { id: 'eval-plugin-07', query: 'payment method plugin', expectedFragments: ['Plugin', 'di.xml', 'Payment'], category: 'plugin' },
  { id: 'eval-plugin-08', query: 'wishlist item interceptor', expectedFragments: ['Plugin', 'di.xml', 'Wishlist'], category: 'plugin' },
  { id: 'eval-plugin-09', query: 'tax calculation plugin', expectedFragments: ['Plugin', 'di.xml', 'Tax'], category: 'plugin' },
  { id: 'eval-plugin-10', query: 'cms page plugin modification', expectedFragments: ['Plugin', 'di.xml', 'Cms'], category: 'plugin' },
  // 15 harder plugin queries (ambiguous phrasing, less obvious intent)
  { id: 'eval-plugin-11', query: 'modify save behavior product', expectedFragments: ['Plugin', 'di.xml', 'Product'], category: 'plugin' },
  { id: 'eval-plugin-12', query: 'intercept before place order', expectedFragments: ['Plugin', 'di.xml', 'Order', 'Sales'], category: 'plugin' },
  { id: 'eval-plugin-13', query: 'around method quote totals', expectedFragments: ['Plugin', 'di.xml', 'Quote', 'Totals'], category: 'plugin' },
  { id: 'eval-plugin-14', query: 'override customer address validation', expectedFragments: ['Plugin', 'di.xml', 'Customer', 'Address'], category: 'plugin' },
  { id: 'eval-plugin-15', query: 'hook into checkout flow', expectedFragments: ['Plugin', 'di.xml', 'Checkout'], category: 'plugin' },
  { id: 'eval-plugin-16', query: 'extend catalog search', expectedFragments: ['Plugin', 'di.xml', 'Search', 'Catalog'], category: 'plugin' },
  { id: 'eval-plugin-17', query: 'modify admin grid collection', expectedFragments: ['Plugin', 'di.xml', 'Adminhtml', 'Grid', 'Collection'], category: 'plugin' },
  { id: 'eval-plugin-18', query: 'change url generation logic', expectedFragments: ['Plugin', 'di.xml', 'Url'], category: 'plugin' },
  { id: 'eval-plugin-19', query: 'alter import product behavior', expectedFragments: ['Plugin', 'di.xml', 'Import', 'Product'], category: 'plugin' },
  { id: 'eval-plugin-20', query: 'wrap email sending method', expectedFragments: ['Plugin', 'di.xml', 'Email', 'Mail'], category: 'plugin' },
  { id: 'eval-plugin-21', query: 'customize store switcher', expectedFragments: ['Plugin', 'di.xml', 'Store'], category: 'plugin' },
  { id: 'eval-plugin-22', query: 'extend layered navigation filter', expectedFragments: ['Plugin', 'di.xml', 'Layer', 'Filter', 'Catalog'], category: 'plugin' },
  { id: 'eval-plugin-23', query: 'modify tier price logic', expectedFragments: ['Plugin', 'di.xml', 'TierPrice', 'Price', 'Catalog'], category: 'plugin' },
  { id: 'eval-plugin-24', query: 'intercept stock validation', expectedFragments: ['Plugin', 'di.xml', 'Stock', 'Inventory'], category: 'plugin' },
  { id: 'eval-plugin-25', query: 'change configurable product options', expectedFragments: ['Plugin', 'di.xml', 'Configurable', 'Product'], category: 'plugin' },

  // ── Observer queries (25) ────────────────────────────────────────
  // 10 original
  { id: 'eval-observer-01', query: 'order status change handler', expectedFragments: ['Observer', 'events.xml', 'Sales', 'Order'], category: 'observer' },
  { id: 'eval-observer-02', query: 'product save event', expectedFragments: ['Observer', 'events.xml', 'Catalog', 'Product'], category: 'observer' },
  { id: 'eval-observer-03', query: 'checkout submit listener', expectedFragments: ['Observer', 'events.xml', 'Checkout'], category: 'observer' },
  { id: 'eval-observer-04', query: 'customer login event handler', expectedFragments: ['Observer', 'events.xml', 'Customer'], category: 'observer' },
  { id: 'eval-observer-05', query: 'catalog inventory change observer', expectedFragments: ['Observer', 'events.xml', 'Inventory', 'Catalog'], category: 'observer' },
  { id: 'eval-observer-06', query: 'cart item add event listener', expectedFragments: ['Observer', 'events.xml', 'Checkout', 'Cart', 'Wishlist'], category: 'observer' },
  { id: 'eval-observer-07', query: 'admin user login observer', expectedFragments: ['Observer', 'events.xml', 'Admin', 'Backend'], category: 'observer' },
  { id: 'eval-observer-08', query: 'invoice generation event', expectedFragments: ['Observer', 'events.xml', 'Sales', 'Invoice'], category: 'observer' },
  { id: 'eval-observer-09', query: 'newsletter subscriber event', expectedFragments: ['Observer', 'events.xml', 'Newsletter'], category: 'observer' },
  { id: 'eval-observer-10', query: 'store config change handler', expectedFragments: ['Observer', 'events.xml', 'Store', 'Config'], category: 'observer' },
  // 15 harder observer queries
  { id: 'eval-observer-11', query: 'react to order cancellation', expectedFragments: ['Observer', 'events.xml', 'Sales', 'Order', 'Cancel'], category: 'observer' },
  { id: 'eval-observer-12', query: 'handle shipment creation', expectedFragments: ['Observer', 'events.xml', 'Sales', 'Shipment'], category: 'observer' },
  { id: 'eval-observer-13', query: 'listen for credit memo', expectedFragments: ['Observer', 'events.xml', 'Sales', 'Creditmemo'], category: 'observer' },
  { id: 'eval-observer-14', query: 'trigger on attribute set save', expectedFragments: ['Observer', 'events.xml', 'Attribute', 'Eav'], category: 'observer' },
  { id: 'eval-observer-15', query: 'watch category move event', expectedFragments: ['Observer', 'events.xml', 'Catalog', 'Category'], category: 'observer' },
  { id: 'eval-observer-16', query: 'respond to quote submit', expectedFragments: ['Observer', 'events.xml', 'Quote', 'Checkout'], category: 'observer' },
  { id: 'eval-observer-17', query: 'after payment capture event', expectedFragments: ['Observer', 'events.xml', 'Payment', 'Sales'], category: 'observer' },
  { id: 'eval-observer-18', query: 'product collection load handler', expectedFragments: ['Observer', 'events.xml', 'Catalog', 'Product', 'Collection'], category: 'observer' },
  { id: 'eval-observer-19', query: 'coupon apply event listener', expectedFragments: ['Observer', 'events.xml', 'SalesRule', 'Coupon'], category: 'observer' },
  { id: 'eval-observer-20', query: 'layout render event handler', expectedFragments: ['Observer', 'events.xml', 'Layout', 'Block'], category: 'observer' },
  { id: 'eval-observer-21', query: 'reindex process complete event', expectedFragments: ['Observer', 'events.xml', 'Index'], category: 'observer' },
  { id: 'eval-observer-22', query: 'customer group change listener', expectedFragments: ['Observer', 'events.xml', 'Customer', 'Group'], category: 'observer' },
  { id: 'eval-observer-23', query: 'cache flush event handler', expectedFragments: ['Observer', 'events.xml', 'Cache', 'Clean'], category: 'observer' },
  { id: 'eval-observer-24', query: 'admin session start event', expectedFragments: ['Observer', 'events.xml', 'Backend', 'Admin', 'Session'], category: 'observer' },
  { id: 'eval-observer-25', query: 'cms page save after listener', expectedFragments: ['Observer', 'events.xml', 'Cms', 'Page'], category: 'observer' },

  // ── Class queries (25) ───────────────────────────────────────────
  // 10 original
  { id: 'eval-class-01', query: 'abstract product model', expectedFragments: ['Product', 'Model', 'Abstract', 'Catalog'], category: 'class' },
  { id: 'eval-class-02', query: 'quote item management', expectedFragments: ['Quote', 'Item', 'Management', 'Model'], category: 'class' },
  { id: 'eval-class-03', query: 'category tree builder', expectedFragments: ['Category', 'Tree', 'Catalog', 'Model'], category: 'class' },
  { id: 'eval-class-04', query: 'customer address repository', expectedFragments: ['Customer', 'Address', 'Repository'], category: 'class' },
  { id: 'eval-class-05', query: 'product attribute source model', expectedFragments: ['Product', 'Attribute', 'Source', 'Catalog'], category: 'class' },
  { id: 'eval-class-06', query: 'order item collection', expectedFragments: ['Order', 'Item', 'Collection', 'Sales'], category: 'class' },
  { id: 'eval-class-07', query: 'cms block model repository', expectedFragments: ['Block', 'Model', 'Cms', 'Repository'], category: 'class' },
  { id: 'eval-class-08', query: 'url rewrite manager', expectedFragments: ['Url', 'Rewrite', 'UrlRewrite'], category: 'class' },
  { id: 'eval-class-09', query: 'stock item resource model', expectedFragments: ['Stock', 'Item', 'Resource', 'Inventory'], category: 'class' },
  { id: 'eval-class-10', query: 'store manager configuration', expectedFragments: ['Store', 'Manager', 'Config', 'Model'], category: 'class' },
  // 15 harder class queries (less specific, more ambiguous)
  { id: 'eval-class-11', query: 'product price index table', expectedFragments: ['Price', 'Index', 'Product', 'Catalog'], category: 'class' },
  { id: 'eval-class-12', query: 'eav attribute backend model', expectedFragments: ['Eav', 'Attribute', 'Backend', 'Model'], category: 'class' },
  { id: 'eval-class-13', query: 'shipping carrier model implementation', expectedFragments: ['Shipping', 'Carrier', 'Model'], category: 'class' },
  { id: 'eval-class-14', query: 'catalog rule condition class', expectedFragments: ['CatalogRule', 'Rule', 'Condition'], category: 'class' },
  { id: 'eval-class-15', query: 'sales rule discount calculator', expectedFragments: ['SalesRule', 'Rule', 'Discount', 'Utility'], category: 'class' },
  { id: 'eval-class-16', query: 'product image gallery handler', expectedFragments: ['Product', 'Image', 'Gallery', 'Catalog'], category: 'class' },
  { id: 'eval-class-17', query: 'order payment processor', expectedFragments: ['Order', 'Payment', 'Sales', 'Model'], category: 'class' },
  { id: 'eval-class-18', query: 'customer session manager class', expectedFragments: ['Customer', 'Session', 'Model'], category: 'class' },
  { id: 'eval-class-19', query: 'configurable product type model', expectedFragments: ['ConfigurableProduct', 'Configurable', 'Type', 'Model'], category: 'class' },
  { id: 'eval-class-20', query: 'grouped product link class', expectedFragments: ['GroupedProduct', 'Grouped', 'Link', 'Model'], category: 'class' },
  { id: 'eval-class-21', query: 'bundle product options handler', expectedFragments: ['Bundle', 'Option', 'Product', 'Model'], category: 'class' },
  { id: 'eval-class-22', query: 'downloadable product link model', expectedFragments: ['Downloadable', 'Link', 'Model'], category: 'class' },
  { id: 'eval-class-23', query: 'import entity abstract class', expectedFragments: ['Import', 'Entity', 'AbstractEntity'], category: 'class' },
  { id: 'eval-class-24', query: 'indexer state management class', expectedFragments: ['Indexer', 'State', 'Index'], category: 'class' },
  { id: 'eval-class-25', query: 'message queue consumer model', expectedFragments: ['Queue', 'Consumer', 'Message'], category: 'class' },

  // ── Controller queries (20) ──────────────────────────────────────
  // 8 original
  { id: 'eval-ctrl-01', query: 'admin product edit page', expectedFragments: ['Controller', 'Adminhtml', 'Product', 'Edit'], category: 'controller' },
  { id: 'eval-ctrl-02', query: 'customer account dashboard', expectedFragments: ['Controller', 'Account', 'Customer', 'Index'], category: 'controller' },
  { id: 'eval-ctrl-03', query: 'checkout cart index controller', expectedFragments: ['Controller', 'Checkout', 'Cart', 'Index'], category: 'controller' },
  { id: 'eval-ctrl-04', query: 'category page view action', expectedFragments: ['Controller', 'Category', 'Catalog', 'View'], category: 'controller' },
  { id: 'eval-ctrl-05', query: 'customer login post controller', expectedFragments: ['Controller', 'Account', 'Customer', 'LoginPost'], category: 'controller' },
  { id: 'eval-ctrl-06', query: 'order view admin action', expectedFragments: ['Controller', 'Adminhtml', 'Order', 'Sales', 'View'], category: 'controller' },
  { id: 'eval-ctrl-07', query: 'wishlist add controller action', expectedFragments: ['Controller', 'Wishlist', 'Add'], category: 'controller' },
  { id: 'eval-ctrl-08', query: 'search result page controller', expectedFragments: ['Controller', 'Result', 'Search', 'CatalogSearch'], category: 'controller' },
  // 12 harder controller queries
  { id: 'eval-ctrl-09', query: 'add product to compare list action', expectedFragments: ['Controller', 'Compare', 'Catalog', 'Product'], category: 'controller' },
  { id: 'eval-ctrl-10', query: 'admin cms block save action', expectedFragments: ['Controller', 'Adminhtml', 'Block', 'Cms', 'Save'], category: 'controller' },
  { id: 'eval-ctrl-11', query: 'customer register create account', expectedFragments: ['Controller', 'Account', 'Customer', 'Create'], category: 'controller' },
  { id: 'eval-ctrl-12', query: 'admin catalog rule apply', expectedFragments: ['Controller', 'Adminhtml', 'CatalogRule', 'Promo'], category: 'controller' },
  { id: 'eval-ctrl-13', query: 'multishipping checkout overview', expectedFragments: ['Controller', 'Multishipping', 'Checkout'], category: 'controller' },
  { id: 'eval-ctrl-14', query: 'newsletter manage subscriptions', expectedFragments: ['Controller', 'Newsletter', 'Manage'], category: 'controller' },
  { id: 'eval-ctrl-15', query: 'downloadable customer products page', expectedFragments: ['Controller', 'Downloadable', 'Customer'], category: 'controller' },
  { id: 'eval-ctrl-16', query: 'admin system config edit', expectedFragments: ['Controller', 'Adminhtml', 'System', 'Config'], category: 'controller' },
  { id: 'eval-ctrl-17', query: 'customer password reset action', expectedFragments: ['Controller', 'Account', 'Customer', 'Reset', 'Password'], category: 'controller' },
  { id: 'eval-ctrl-18', query: 'admin import run controller', expectedFragments: ['Controller', 'Adminhtml', 'Import'], category: 'controller' },
  { id: 'eval-ctrl-19', query: 'review product post action', expectedFragments: ['Controller', 'Review', 'Product', 'Post'], category: 'controller' },
  { id: 'eval-ctrl-20', query: 'admin customer group save', expectedFragments: ['Controller', 'Adminhtml', 'Customer', 'Group'], category: 'controller' },

  // ── Config queries (25) ──────────────────────────────────────────
  // 8 original (weakest category in v1 — 72.5% P@5)
  { id: 'eval-config-01', query: 'dependency injection product', expectedFragments: ['di.xml', 'Catalog', 'etc'], category: 'config' },
  { id: 'eval-config-02', query: 'event configuration catalog', expectedFragments: ['events.xml', 'Catalog', 'etc'], category: 'config' },
  { id: 'eval-config-03', query: 'sales module system settings', expectedFragments: ['system.xml', 'Sales', 'etc'], category: 'config' },
  { id: 'eval-config-04', query: 'checkout webapi routes', expectedFragments: ['webapi.xml', 'Checkout', 'etc'], category: 'config' },
  { id: 'eval-config-05', query: 'customer module di config', expectedFragments: ['di.xml', 'Customer', 'etc'], category: 'config' },
  { id: 'eval-config-06', query: 'catalog database schema', expectedFragments: ['db_schema.xml', 'Catalog', 'etc'], category: 'config' },
  { id: 'eval-config-07', query: 'cron job schedule configuration', expectedFragments: ['crontab.xml', 'etc'], category: 'config' },
  { id: 'eval-config-08', query: 'admin menu navigation config', expectedFragments: ['menu.xml', 'etc', 'adminhtml'], category: 'config' },
  // 17 new harder config queries
  { id: 'eval-config-09', query: 'acl resource definition permissions', expectedFragments: ['acl.xml', 'etc', 'adminhtml'], category: 'config' },
  { id: 'eval-config-10', query: 'widget configuration xml', expectedFragments: ['widget.xml', 'etc'], category: 'config' },
  { id: 'eval-config-11', query: 'fieldset mapping configuration', expectedFragments: ['fieldset.xml', 'etc'], category: 'config' },
  { id: 'eval-config-12', query: 'module sequence declaration', expectedFragments: ['module.xml', 'etc'], category: 'config' },
  { id: 'eval-config-13', query: 'routes configuration frontend', expectedFragments: ['routes.xml', 'etc', 'frontend'], category: 'config' },
  { id: 'eval-config-14', query: 'layout xml catalog category', expectedFragments: ['layout', 'xml', 'Catalog', 'category'], category: 'config' },
  { id: 'eval-config-15', query: 'email template configuration', expectedFragments: ['email_templates.xml', 'etc'], category: 'config' },
  { id: 'eval-config-16', query: 'indexer configuration settings', expectedFragments: ['indexer.xml', 'etc'], category: 'config' },
  { id: 'eval-config-17', query: 'mview configuration changelog', expectedFragments: ['mview.xml', 'etc'], category: 'config' },
  { id: 'eval-config-18', query: 'sales webapi rest routes', expectedFragments: ['webapi.xml', 'Sales', 'etc'], category: 'config' },
  { id: 'eval-config-19', query: 'product type configuration', expectedFragments: ['product_types.xml', 'etc', 'Catalog'], category: 'config' },
  { id: 'eval-config-20', query: 'payment method config settings', expectedFragments: ['system.xml', 'config.xml', 'Payment', 'etc'], category: 'config' },
  { id: 'eval-config-21', query: 'shipping methods config xml', expectedFragments: ['config.xml', 'system.xml', 'Shipping', 'etc'], category: 'config' },
  { id: 'eval-config-22', query: 'customer attributes eav config', expectedFragments: ['eav_attributes.xml', 'etc', 'Customer'], category: 'config' },
  { id: 'eval-config-23', query: 'cache type configuration', expectedFragments: ['cache.xml', 'etc'], category: 'config' },
  { id: 'eval-config-24', query: 'extension attributes config', expectedFragments: ['extension_attributes.xml', 'etc'], category: 'config' },
  { id: 'eval-config-25', query: 'search request configuration', expectedFragments: ['search_request.xml', 'etc', 'CatalogSearch'], category: 'config' },

  // ── Block/Template queries (20) ──────────────────────────────────
  // 8 original
  { id: 'eval-block-01', query: 'product listing layout', expectedFragments: ['Block', 'layout', 'Product', 'Catalog'], category: 'block' },
  { id: 'eval-block-02', query: 'minicart rendering block', expectedFragments: ['Block', 'Cart', 'Checkout', 'Sidebar'], category: 'block' },
  { id: 'eval-block-03', query: 'category navigation block', expectedFragments: ['Block', 'Navigation', 'Catalog', 'Category'], category: 'block' },
  { id: 'eval-block-04', query: 'product review list block', expectedFragments: ['Block', 'Review', 'Product'], category: 'block' },
  { id: 'eval-block-05', query: 'customer account navigation', expectedFragments: ['Block', 'Account', 'Customer', 'Navigation'], category: 'block' },
  { id: 'eval-block-06', query: 'checkout totals block', expectedFragments: ['Block', 'Totals', 'Checkout'], category: 'block' },
  { id: 'eval-block-07', query: 'breadcrumbs layout block', expectedFragments: ['Block', 'Breadcrumbs', 'Theme'], category: 'block' },
  { id: 'eval-block-08', query: 'product gallery images block', expectedFragments: ['Block', 'Gallery', 'Product', 'Catalog'], category: 'block' },
  // 12 harder block queries
  { id: 'eval-block-09', query: 'top menu html rendering', expectedFragments: ['Block', 'Html', 'Topmenu', 'Theme'], category: 'block' },
  { id: 'eval-block-10', query: 'product info price block', expectedFragments: ['Block', 'Product', 'Price', 'Catalog'], category: 'block' },
  { id: 'eval-block-11', query: 'order items grid admin block', expectedFragments: ['Block', 'Adminhtml', 'Order', 'Sales'], category: 'block' },
  { id: 'eval-block-12', query: 'checkout shipping method block', expectedFragments: ['Block', 'Checkout', 'Shipping'], category: 'block' },
  { id: 'eval-block-13', query: 'customer address edit form block', expectedFragments: ['Block', 'Address', 'Customer', 'Edit'], category: 'block' },
  { id: 'eval-block-14', query: 'product tab related block', expectedFragments: ['Block', 'Product', 'Related', 'Catalog'], category: 'block' },
  { id: 'eval-block-15', query: 'cms static block widget', expectedFragments: ['Block', 'Cms', 'Widget'], category: 'block' },
  { id: 'eval-block-16', query: 'product options custom block', expectedFragments: ['Block', 'Product', 'Options', 'Catalog'], category: 'block' },
  { id: 'eval-block-17', query: 'admin dashboard chart block', expectedFragments: ['Block', 'Adminhtml', 'Dashboard'], category: 'block' },
  { id: 'eval-block-18', query: 'footer links block template', expectedFragments: ['Block', 'Html', 'Footer', 'Theme'], category: 'block' },
  { id: 'eval-block-19', query: 'layered navigation filter block', expectedFragments: ['Block', 'Layer', 'Navigation', 'Catalog'], category: 'block' },
  { id: 'eval-block-20', query: 'product compare list block', expectedFragments: ['Block', 'Compare', 'Product', 'Catalog'], category: 'block' },

  // ── Cross-generalization queries (20) ────────────────────────────
  // These share terms with training set but are different exact queries
  { id: 'eval-crossgen-01', query: 'product repository plugin extension', expectedFragments: ['Plugin', 'di.xml', 'Product', 'Repository'], category: 'crossgen' },
  { id: 'eval-crossgen-02', query: 'order event observer dispatch', expectedFragments: ['Observer', 'events.xml', 'Sales', 'Order'], category: 'crossgen' },
  { id: 'eval-crossgen-03', query: 'customer model repository class', expectedFragments: ['Customer', 'Repository', 'Model'], category: 'crossgen' },
  { id: 'eval-crossgen-04', query: 'cart controller action execute', expectedFragments: ['Controller', 'Cart', 'Checkout'], category: 'crossgen' },
  { id: 'eval-crossgen-05', query: 'catalog di.xml config preferences', expectedFragments: ['di.xml', 'Catalog', 'etc'], category: 'crossgen' },
  { id: 'eval-crossgen-06', query: 'product block template rendering', expectedFragments: ['Block', 'Product', 'Catalog'], category: 'crossgen' },
  // 14 new cross-gen queries (share terms but novel combinations)
  { id: 'eval-crossgen-07', query: 'order repository implementation pattern', expectedFragments: ['Order', 'Repository', 'Sales', 'Model'], category: 'crossgen' },
  { id: 'eval-crossgen-08', query: 'checkout event configuration module', expectedFragments: ['events.xml', 'Checkout', 'etc'], category: 'crossgen' },
  { id: 'eval-crossgen-09', query: 'product collection plugin filter', expectedFragments: ['Plugin', 'di.xml', 'Product', 'Collection'], category: 'crossgen' },
  { id: 'eval-crossgen-10', query: 'category model plugin override behavior', expectedFragments: ['Plugin', 'di.xml', 'Category', 'Catalog'], category: 'crossgen' },
  { id: 'eval-crossgen-11', query: 'customer registration observer event', expectedFragments: ['Observer', 'events.xml', 'Customer'], category: 'crossgen' },
  { id: 'eval-crossgen-12', query: 'checkout cart controller add action', expectedFragments: ['Controller', 'Cart', 'Checkout', 'Add'], category: 'crossgen' },
  { id: 'eval-crossgen-13', query: 'sales module database schema table', expectedFragments: ['db_schema.xml', 'Sales', 'etc'], category: 'crossgen' },
  { id: 'eval-crossgen-14', query: 'product review block list rendering', expectedFragments: ['Block', 'Review', 'Product'], category: 'crossgen' },
  { id: 'eval-crossgen-15', query: 'catalog category tree builder class', expectedFragments: ['Category', 'Tree', 'Catalog', 'Model'], category: 'crossgen' },
  { id: 'eval-crossgen-16', query: 'cron schedule config job runner', expectedFragments: ['crontab.xml', 'etc', 'Cron'], category: 'crossgen' },
  { id: 'eval-crossgen-17', query: 'payment capture observer handler', expectedFragments: ['Observer', 'events.xml', 'Payment', 'Sales'], category: 'crossgen' },
  { id: 'eval-crossgen-18', query: 'admin controller order save action', expectedFragments: ['Controller', 'Adminhtml', 'Order', 'Sales'], category: 'crossgen' },
  { id: 'eval-crossgen-19', query: 'store group model class repository', expectedFragments: ['Store', 'Group', 'Model', 'Repository'], category: 'crossgen' },
  { id: 'eval-crossgen-20', query: 'customer session plugin interceptor', expectedFragments: ['Plugin', 'di.xml', 'Customer', 'Session'], category: 'crossgen' },

  // ── Ambiguous / Multi-intent queries (20) ────────────────────────
  // These are deliberately vague or combine multiple concepts — hardest for baseline
  { id: 'eval-ambig-01', query: 'product save handling', expectedFragments: ['Product', 'Catalog', 'Save'], category: 'ambiguous' },
  { id: 'eval-ambig-02', query: 'checkout modification', expectedFragments: ['Checkout'], category: 'ambiguous' },
  { id: 'eval-ambig-03', query: 'customer data processing', expectedFragments: ['Customer', 'Model', 'Data'], category: 'ambiguous' },
  { id: 'eval-ambig-04', query: 'order flow customization', expectedFragments: ['Order', 'Sales'], category: 'ambiguous' },
  { id: 'eval-ambig-05', query: 'payment integration extension', expectedFragments: ['Payment', 'Method'], category: 'ambiguous' },
  { id: 'eval-ambig-06', query: 'catalog search improvement', expectedFragments: ['Search', 'Catalog', 'CatalogSearch'], category: 'ambiguous' },
  { id: 'eval-ambig-07', query: 'inventory management logic', expectedFragments: ['Inventory', 'Stock'], category: 'ambiguous' },
  { id: 'eval-ambig-08', query: 'admin panel customization', expectedFragments: ['Adminhtml', 'Backend'], category: 'ambiguous' },
  { id: 'eval-ambig-09', query: 'email notification system', expectedFragments: ['Email', 'Template', 'Notification'], category: 'ambiguous' },
  { id: 'eval-ambig-10', query: 'url routing mechanism', expectedFragments: ['Url', 'Router', 'Controller'], category: 'ambiguous' },
  { id: 'eval-ambig-11', query: 'price calculation engine', expectedFragments: ['Price', 'Catalog', 'Tax'], category: 'ambiguous' },
  { id: 'eval-ambig-12', query: 'image processing pipeline', expectedFragments: ['Image', 'Product', 'Catalog'], category: 'ambiguous' },
  { id: 'eval-ambig-13', query: 'cache invalidation logic', expectedFragments: ['Cache', 'Clean', 'Type'], category: 'ambiguous' },
  { id: 'eval-ambig-14', query: 'form validation handler', expectedFragments: ['Validator', 'Form', 'Data'], category: 'ambiguous' },
  { id: 'eval-ambig-15', query: 'api endpoint definition', expectedFragments: ['webapi.xml', 'Api', 'etc'], category: 'ambiguous' },
  { id: 'eval-ambig-16', query: 'access control authorization', expectedFragments: ['Acl', 'Authorization', 'acl.xml'], category: 'ambiguous' },
  { id: 'eval-ambig-17', query: 'data migration setup', expectedFragments: ['Setup', 'Migration', 'Install', 'Upgrade'], category: 'ambiguous' },
  { id: 'eval-ambig-18', query: 'logging system handler', expectedFragments: ['Log', 'Logger', 'Psr'], category: 'ambiguous' },
  { id: 'eval-ambig-19', query: 'queue message processing', expectedFragments: ['Queue', 'Message', 'Consumer', 'Publisher'], category: 'ambiguous' },
  { id: 'eval-ambig-20', query: 'frontend asset compilation', expectedFragments: ['Asset', 'Less', 'Css', 'Deploy', 'View'], category: 'ambiguous' },
];

// ─── Training Queries (~120 — used only for training, different from eval set) ──

const TRAINING_QUERIES = [
  // Plugin-focused training (20) — search → find_plugin
  { query: 'product repository customization', tool: 'magento_find_plugin', args: { targetClass: 'ProductRepository' }, signalType: 'refinement_to_plugin' },
  { query: 'cart management interceptor', tool: 'magento_find_plugin', args: { targetClass: 'CartManagement' }, signalType: 'refinement_to_plugin' },
  { query: 'top menu navigation plugin', tool: 'magento_find_plugin', args: { targetClass: 'Topmenu' }, signalType: 'refinement_to_plugin' },
  { query: 'customer session plugin', tool: 'magento_find_plugin', args: { targetClass: 'CustomerSession' }, signalType: 'refinement_to_plugin' },
  { query: 'checkout totals plugin interceptor', tool: 'magento_find_plugin', args: { targetClass: 'TotalsCollector' }, signalType: 'refinement_to_plugin' },
  { query: 'product collection plugin modification', tool: 'magento_find_plugin', args: { targetClass: 'Collection' }, signalType: 'refinement_to_plugin' },
  { query: 'category model plugin override', tool: 'magento_find_plugin', args: { targetClass: 'Category' }, signalType: 'refinement_to_plugin' },
  { query: 'order repository plugin extension', tool: 'magento_find_plugin', args: { targetClass: 'OrderRepository' }, signalType: 'refinement_to_plugin' },
  { query: 'wishlist model interceptor behavior', tool: 'magento_find_plugin', args: { targetClass: 'Wishlist' }, signalType: 'refinement_to_plugin' },
  { query: 'tax rate calculation interceptor', tool: 'magento_find_plugin', args: { targetClass: 'TaxCalculation' }, signalType: 'refinement_to_plugin' },
  { query: 'store view interceptor change', tool: 'magento_find_plugin', args: { targetClass: 'StoreManager' }, signalType: 'refinement_to_plugin' },
  { query: 'layered navigation filter plugin', tool: 'magento_find_plugin', args: { targetClass: 'FilterList' }, signalType: 'refinement_to_plugin' },
  { query: 'product image interceptor resize', tool: 'magento_find_plugin', args: { targetClass: 'Image' }, signalType: 'refinement_to_plugin' },
  { query: 'customer address validation plugin', tool: 'magento_find_plugin', args: { targetClass: 'AddressRepository' }, signalType: 'refinement_to_plugin' },
  { query: 'url rewrite interceptor generate', tool: 'magento_find_plugin', args: { targetClass: 'UrlRewrite' }, signalType: 'refinement_to_plugin' },
  { query: 'configurable product options plugin', tool: 'magento_find_plugin', args: { targetClass: 'ConfigurableProduct' }, signalType: 'refinement_to_plugin' },
  { query: 'search query plugin modification', tool: 'magento_find_plugin', args: { targetClass: 'SearchQuery' }, signalType: 'refinement_to_plugin' },
  { query: 'stock quantity interceptor', tool: 'magento_find_plugin', args: { targetClass: 'StockItem' }, signalType: 'refinement_to_plugin' },
  { query: 'shipping method plugin carrier', tool: 'magento_find_plugin', args: { targetClass: 'Carrier' }, signalType: 'refinement_to_plugin' },
  { query: 'admin authentication plugin session', tool: 'magento_find_plugin', args: { targetClass: 'AdminSession' }, signalType: 'refinement_to_plugin' },

  // Observer-focused training (20) — search → find_observer
  { query: 'order placement event handling', tool: 'magento_find_observer', args: { eventName: 'sales_order_place_after' }, signalType: 'refinement_to_observer' },
  { query: 'cart add product event listener', tool: 'magento_find_observer', args: { eventName: 'checkout_cart_add_product_complete' }, signalType: 'refinement_to_observer' },
  { query: 'product save after event', tool: 'magento_find_observer', args: { eventName: 'catalog_product_save_after' }, signalType: 'refinement_to_observer' },
  { query: 'customer registration event', tool: 'magento_find_observer', args: { eventName: 'customer_register_success' }, signalType: 'refinement_to_observer' },
  { query: 'sales order invoice pay observer', tool: 'magento_find_observer', args: { eventName: 'sales_order_invoice_pay' }, signalType: 'refinement_to_observer' },
  { query: 'catalog category save observer', tool: 'magento_find_observer', args: { eventName: 'catalog_category_save_after' }, signalType: 'refinement_to_observer' },
  { query: 'checkout submit event listener', tool: 'magento_find_observer', args: { eventName: 'checkout_submit_all_after' }, signalType: 'refinement_to_observer' },
  { query: 'store change event observer', tool: 'magento_find_observer', args: { eventName: 'store_edit' }, signalType: 'refinement_to_observer' },
  { query: 'order cancel event handler', tool: 'magento_find_observer', args: { eventName: 'order_cancel_after' }, signalType: 'refinement_to_observer' },
  { query: 'shipment save after event', tool: 'magento_find_observer', args: { eventName: 'sales_order_shipment_save_after' }, signalType: 'refinement_to_observer' },
  { query: 'payment method assign event', tool: 'magento_find_observer', args: { eventName: 'payment_method_assign_data' }, signalType: 'refinement_to_observer' },
  { query: 'credit memo refund event', tool: 'magento_find_observer', args: { eventName: 'sales_order_creditmemo_refund' }, signalType: 'refinement_to_observer' },
  { query: 'customer login success event', tool: 'magento_find_observer', args: { eventName: 'customer_login' }, signalType: 'refinement_to_observer' },
  { query: 'attribute set save event', tool: 'magento_find_observer', args: { eventName: 'eav_entity_attribute_set_save' }, signalType: 'refinement_to_observer' },
  { query: 'product import finish event', tool: 'magento_find_observer', args: { eventName: 'catalog_product_import_finish_before' }, signalType: 'refinement_to_observer' },
  { query: 'cache clean flush event', tool: 'magento_find_observer', args: { eventName: 'clean_cache_by_tags' }, signalType: 'refinement_to_observer' },
  { query: 'coupon code apply event', tool: 'magento_find_observer', args: { eventName: 'salesrule_validator_process' }, signalType: 'refinement_to_observer' },
  { query: 'admin session login event', tool: 'magento_find_observer', args: { eventName: 'backend_auth_user_login_success' }, signalType: 'refinement_to_observer' },
  { query: 'cms page render event', tool: 'magento_find_observer', args: { eventName: 'cms_page_render' }, signalType: 'refinement_to_observer' },
  { query: 'newsletter subscription change', tool: 'magento_find_observer', args: { eventName: 'newsletter_subscriber_save_after' }, signalType: 'refinement_to_observer' },

  // Class-focused training (16) — search → find_class
  { query: 'order repository implementation', tool: 'magento_find_class', args: { className: 'OrderRepository' }, signalType: 'refinement_to_class' },
  { query: 'customer data repository', tool: 'magento_find_class', args: { className: 'CustomerRepository' }, signalType: 'refinement_to_class' },
  { query: 'category repository catalog', tool: 'magento_find_class', args: { className: 'CategoryRepository' }, signalType: 'refinement_to_class' },
  { query: 'product type abstract model', tool: 'magento_find_class', args: { className: 'AbstractType' }, signalType: 'refinement_to_class' },
  { query: 'quote address model class', tool: 'magento_find_class', args: { className: 'Address' }, signalType: 'refinement_to_class' },
  { query: 'store group model class', tool: 'magento_find_class', args: { className: 'Group' }, signalType: 'refinement_to_class' },
  { query: 'product price indexer class', tool: 'magento_find_class', args: { className: 'PriceIndexer' }, signalType: 'refinement_to_class' },
  { query: 'eav attribute model class', tool: 'magento_find_class', args: { className: 'Attribute' }, signalType: 'refinement_to_class' },
  { query: 'shipping rate request model', tool: 'magento_find_class', args: { className: 'RateRequest' }, signalType: 'refinement_to_class' },
  { query: 'catalog rule model class', tool: 'magento_find_class', args: { className: 'Rule' }, signalType: 'refinement_to_class' },
  { query: 'configurable product type class', tool: 'magento_find_class', args: { className: 'Configurable' }, signalType: 'refinement_to_class' },
  { query: 'bundle option model class', tool: 'magento_find_class', args: { className: 'Option' }, signalType: 'refinement_to_class' },
  { query: 'downloadable link model class', tool: 'magento_find_class', args: { className: 'Link' }, signalType: 'refinement_to_class' },
  { query: 'import entity model class', tool: 'magento_find_class', args: { className: 'AbstractEntity' }, signalType: 'refinement_to_class' },
  { query: 'customer session model class', tool: 'magento_find_class', args: { className: 'Session' }, signalType: 'refinement_to_class' },
  { query: 'image gallery handler class', tool: 'magento_find_class', args: { className: 'GalleryManagement' }, signalType: 'refinement_to_class' },

  // Controller-focused training (16) — search → find_controller
  { query: 'product page controller action', tool: 'magento_find_controller', args: { route: 'catalog/product/view' }, signalType: 'refinement_to_controller' },
  { query: 'add to cart controller', tool: 'magento_find_controller', args: { route: 'checkout/cart/add' }, signalType: 'refinement_to_controller' },
  { query: 'customer login controller action', tool: 'magento_find_controller', args: { route: 'customer/account/login' }, signalType: 'refinement_to_controller' },
  { query: 'admin order controller', tool: 'magento_find_controller', args: { route: 'sales/order/view' }, signalType: 'refinement_to_controller' },
  { query: 'search results controller', tool: 'magento_find_controller', args: { route: 'catalogsearch/result/index' }, signalType: 'refinement_to_controller' },
  { query: 'wishlist add item controller', tool: 'magento_find_controller', args: { route: 'wishlist/index/add' }, signalType: 'refinement_to_controller' },
  { query: 'product compare add controller', tool: 'magento_find_controller', args: { route: 'catalog/product_compare/add' }, signalType: 'refinement_to_controller' },
  { query: 'customer create account controller', tool: 'magento_find_controller', args: { route: 'customer/account/create' }, signalType: 'refinement_to_controller' },
  { query: 'admin cms block save controller', tool: 'magento_find_controller', args: { route: 'cms/block/save' }, signalType: 'refinement_to_controller' },
  { query: 'newsletter manage controller', tool: 'magento_find_controller', args: { route: 'newsletter/manage/index' }, signalType: 'refinement_to_controller' },
  { query: 'admin system config controller', tool: 'magento_find_controller', args: { route: 'adminhtml/system_config/edit' }, signalType: 'refinement_to_controller' },
  { query: 'password reset controller action', tool: 'magento_find_controller', args: { route: 'customer/account/resetpassword' }, signalType: 'refinement_to_controller' },
  { query: 'multishipping checkout controller', tool: 'magento_find_controller', args: { route: 'multishipping/checkout/overview' }, signalType: 'refinement_to_controller' },
  { query: 'review product submit controller', tool: 'magento_find_controller', args: { route: 'review/product/post' }, signalType: 'refinement_to_controller' },
  { query: 'admin import controller run', tool: 'magento_find_controller', args: { route: 'adminhtml/import/start' }, signalType: 'refinement_to_controller' },
  { query: 'downloadable customer controller', tool: 'magento_find_controller', args: { route: 'downloadable/customer/products' }, signalType: 'refinement_to_controller' },

  // Config-focused training (20) — search → find_config (heavily expanded)
  { query: 'product dependency injection configuration', tool: 'magento_find_config', args: { configType: 'di', moduleName: 'Catalog' }, signalType: 'refinement_to_config' },
  { query: 'checkout system configuration', tool: 'magento_find_config', args: { configType: 'system', moduleName: 'Checkout' }, signalType: 'refinement_to_config' },
  { query: 'sales module event config', tool: 'magento_find_config', args: { configType: 'events', moduleName: 'Sales' }, signalType: 'refinement_to_config' },
  { query: 'customer module di configuration', tool: 'magento_find_config', args: { configType: 'di', moduleName: 'Customer' }, signalType: 'refinement_to_config' },
  { query: 'catalog database schema definition', tool: 'magento_find_config', args: { configType: 'db_schema', moduleName: 'Catalog' }, signalType: 'refinement_to_config' },
  { query: 'cron schedule config module', tool: 'magento_find_config', args: { configType: 'crontab', moduleName: 'Cron' }, signalType: 'refinement_to_config' },
  { query: 'webapi routes checkout module', tool: 'magento_find_config', args: { configType: 'webapi', moduleName: 'Checkout' }, signalType: 'refinement_to_config' },
  { query: 'sales webapi rest service config', tool: 'magento_find_config', args: { configType: 'webapi', moduleName: 'Sales' }, signalType: 'refinement_to_config' },
  { query: 'admin menu config navigation', tool: 'magento_find_config', args: { configType: 'menu', moduleName: 'Backend' }, signalType: 'refinement_to_config' },
  { query: 'acl permissions resource config', tool: 'magento_find_config', args: { configType: 'acl', moduleName: 'Backend' }, signalType: 'refinement_to_config' },
  { query: 'payment system settings config', tool: 'magento_find_config', args: { configType: 'system', moduleName: 'Payment' }, signalType: 'refinement_to_config' },
  { query: 'shipping carrier config settings', tool: 'magento_find_config', args: { configType: 'config', moduleName: 'Shipping' }, signalType: 'refinement_to_config' },
  { query: 'indexer configuration definition', tool: 'magento_find_config', args: { configType: 'indexer', moduleName: 'Catalog' }, signalType: 'refinement_to_config' },
  { query: 'email template config module', tool: 'magento_find_config', args: { configType: 'email_templates', moduleName: 'Sales' }, signalType: 'refinement_to_config' },
  { query: 'widget config definition catalog', tool: 'magento_find_config', args: { configType: 'widget', moduleName: 'Catalog' }, signalType: 'refinement_to_config' },
  { query: 'extension attributes config customer', tool: 'magento_find_config', args: { configType: 'extension_attributes', moduleName: 'Customer' }, signalType: 'refinement_to_config' },
  { query: 'routes frontend config catalog', tool: 'magento_find_config', args: { configType: 'routes', moduleName: 'Catalog' }, signalType: 'refinement_to_config' },
  { query: 'product types config definition', tool: 'magento_find_config', args: { configType: 'product_types', moduleName: 'Catalog' }, signalType: 'refinement_to_config' },
  { query: 'cache type config definition', tool: 'magento_find_config', args: { configType: 'cache', moduleName: 'Framework' }, signalType: 'refinement_to_config' },
  { query: 'module sequence declaration config', tool: 'magento_find_config', args: { configType: 'module', moduleName: 'Catalog' }, signalType: 'refinement_to_config' },

  // Block-focused training (16) — search → find_block
  { query: 'product list block template', tool: 'magento_find_block', args: { blockName: 'product.list' }, signalType: 'refinement_to_block' },
  { query: 'minicart sidebar block', tool: 'magento_find_block', args: { blockName: 'minicart' }, signalType: 'refinement_to_block' },
  { query: 'category view block layout', tool: 'magento_find_block', args: { blockName: 'category.products' }, signalType: 'refinement_to_block' },
  { query: 'customer account block navigation', tool: 'magento_find_block', args: { blockName: 'customer_account_navigation' }, signalType: 'refinement_to_block' },
  { query: 'checkout cart totals block', tool: 'magento_find_block', args: { blockName: 'checkout.cart.totals' }, signalType: 'refinement_to_block' },
  { query: 'product review block list', tool: 'magento_find_block', args: { blockName: 'product.review.list' }, signalType: 'refinement_to_block' },
  { query: 'top menu block rendering', tool: 'magento_find_block', args: { blockName: 'catalog.topnav' }, signalType: 'refinement_to_block' },
  { query: 'product price block render', tool: 'magento_find_block', args: { blockName: 'product.price' }, signalType: 'refinement_to_block' },
  { query: 'footer links block layout', tool: 'magento_find_block', args: { blockName: 'footer_links' }, signalType: 'refinement_to_block' },
  { query: 'breadcrumbs block navigation', tool: 'magento_find_block', args: { blockName: 'breadcrumbs' }, signalType: 'refinement_to_block' },
  { query: 'product gallery block images', tool: 'magento_find_block', args: { blockName: 'product.info.media' }, signalType: 'refinement_to_block' },
  { query: 'product related items block', tool: 'magento_find_block', args: { blockName: 'catalog.product.related' }, signalType: 'refinement_to_block' },
  { query: 'compare products sidebar block', tool: 'magento_find_block', args: { blockName: 'catalog.compare.sidebar' }, signalType: 'refinement_to_block' },
  { query: 'product options block rendering', tool: 'magento_find_block', args: { blockName: 'product.info.options' }, signalType: 'refinement_to_block' },
  { query: 'cms widget static block', tool: 'magento_find_block', args: { blockName: 'cms_static_block' }, signalType: 'refinement_to_block' },
  { query: 'layered navigation block filter', tool: 'magento_find_block', args: { blockName: 'catalog.leftnav' }, signalType: 'refinement_to_block' },

  // Ambiguous-intent training (12) — trains SONA on mixed-type queries
  { query: 'how product save works', tool: 'magento_find_observer', args: { eventName: 'catalog_product_save_after' }, signalType: 'refinement_to_observer' },
  { query: 'modify checkout process', tool: 'magento_find_plugin', args: { targetClass: 'CheckoutManagement' }, signalType: 'refinement_to_plugin' },
  { query: 'customize order handling', tool: 'magento_find_observer', args: { eventName: 'sales_order_place_after' }, signalType: 'refinement_to_observer' },
  { query: 'extend payment processing', tool: 'magento_find_plugin', args: { targetClass: 'PaymentMethod' }, signalType: 'refinement_to_plugin' },
  { query: 'catalog search customization', tool: 'magento_find_config', args: { configType: 'di', moduleName: 'CatalogSearch' }, signalType: 'refinement_to_config' },
  { query: 'inventory management setup', tool: 'magento_find_config', args: { configType: 'di', moduleName: 'Inventory' }, signalType: 'refinement_to_config' },
  { query: 'admin interface modification', tool: 'magento_find_block', args: { blockName: 'admin.dashboard' }, signalType: 'refinement_to_block' },
  { query: 'email notification customization', tool: 'magento_find_config', args: { configType: 'email_templates', moduleName: 'Sales' }, signalType: 'refinement_to_config' },
  { query: 'url rewriting setup', tool: 'magento_find_class', args: { className: 'UrlRewrite' }, signalType: 'refinement_to_class' },
  { query: 'price calculation customization', tool: 'magento_find_plugin', args: { targetClass: 'PriceModel' }, signalType: 'refinement_to_plugin' },
  { query: 'caching strategy configuration', tool: 'magento_find_config', args: { configType: 'cache', moduleName: 'Framework' }, signalType: 'refinement_to_config' },
  { query: 'api endpoint definition setup', tool: 'magento_find_config', args: { configType: 'webapi', moduleName: 'Catalog' }, signalType: 'refinement_to_config' },
];

const TRAINING_ROUNDS = 3;

// ─── MCP Client ──────────────────────────────────────────────────

class McpTestClient {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.stderrOutput = '';
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

    this.child.stderr.on('data', (d) => {
      this.stderrOutput += d.toString();
    });

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

  stop() {
    if (this.child) this.child.kill();
  }
}

// ─── Result Parsing ──────────────────────────────────────────────

function extractResults(text) {
  try {
    const parsed = JSON.parse(text);
    const arr = Array.isArray(parsed) ? parsed : (parsed.results || []);
    if (Array.isArray(arr) && arr.length > 0) {
      return arr.map(r => ({
        path: r.path || r.file || '',
        score: r.score || r.similarity || 0,
        className: r.class_name || r.className || '',
        magentoType: r.magento_type || r.magentoType || '',
        badges: r.badges || [],
      }));
    }
  } catch {
    // Not JSON — fall through to markdown parsing
  }

  const results = [];
  const blocks = text.split(/---/).filter(b => b.includes('Result') || b.includes('path') || b.includes('Path'));

  for (const block of blocks) {
    const pathMatch = block.match(/\*\*Path:\*\*\s*(.+)/) || block.match(/"path":\s*"([^"]+)"/);
    const scoreMatch = block.match(/score:\s*([\d.]+)/) || block.match(/"score":\s*([\d.]+)/);
    const classMatch = block.match(/\*\*Class:\*\*\s*(.+)/);
    const typeMatch = block.match(/\*\*Magento Type:\*\*\s*(.+)/);

    if (pathMatch) {
      results.push({
        path: pathMatch[1]?.trim() || '',
        score: parseFloat(scoreMatch?.[1] || '0'),
        className: classMatch?.[1]?.trim() || '',
        magentoType: typeMatch?.[1]?.trim() || '',
      });
    }
  }

  return results;
}

// ─── Metrics ─────────────────────────────────────────────────────

function computeMetrics(results, expectedFragments) {
  const top5 = results.slice(0, 5);
  const relevantCount = top5.filter(r =>
    expectedFragments.some(f => r.path.toLowerCase().includes(f.toLowerCase()))
  ).length;
  const precision5 = top5.length > 0 ? relevantCount / top5.length : 0;

  let mrr = 0;
  for (let i = 0; i < results.length; i++) {
    if (expectedFragments.some(f => results[i].path.toLowerCase().includes(f.toLowerCase()))) {
      mrr = 1 / (i + 1);
      break;
    }
  }

  const k = Math.min(results.length, 10);
  let dcg = 0;
  let relevantTotal = 0;
  for (let i = 0; i < k; i++) {
    const rel = expectedFragments.some(f =>
      results[i].path.toLowerCase().includes(f.toLowerCase())
    ) ? 1 : 0;
    if (rel) relevantTotal++;
    dcg += rel / Math.log2(i + 2);
  }
  const idealCount = Math.min(relevantTotal, k);
  let idcg = 0;
  for (let i = 0; i < idealCount; i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  const ndcg = idcg > 0 ? dcg / idcg : 0;

  const relevantScores = results.filter(r =>
    expectedFragments.some(f => r.path.toLowerCase().includes(f.toLowerCase()))
  ).map(r => r.score);
  const topRelevantScore = relevantScores.length > 0 ? Math.max(...relevantScores) : 0;

  let firstRelevantRank = 0;
  for (let i = 0; i < results.length; i++) {
    if (expectedFragments.some(f => results[i].path.toLowerCase().includes(f.toLowerCase()))) {
      firstRelevantRank = i + 1;
      break;
    }
  }

  return { precision5, mrr, ndcg, topRelevantScore, firstRelevantRank, resultCount: results.length };
}

// ─── Helpers ─────────────────────────────────────────────────────

async function runSearchPhase(client, queries, label) {
  const results = {};
  for (const q of queries) {
    try {
      const { result, latency } = await client.callTool('magento_search', { query: q.query, limit: 10 });
      const text = result?.content?.[0]?.text || '';
      const searchResults = extractResults(text);
      const metrics = computeMetrics(searchResults, q.expectedFragments);
      metrics.latency = latency;
      results[q.id] = metrics;

      if (VERBOSE) {
        console.log(`  ${q.id}: ${searchResults.length} results, P@5=${metrics.precision5.toFixed(2)}, MRR=${metrics.mrr.toFixed(2)}, rank=${metrics.firstRelevantRank}, ${latency}ms`);
      }
    } catch (e) {
      console.log(`  \x1b[31m✗\x1b[0m ${q.id}: ${e.message}`);
      results[q.id] = { precision5: 0, mrr: 0, ndcg: 0, topRelevantScore: 0, firstRelevantRank: 0, resultCount: 0, latency: 0 };
    }
  }
  return results;
}

function computeSummary(evalQueries, baseline, postTraining) {
  let totalP5Before = 0, totalP5After = 0;
  let totalMRRBefore = 0, totalMRRAfter = 0;
  let totalNDCGBefore = 0, totalNDCGAfter = 0;
  let totalScoreBefore = 0, totalScoreAfter = 0;
  let rankImproved = 0, rankSame = 0, rankWorsened = 0;
  let p5Improved = 0, mrrImproved = 0, scoreImproved = 0;
  let queryCount = 0;
  const perQuery = [];
  const perCategory = {};

  for (const q of evalQueries) {
    const b = baseline[q.id];
    const a = postTraining[q.id];
    if (!b || !a) continue;
    queryCount++;

    totalP5Before += b.precision5;
    totalP5After += a.precision5;
    totalMRRBefore += b.mrr;
    totalMRRAfter += a.mrr;
    totalNDCGBefore += b.ndcg;
    totalNDCGAfter += a.ndcg;
    totalScoreBefore += b.topRelevantScore;
    totalScoreAfter += a.topRelevantScore;

    if (a.firstRelevantRank > 0 && b.firstRelevantRank > 0 && a.firstRelevantRank < b.firstRelevantRank) rankImproved++;
    else if (a.firstRelevantRank === b.firstRelevantRank) rankSame++;
    else rankWorsened++;

    if (a.precision5 > b.precision5) p5Improved++;
    if (a.mrr > b.mrr) mrrImproved++;
    if (a.topRelevantScore > b.topRelevantScore) scoreImproved++;

    if (!perCategory[q.category]) {
      perCategory[q.category] = { count: 0, p5Before: 0, p5After: 0, mrrBefore: 0, mrrAfter: 0, ndcgBefore: 0, ndcgAfter: 0 };
    }
    const cat = perCategory[q.category];
    cat.count++;
    cat.p5Before += b.precision5;
    cat.p5After += a.precision5;
    cat.mrrBefore += b.mrr;
    cat.mrrAfter += a.mrr;
    cat.ndcgBefore += b.ndcg;
    cat.ndcgAfter += a.ndcg;

    const p5Delta = a.precision5 - b.precision5;
    const mrrDelta = a.mrr - b.mrr;
    const rankDelta = b.firstRelevantRank > 0 && a.firstRelevantRank > 0
      ? b.firstRelevantRank - a.firstRelevantRank
      : 0;
    const scoreDelta = a.topRelevantScore - b.topRelevantScore;

    perQuery.push({
      id: q.id,
      category: q.category,
      query: q.query,
      baseline: b,
      postTraining: a,
      delta: { precision5: p5Delta, mrr: mrrDelta, ndcg: a.ndcg - b.ndcg, rank: rankDelta, score: scoreDelta },
    });
  }

  return {
    queryCount,
    totalP5Before, totalP5After,
    totalMRRBefore, totalMRRAfter,
    totalNDCGBefore, totalNDCGAfter,
    totalScoreBefore, totalScoreAfter,
    rankImproved, rankSame, rankWorsened,
    p5Improved, mrrImproved, scoreImproved,
    perQuery, perCategory,
  };
}

function printSummary(label, summary) {
  const { queryCount, perQuery, perCategory } = summary;
  if (queryCount === 0) return;

  const avgP5Before = summary.totalP5Before / queryCount;
  const avgP5After = summary.totalP5After / queryCount;
  const avgMRRBefore = summary.totalMRRBefore / queryCount;
  const avgMRRAfter = summary.totalMRRAfter / queryCount;
  const avgNDCGBefore = summary.totalNDCGBefore / queryCount;
  const avgNDCGAfter = summary.totalNDCGAfter / queryCount;

  if (VERBOSE) {
    console.log(`\n  ── ${label}: Per-Query ──\n`);
    console.log('  Query                     P@5 (B→A)   MRR (B→A)   Rank (B→A)  Score (B→A)');
    console.log('  ─────────────────────────  ──────────  ──────────  ──────────  ───────────');

    for (const pq of perQuery) {
      const b = pq.baseline;
      const a = pq.postTraining;
      const p5Color = pq.delta.precision5 > 0 ? '\x1b[32m' : pq.delta.precision5 < 0 ? '\x1b[31m' : '';
      const mrrColor = pq.delta.mrr > 0 ? '\x1b[32m' : pq.delta.mrr < 0 ? '\x1b[31m' : '';
      const rankColor = pq.delta.rank > 0 ? '\x1b[32m' : pq.delta.rank < 0 ? '\x1b[31m' : '';
      const scoreColor = pq.delta.score > 0 ? '\x1b[32m' : pq.delta.score < 0 ? '\x1b[31m' : '';
      const rst = '\x1b[0m';

      console.log(
        `  ${pq.id.padEnd(27)} ${p5Color}${b.precision5.toFixed(2)}→${a.precision5.toFixed(2)}${rst}`.padEnd(50) +
        ` ${mrrColor}${b.mrr.toFixed(2)}→${a.mrr.toFixed(2)}${rst}`.padEnd(22) +
        ` ${rankColor}${b.firstRelevantRank}→${a.firstRelevantRank}${rst}`.padEnd(22) +
        ` ${scoreColor}${b.topRelevantScore.toFixed(3)}→${a.topRelevantScore.toFixed(3)}${rst}`
      );
    }
  }

  console.log(`\n  ── ${label}: Per-Category ──\n`);
  console.log('  Category       Queries   P@5 (B→A)       MRR (B→A)       NDCG (B→A)');
  console.log('  ─────────────  ───────   ─────────────   ─────────────   ─────────────');

  for (const [cat, m] of Object.entries(perCategory)) {
    const p5b = (m.p5Before / m.count * 100).toFixed(1);
    const p5a = (m.p5After / m.count * 100).toFixed(1);
    const mrrb = (m.mrrBefore / m.count * 100).toFixed(1);
    const mrra = (m.mrrAfter / m.count * 100).toFixed(1);
    const ndcgb = (m.ndcgBefore / m.count * 100).toFixed(1);
    const ndcga = (m.ndcgAfter / m.count * 100).toFixed(1);

    const p5Arrow = parseFloat(p5a) > parseFloat(p5b) ? '\x1b[32m' : parseFloat(p5a) < parseFloat(p5b) ? '\x1b[31m' : '';
    const mrrArrow = parseFloat(mrra) > parseFloat(mrrb) ? '\x1b[32m' : parseFloat(mrra) < parseFloat(mrrb) ? '\x1b[31m' : '';
    const ndcgArrow = parseFloat(ndcga) > parseFloat(ndcgb) ? '\x1b[32m' : parseFloat(ndcga) < parseFloat(ndcgb) ? '\x1b[31m' : '';
    const rst = '\x1b[0m';

    console.log(
      `  ${cat.padEnd(15)} ${String(m.count).padStart(4)}     ` +
      `${p5Arrow}${p5b.padStart(5)}%→${p5a.padStart(5)}%${rst}   ` +
      `${mrrArrow}${mrrb.padStart(5)}%→${mrra.padStart(5)}%${rst}   ` +
      `${ndcgArrow}${ndcgb.padStart(5)}%→${ndcga.padStart(5)}%${rst}`
    );
  }

  console.log(`\n  ── ${label}: Overall ──\n`);
  console.log(`  Precision@5:    ${(avgP5Before * 100).toFixed(1)}% → ${(avgP5After * 100).toFixed(1)}%  (${avgP5After >= avgP5Before ? '+' : ''}${((avgP5After - avgP5Before) * 100).toFixed(1)}pp)`);
  console.log(`  MRR:            ${(avgMRRBefore * 100).toFixed(1)}% → ${(avgMRRAfter * 100).toFixed(1)}%  (${avgMRRAfter >= avgMRRBefore ? '+' : ''}${((avgMRRAfter - avgMRRBefore) * 100).toFixed(1)}pp)`);
  console.log(`  NDCG@10:        ${(avgNDCGBefore * 100).toFixed(1)}% → ${(avgNDCGAfter * 100).toFixed(1)}%  (${avgNDCGAfter >= avgNDCGBefore ? '+' : ''}${((avgNDCGAfter - avgNDCGBefore) * 100).toFixed(1)}pp)`);
  console.log(`  Rank:           improved=${summary.rankImproved}  same=${summary.rankSame}  worsened=${summary.rankWorsened}`);
  console.log(`  P@5 improved:   ${summary.p5Improved}/${queryCount} queries`);
  console.log(`  Score improved: ${summary.scoreImproved}/${queryCount} queries`);
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(DB_PATH)) {
    console.error(`ERROR: No index found at ${DB_PATH}. Run 'magector index' first.`);
    process.exit(1);
  }

  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║   MAGECTOR SONA/MicroLoRA COMPREHENSIVE EVALUATION (v2)     ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log(`  Database: ${DB_PATH}`);
  console.log(`  Eval queries: ${EVAL_QUERIES.length}`);
  console.log(`  Training queries: ${TRAINING_QUERIES.length}`);
  console.log(`  Training rounds: ${TRAINING_ROUNDS}`);
  console.log(`  Total training signals: ${TRAINING_QUERIES.length * TRAINING_ROUNDS}`);
  console.log(`  Mode: ${VERBOSE ? 'verbose' : 'summary'}\n`);

  // Delete existing .sona file to start with a clean slate
  const sonaPath = DB_PATH.replace(/\.db$/, '.sona');
  if (existsSync(sonaPath)) {
    unlinkSync(sonaPath);
    console.log(`  Cleared existing SONA state: ${sonaPath}`);
  }

  // ─── Phase 1: Baseline ─────────────────────────────────────────

  console.log('\n═══ PHASE 1: BASELINE (no SONA patterns learned) ═════════════\n');

  const client1 = new McpTestClient();
  await client1.start();
  await client1.send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'sona-eval-baseline', version: '3.0' },
  });

  const baseline = await runSearchPhase(client1, EVAL_QUERIES, 'baseline');

  client1.stop();
  await new Promise(r => setTimeout(r, 500));

  // ─── Phase 2: Training ──────────────────────────────────────────

  console.log('\n═══ PHASE 2: SONA TRAINING ═══════════════════════════════════\n');

  const client2 = new McpTestClient();
  await client2.start();
  await client2.send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'sona-eval-training', version: '3.0' },
  });

  let trainedSignals = 0;

  for (let round = 1; round <= TRAINING_ROUNDS; round++) {
    if (VERBOSE) console.log(`  ── Training round ${round}/${TRAINING_ROUNDS} ──`);

    for (const tq of TRAINING_QUERIES) {
      try {
        await client2.callTool('magento_search', { query: tq.query, limit: 5 });
        await client2.callTool(tq.tool, tq.args);
        trainedSignals++;

        if (VERBOSE && round === 1) {
          console.log(`    ${tq.query.substring(0, 40).padEnd(42)} → ${tq.tool}`);
        }
      } catch (e) {
        if (VERBOSE) console.log(`    \x1b[31m✗\x1b[0m ${tq.query}: ${e.message}`);
      }
    }

    await new Promise(r => setTimeout(r, 800));
  }

  console.log(`  Trained ${trainedSignals} feedback signals across ${TRAINING_ROUNDS} rounds`);

  await new Promise(r => setTimeout(r, 1000));
  client2.stop();
  await new Promise(r => setTimeout(r, 500));

  // ─── Phase 3: Post-training evaluation ──────────────────────────

  console.log('\n═══ PHASE 3: POST-TRAINING EVALUATION ═══════════════════════\n');

  const client3 = new McpTestClient();
  await client3.start();
  await client3.send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'sona-eval-post', version: '3.0' },
  });

  const postTraining = await runSearchPhase(client3, EVAL_QUERIES, 'post-training');

  client3.stop();

  // ─── Phase 4: Analysis ──────────────────────────────────────────

  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('                   SONA BENEFIT REPORT (v2)');
  console.log('════════════════════════════════════════════════════════════════');

  // Split eval queries by type
  const directQueries = EVAL_QUERIES.filter(q => q.category !== 'crossgen' && q.category !== 'ambiguous');
  const crossGenQueries = EVAL_QUERIES.filter(q => q.category === 'crossgen');
  const ambiguousQueries = EVAL_QUERIES.filter(q => q.category === 'ambiguous');

  const directSummary = computeSummary(directQueries, baseline, postTraining);
  const crossGenSummary = computeSummary(crossGenQueries, baseline, postTraining);
  const ambiguousSummary = computeSummary(ambiguousQueries, baseline, postTraining);
  const overallSummary = computeSummary(EVAL_QUERIES, baseline, postTraining);

  printSummary('Direct Queries (trained categories)', directSummary);
  printSummary('Cross-Generalization (shared terms, different queries)', crossGenSummary);
  printSummary('Ambiguous / Multi-Intent (hardest)', ambiguousSummary);

  // ── Weakness analysis ──────────────────────────────────────────

  console.log('\n  ── Weakness Analysis ──\n');

  // Find worst baseline queries
  const sortedByBaseline = [...overallSummary.perQuery].sort((a, b) => a.baseline.precision5 - b.baseline.precision5);
  const worstBaseline = sortedByBaseline.slice(0, 10);
  console.log('  Bottom 10 baseline P@5 queries:');
  for (const q of worstBaseline) {
    const delta = q.delta.precision5;
    const arrow = delta > 0 ? '\x1b[32m+' : delta < 0 ? '\x1b[31m' : ' ';
    console.log(`    ${q.id.padEnd(25)} P@5=${q.baseline.precision5.toFixed(2)} → ${q.postTraining.precision5.toFixed(2)} (${arrow}${(delta * 100).toFixed(1)}pp\x1b[0m)  "${q.query}"`);
  }

  // Find queries with biggest improvement
  const sortedByImprovement = [...overallSummary.perQuery].sort((a, b) => b.delta.precision5 - a.delta.precision5);
  const topImproved = sortedByImprovement.filter(q => q.delta.precision5 > 0).slice(0, 10);
  if (topImproved.length > 0) {
    console.log('\n  Top P@5 improvements:');
    for (const q of topImproved) {
      console.log(`    ${q.id.padEnd(25)} P@5=${q.baseline.precision5.toFixed(2)} → ${q.postTraining.precision5.toFixed(2)} (\x1b[32m+${(q.delta.precision5 * 100).toFixed(1)}pp\x1b[0m)  "${q.query}"`);
    }
  }

  // Find regressions
  const regressions = overallSummary.perQuery.filter(q => q.delta.precision5 < 0 || q.delta.mrr < 0 || q.delta.rank < 0);
  if (regressions.length > 0) {
    console.log('\n  Regressions (any metric):');
    for (const q of regressions) {
      const parts = [];
      if (q.delta.precision5 < 0) parts.push(`P@5 ${(q.delta.precision5 * 100).toFixed(1)}pp`);
      if (q.delta.mrr < 0) parts.push(`MRR ${(q.delta.mrr * 100).toFixed(1)}pp`);
      if (q.delta.rank < 0) parts.push(`rank ${q.delta.rank}`);
      console.log(`    ${q.id.padEnd(25)} \x1b[31m${parts.join(', ')}\x1b[0m  "${q.query}"`);
    }
  } else {
    console.log('\n  No regressions detected.');
  }

  // ── Verdict ─────────────────────────────────────────────────────

  const directImproved = directSummary.rankImproved + directSummary.p5Improved + directSummary.mrrImproved + directSummary.scoreImproved;
  const directTotal = directSummary.queryCount;

  const crossGenImproved = crossGenSummary.rankImproved + crossGenSummary.p5Improved + crossGenSummary.mrrImproved + crossGenSummary.scoreImproved;
  const crossGenTotal = crossGenSummary.queryCount;

  const ambigImproved = ambiguousSummary.rankImproved + ambiguousSummary.p5Improved + ambiguousSummary.mrrImproved + ambiguousSummary.scoreImproved;
  const ambigTotal = ambiguousSummary.queryCount;

  // Overall metrics
  const avgP5Delta = overallSummary.queryCount > 0
    ? (overallSummary.totalP5After - overallSummary.totalP5Before) / overallSummary.queryCount
    : 0;
  const avgMRRDelta = overallSummary.queryCount > 0
    ? (overallSummary.totalMRRAfter - overallSummary.totalMRRBefore) / overallSummary.queryCount
    : 0;
  const avgNDCGDelta = overallSummary.queryCount > 0
    ? (overallSummary.totalNDCGAfter - overallSummary.totalNDCGBefore) / overallSummary.queryCount
    : 0;

  // Success criteria
  const noRegression = avgP5Delta >= -0.02 && avgMRRDelta >= -0.02 && avgNDCGDelta >= -0.02;
  const noDrasticWorsening = overallSummary.perQuery.every(q => q.delta.rank >= -3);
  const noHarm = overallSummary.rankWorsened <= Math.ceil(overallSummary.queryCount * 0.25);
  const hasDirectImprovement = directImproved > 0;

  const passed = noRegression && noDrasticWorsening && noHarm;

  console.log('\n  ── Verdict ──\n');
  console.log(`  No significant regression:  ${noRegression ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  (P@5: ${(avgP5Delta * 100).toFixed(2)}pp, MRR: ${(avgMRRDelta * 100).toFixed(2)}pp, NDCG: ${(avgNDCGDelta * 100).toFixed(2)}pp)`);
  console.log(`  Has direct improvement:     ${hasDirectImprovement ? '\x1b[32mPASS\x1b[0m' : '\x1b[33mWARN\x1b[0m'}  (${directImproved} improvements in ${directTotal} direct queries)`);
  console.log(`  Has cross-gen improvement:  ${crossGenImproved > 0 ? '\x1b[32mPASS\x1b[0m' : '\x1b[33mWARN\x1b[0m'}  (${crossGenImproved} improvements in ${crossGenTotal} cross-gen queries)`);
  console.log(`  Has ambiguous improvement:  ${ambigImproved > 0 ? '\x1b[32mPASS\x1b[0m' : '\x1b[33mWARN\x1b[0m'}  (${ambigImproved} improvements in ${ambigTotal} ambiguous queries)`);
  console.log(`  No drastic rank drops:      ${noDrasticWorsening ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  (max 3 position drop allowed)`);
  console.log(`  Limited regression scope:   ${noHarm ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  (${overallSummary.rankWorsened}/${overallSummary.queryCount} worsened, max 25% allowed)`);

  const overallVerdict = passed ? 'PASS' : 'FAIL';
  const verdictColor = passed ? '\x1b[32m' : '\x1b[31m';
  console.log(`\n  Overall: ${verdictColor}${overallVerdict}\x1b[0m — SONA ${passed ? 'provides net benefit (or is neutral)' : 'may cause harm'}`);
  console.log(`\n  Total: ${overallSummary.queryCount} eval queries, ${TRAINING_QUERIES.length} training queries, ${Object.keys(overallSummary.perCategory).length} categories`);

  // ─── Save Report ────────────────────────────────────────────────

  const report = {
    timestamp: new Date().toISOString(),
    version: '2.0',
    evalQueries: EVAL_QUERIES.length,
    trainingQueries: TRAINING_QUERIES.length,
    trainingRounds: TRAINING_ROUNDS,
    trainedSignals,
    summary: {
      overall: {
        baseline: {
          avgP5: overallSummary.totalP5Before / overallSummary.queryCount,
          avgMRR: overallSummary.totalMRRBefore / overallSummary.queryCount,
          avgNDCG: overallSummary.totalNDCGBefore / overallSummary.queryCount,
        },
        postTraining: {
          avgP5: overallSummary.totalP5After / overallSummary.queryCount,
          avgMRR: overallSummary.totalMRRAfter / overallSummary.queryCount,
          avgNDCG: overallSummary.totalNDCGAfter / overallSummary.queryCount,
        },
        delta: { precision5: avgP5Delta, mrr: avgMRRDelta, ndcg: avgNDCGDelta },
        rankMovement: { improved: overallSummary.rankImproved, same: overallSummary.rankSame, worsened: overallSummary.rankWorsened },
      },
      direct: {
        queries: directSummary.queryCount,
        improved: directImproved,
        p5Improved: directSummary.p5Improved,
        rankImproved: directSummary.rankImproved,
        scoreImproved: directSummary.scoreImproved,
      },
      crossGen: {
        queries: crossGenSummary.queryCount,
        improved: crossGenImproved,
        p5Improved: crossGenSummary.p5Improved,
        rankImproved: crossGenSummary.rankImproved,
        scoreImproved: crossGenSummary.scoreImproved,
      },
      ambiguous: {
        queries: ambiguousSummary.queryCount,
        improved: ambigImproved,
        p5Improved: ambiguousSummary.p5Improved,
        rankImproved: ambiguousSummary.rankImproved,
        scoreImproved: ambiguousSummary.scoreImproved,
      },
      verdict: overallVerdict,
    },
    perCategory: Object.fromEntries(
      Object.entries(overallSummary.perCategory).map(([cat, m]) => [cat, {
        queries: m.count,
        baseline: { avgP5: m.p5Before / m.count, avgMRR: m.mrrBefore / m.count, avgNDCG: m.ndcgBefore / m.count },
        postTraining: { avgP5: m.p5After / m.count, avgMRR: m.mrrAfter / m.count, avgNDCG: m.ndcgAfter / m.count },
      }])
    ),
    weaknessAnalysis: {
      worstBaseline: sortedByBaseline.slice(0, 10).map(q => ({ id: q.id, category: q.category, query: q.query, baselineP5: q.baseline.precision5, postP5: q.postTraining.precision5, delta: q.delta.precision5 })),
      topImprovements: topImproved.map(q => ({ id: q.id, category: q.category, query: q.query, baselineP5: q.baseline.precision5, postP5: q.postTraining.precision5, delta: q.delta.precision5 })),
      regressions: regressions.map(q => ({ id: q.id, category: q.category, query: q.query, deltaP5: q.delta.precision5, deltaMRR: q.delta.mrr, deltaRank: q.delta.rank })),
    },
    perQuery: overallSummary.perQuery,
  };

  await mkdir(path.join(PROJECT_ROOT, 'tests', 'results'), { recursive: true });
  const reportPath = path.join(PROJECT_ROOT, 'tests', 'results', 'sona-eval-report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n  Report saved: tests/results/sona-eval-report.json`);

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(report, null, 2));
  }

  process.exit(passed ? 0 : 1);
}

main().catch((e) => {
  console.error('SONA eval error:', e);
  process.exit(1);
});
