/**
 * Magento Code Indexer using ruvector
 * Uses VectorDB for semantic search with Magento-aware pattern detection
 */

import {
  VectorDB,
  createIntelligenceEngine
} from 'ruvector';
import { glob } from 'glob';
import { readFile, stat, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import {
  detectMagentoFileType,
  extractPhpMagentoMetadata,
  extractXmlMagentoMetadata,
  extractGraphqlMetadata,
  detectArea,
  extractModuleInfo
} from './magento-patterns.js';

const VECTOR_DIM = 384; // ruvector native dimension
const EMBED_DIM = 256;  // IntelligenceEngine embed dimension

const MAGENTO_FILE_PATTERNS = [
  '**/*.php',
  '**/*.xml',
  '**/*.phtml',
  '**/*.js',
  '**/*.graphqls'
];

const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/vendor/bin/**',
  '**/.git/**',
  '**/var/**',
  '**/pub/static/**',
  '**/generated/**',
  '**/dev/tests/**',
  '**/dev/tools/**',
  '**/Test/**',
  '**/Tests/**',
  '**/test/**',
  '**/tests/**',
  '**/Test/Unit/**',
  '**/Test/Mftf/**',
  '**/Test/Integration/**',
  '**/Test/Fixture/**',
  '**/fixtures/**',
  '**/performance-toolkit/**',
  '**/setup/performance-toolkit/**',
  '**/_files/**',
  '**/dev/**'
];

export class MagentoIndexer {
  constructor(options = {}) {
    this.dbPath = options.dbPath || './magector.db';
    this.magentoRoot = options.magentoRoot || process.cwd();
    this.db = null;
    this.intelligenceEngine = null;
    this.chunkSize = options.chunkSize || 500;
    this.maxFileSize = options.maxFileSize || 100000;
  }

  async init() {
    // Vector database for semantic search
    this.db = new VectorDB({
      dimensions: VECTOR_DIM,
      storagePath: this.dbPath
    });

    // Intelligence engine for embeddings
    this.intelligenceEngine = createIntelligenceEngine({
      enableOnnx: false,
      enableAttention: true,
      embeddingDim: EMBED_DIM,
      enableSona: false
    });

    return this;
  }

  /**
   * Generate 384-dim embedding from text (pads 256 to 384)
   */
  embed(text) {
    const e256 = this.intelligenceEngine.embed(text);
    const e384 = new Float32Array(VECTOR_DIM);
    e384.set(e256);
    return e384;
  }

  async indexDirectory(directory = null) {
    const root = directory || this.magentoRoot;
    console.log(`Indexing Magento at: ${root}`);

    const files = await glob(MAGENTO_FILE_PATTERNS, {
      cwd: root,
      ignore: IGNORE_PATTERNS,
      absolute: true,
      nodir: true
    });

    console.log(`Found ${files.length} files to index`);

    let indexed = 0;
    let skipped = 0;

    for (const filePath of files) {
      try {
        const stats = await stat(filePath);
        if (stats.size > this.maxFileSize) {
          skipped++;
          continue;
        }

        const content = await readFile(filePath, 'utf-8');
        const relativePath = path.relative(root, filePath);
        const fileType = this.getFileType(filePath);

        // Magento-specific metadata extraction
        let magentoMeta = {};
        const magentoFileType = detectMagentoFileType(relativePath);
        const area = detectArea(relativePath);
        const moduleInfo = extractModuleInfo(relativePath);

        if (fileType === 'php') {
          magentoMeta = extractPhpMagentoMetadata(content, relativePath);
        } else if (fileType === 'xml') {
          magentoMeta = extractXmlMagentoMetadata(content, relativePath);
        } else if (fileType === 'graphql') {
          magentoMeta = extractGraphqlMetadata(content, relativePath);
        }

        // Chunk and index
        const chunks = this.chunkCode(content, filePath, magentoMeta);

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          // Extract searchable text from chunk (method signatures, class names, etc.)
          const searchableText = this.extractSearchableText(chunk, fileType, magentoMeta);

          const metadata = {
            path: relativePath,
            absolutePath: filePath,
            type: fileType,
            magentoType: magentoFileType,
            area: area,
            module: moduleInfo?.full || this.extractModule(relativePath),
            vendor: moduleInfo?.vendor,
            moduleName: moduleInfo?.module,
            chunkIndex: i,
            totalChunks: chunks.length,
            searchText: searchableText, // Searchable content summary
            ...this.extractCodeMetadata(chunk, filePath),
            ...magentoMeta
          };

          // Create enriched text for embedding
          const embeddingText = this.createEmbeddingText(chunk, metadata);
          const vector = this.embed(embeddingText);

          await this.db.insert({
            vector: Array.from(vector),
            metadata: metadata
          });
        }

        indexed++;
        if (indexed % 100 === 0) {
          console.log(`Indexed ${indexed}/${files.length} files...`);
        }
      } catch (err) {
        skipped++;
      }
    }

    console.log(`Indexing complete: ${indexed} indexed, ${skipped} skipped`);

    return {
      indexed,
      skipped,
      total: files.length
    };
  }

  /**
   * Create enriched text for embedding - includes class names, patterns, etc.
   */
  createEmbeddingText(chunk, metadata) {
    let text = chunk;

    // Add class name with high weight
    if (metadata.className) {
      text += ` class ${metadata.className} ${metadata.className} ${metadata.className}`;
      // Also split CamelCase
      text += ` ${metadata.className.replace(/([a-z])([A-Z])/g, '$1 $2')}`;
    }

    if (metadata.methodName) {
      text += ` function ${metadata.methodName} method ${metadata.methodName}`;
    }

    if (metadata.namespace) {
      text += ` namespace ${metadata.namespace.split('\\').join(' ')}`;
    }

    if (metadata.module) {
      text += ` module ${metadata.module} ${metadata.module.replace('_', ' ')}`;
    }

    // Pattern-specific enrichment
    if (metadata.isRepository) {
      text += ' repository repositoryinterface getById save delete getList crud data access';
    }
    if (metadata.isController) {
      text += ' controller action execute http request dispatch resultfactory';
    }
    if (metadata.isPlugin) {
      text += ' plugin interceptor before after around intercept proceed';
    }
    if (metadata.isObserver) {
      text += ' observer observerinterface event listener execute dispatch';
    }
    if (metadata.isModel) {
      text += ' model entity abstractmodel beforesave aftersave beforeload afterload';
    }
    if (metadata.isBlock) {
      text += ' block template _toHtml _prepareLayout phtml render';
    }
    if (metadata.isResolver) {
      text += ' resolver graphql resolve field mutation query';
    }

    return text;
  }

  chunkCode(content, filePath, magentoMeta = {}) {
    const ext = path.extname(filePath);
    const chunks = [];

    if (ext === '.php') {
      // Extract full class with docblock
      const classMatches = content.match(/(?:\/\*\*[\s\S]*?\*\/\s*)?(?:abstract\s+)?(?:final\s+)?(?:class|interface|trait)\s+\w+[\s\S]*?(?=\n(?:\/\*\*|(?:abstract\s+)?(?:final\s+)?(?:class|interface|trait))\s|\n?$)/g);
      if (classMatches && classMatches.length > 0) {
        chunks.push(...classMatches.map(c => c.trim()).filter(c => c.length > 50));
      }

      // Extract individual methods
      const methodMatches = content.match(/(?:\/\*\*[\s\S]*?\*\/\s*)?(?:public|private|protected)\s+(?:static\s+)?function\s+\w+\s*\([^)]*\)\s*(?::\s*\??\w+)?\s*\{[\s\S]*?\n\s{4}\}/g);
      if (methodMatches) {
        chunks.push(...methodMatches.map(m => m.trim()).filter(m => m.length > 30));
      }

      // Plugin methods
      if (magentoMeta.isPlugin && magentoMeta.pluginMethods) {
        for (const pm of magentoMeta.pluginMethods) {
          const pluginRegex = new RegExp(`(?:\\/\\*\\*[\\s\\S]*?\\*\\/\\s*)?public\\s+function\\s+${pm.name}\\s*\\([^)]*\\)[\\s\\S]*?\\n\\s{4}\\}`, 'g');
          const pluginMatch = content.match(pluginRegex);
          if (pluginMatch) {
            chunks.push(...pluginMatch.map(m => `[PLUGIN:${pm.type}] ${m.trim()}`));
          }
        }
      }

      // Controller execute
      if (magentoMeta.isController) {
        const executeMatch = content.match(/(?:\/\*\*[\s\S]*?\*\/\s*)?public\s+function\s+execute\s*\(\s*\)[\s\S]*?\n\s{4}\}/);
        if (executeMatch) {
          chunks.push(`[CONTROLLER:execute] ${executeMatch[0].trim()}`);
        }
      }

      // Observer execute
      if (magentoMeta.isObserver) {
        const observerMatch = content.match(/public\s+function\s+execute\s*\(\s*Observer[\s\S]*?\n\s{4}\}/);
        if (observerMatch) {
          chunks.push(`[OBSERVER:execute] ${observerMatch[0].trim()}`);
        }
      }

      // GraphQL resolver
      if (magentoMeta.isResolver) {
        const resolverMatch = content.match(/public\s+function\s+resolve\s*\(\s*Field[\s\S]*?\n\s{4}\}/);
        if (resolverMatch) {
          chunks.push(`[RESOLVER:resolve] ${resolverMatch[0].trim()}`);
        }
      }
    }

    if (ext === '.xml') {
      // di.xml
      if (filePath.includes('di.xml')) {
        const prefMatches = content.match(/<preference[^>]*\/>/g);
        if (prefMatches) chunks.push(...prefMatches.map(p => `[DI:preference] ${p}`));

        const vtMatches = content.match(/<virtualType[\s\S]*?<\/virtualType>/g);
        if (vtMatches) chunks.push(...vtMatches.map(v => `[DI:virtualType] ${v}`));

        const typeMatches = content.match(/<type\s+name="[^"]+">[\s\S]*?<\/type>/g);
        if (typeMatches) chunks.push(...typeMatches.map(t => `[DI:type] ${t}`));

        const pluginMatches = content.match(/<plugin[^>]*\/>/g);
        if (pluginMatches) chunks.push(...pluginMatches.map(p => `[DI:plugin] ${p}`));
      }

      // events.xml
      if (filePath.includes('events.xml')) {
        const eventMatches = content.match(/<event\s+name="[^"]+">[\s\S]*?<\/event>/g);
        if (eventMatches) chunks.push(...eventMatches.map(e => `[EVENT] ${e}`));
      }

      // webapi.xml
      if (filePath.includes('webapi.xml')) {
        const routeMatches = content.match(/<route[\s\S]*?<\/route>/g);
        if (routeMatches) chunks.push(...routeMatches.map(r => `[API:route] ${r}`));
      }

      // layout xml
      if (filePath.includes('/layout/')) {
        const blockMatches = content.match(/<block[^>]*(?:\/>|>[\s\S]*?<\/block>)/g);
        if (blockMatches) chunks.push(...blockMatches.filter(b => b.length > 30).map(b => `[LAYOUT:block] ${b}`));
      }

      // system.xml
      if (filePath.includes('system.xml')) {
        const sectionMatches = content.match(/<section[\s\S]*?<\/section>/g);
        if (sectionMatches) chunks.push(...sectionMatches.map(s => `[CONFIG:section] ${s}`));
      }

      // db_schema.xml
      if (filePath.includes('db_schema.xml')) {
        const tableMatches = content.match(/<table[\s\S]*?<\/table>/g);
        if (tableMatches) chunks.push(...tableMatches.map(t => `[SCHEMA:table] ${t}`));
      }

      // Generic XML fallback
      if (chunks.length === 0) {
        const nodeMatches = content.match(/<[a-z_]+[^>]*>[\s\S]*?<\/[a-z_]+>/gi);
        if (nodeMatches) {
          chunks.push(...nodeMatches.filter(n => n.length > 50 && n.length < this.chunkSize * 2));
        }
      }
    }

    // GraphQL schema
    if (ext === '.graphqls') {
      const typeMatches = content.match(/type\s+\w+\s*(?:implements[\w\s,&]+)?\s*\{[^}]+\}/g);
      if (typeMatches) chunks.push(...typeMatches.map(t => `[GRAPHQL:type] ${t}`));

      const ifaceMatches = content.match(/interface\s+\w+\s*\{[^}]+\}/g);
      if (ifaceMatches) chunks.push(...ifaceMatches.map(i => `[GRAPHQL:interface] ${i}`));

      const inputMatches = content.match(/input\s+\w+\s*\{[^}]+\}/g);
      if (inputMatches) chunks.push(...inputMatches.map(i => `[GRAPHQL:input] ${i}`));
    }

    // PHTML templates
    if (ext === '.phtml') {
      const phpBlocks = content.match(/<\?php[\s\S]*?\?>/g);
      if (phpBlocks) {
        chunks.push(...phpBlocks.filter(p => p.length > 50).map(p => `[TEMPLATE:php] ${p}`));
      }
      if (chunks.length === 0 && content.length < this.chunkSize * 3) {
        chunks.push(`[TEMPLATE] ${content}`);
      }
    }

    // Fallback chunking
    if (chunks.length === 0) {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i += 30) {
        const chunk = lines.slice(i, i + 40).join('\n').trim();
        if (chunk.length > 50) {
          chunks.push(chunk);
        }
      }
    }

    return chunks.length > 0 ? chunks : [content.substring(0, this.chunkSize)];
  }

  getFileType(filePath) {
    const ext = path.extname(filePath);
    const types = {
      '.php': 'php',
      '.xml': 'xml',
      '.phtml': 'template',
      '.js': 'javascript',
      '.graphqls': 'graphql'
    };
    return types[ext] || 'unknown';
  }

  extractModule(relativePath) {
    const vendorMatch = relativePath.match(/vendor\/([^/]+\/[^/]+)/);
    if (vendorMatch) return vendorMatch[1];

    const appMatch = relativePath.match(/app\/code\/([^/]+\/[^/]+)/);
    if (appMatch) return appMatch[1];

    const designMatch = relativePath.match(/app\/design\/([^/]+\/[^/]+\/[^/]+)/);
    if (designMatch) return designMatch[1];

    return 'core';
  }

  extractCodeMetadata(content, filePath) {
    const metadata = {};

    const classMatch = content.match(/(?:class|interface|trait)\s+(\w+)/);
    if (classMatch) metadata.className = classMatch[1];

    const namespaceMatch = content.match(/namespace\s+([\w\\]+)/);
    if (namespaceMatch) metadata.namespace = namespaceMatch[1];

    const methodMatch = content.match(/function\s+(\w+)/);
    if (methodMatch) metadata.methodName = methodMatch[1];

    const extendsMatch = content.match(/extends\s+(\w+)/);
    if (extendsMatch) metadata.extends = extendsMatch[1];

    const implementsMatch = content.match(/implements\s+([\w,\s\\]+)/);
    if (implementsMatch) metadata.implements = implementsMatch[1].trim();

    return metadata;
  }

  /**
   * Extract searchable text from code chunk for better keyword matching
   */
  extractSearchableText(content, fileType, magentoMeta = {}) {
    const terms = new Set();

    if (fileType === 'php') {
      // Extract all method names
      const methods = content.match(/function\s+(\w+)/g) || [];
      methods.forEach(m => {
        const name = m.replace('function ', '');
        terms.add(name);
        // Split camelCase
        terms.add(name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());
      });

      // Extract class/interface/trait names
      const classes = content.match(/(?:class|interface|trait)\s+(\w+)/g) || [];
      classes.forEach(c => {
        const name = c.split(/\s+/)[1];
        terms.add(name);
        terms.add(name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());
      });

      // Extract use statements (dependencies)
      const uses = content.match(/use\s+([\w\\]+)/g) || [];
      uses.forEach(u => {
        const parts = u.replace('use ', '').split('\\');
        parts.forEach(p => terms.add(p.toLowerCase()));
      });

      // Extract important PHP keywords in context
      if (content.includes('extends AbstractModel')) terms.add('abstractmodel model entity');
      if (content.includes('implements RepositoryInterface')) terms.add('repository crud getbyid save delete');
      if (content.includes('implements ObserverInterface')) terms.add('observer event listener');
      if (content.includes('execute(')) terms.add('execute action');
      if (content.includes('__construct(')) terms.add('constructor dependency injection');
      if (content.includes('getPrice')) terms.add('price pricing');
      if (content.includes('addToCart')) terms.add('cart add shopping');
      if (content.includes('placeOrder')) terms.add('order place checkout');
    }

    if (fileType === 'xml') {
      // Extract XML element names and attributes
      const elements = content.match(/<(\w+)[^>]*>/g) || [];
      elements.forEach(e => {
        const tag = e.match(/<(\w+)/)?.[1];
        if (tag) terms.add(tag.toLowerCase());
      });

      // Extract attribute values
      const attrs = content.match(/(?:name|for|type|class|method)="([^"]+)"/g) || [];
      attrs.forEach(a => {
        const val = a.match(/"([^"]+)"/)?.[1];
        if (val) {
          terms.add(val);
          // Split namespace/class paths
          val.split(/[\\\/]/).forEach(p => terms.add(p.toLowerCase()));
        }
      });

      // XML-specific patterns
      if (content.includes('<preference')) terms.add('preference di dependency');
      if (content.includes('<plugin')) terms.add('plugin interceptor');
      if (content.includes('<event')) terms.add('event observer');
      if (content.includes('<route')) terms.add('route api rest webapi');
      if (content.includes('<job')) terms.add('cron job schedule');
      if (content.includes('<table')) terms.add('table database schema');
      if (content.includes('<section')) terms.add('system config admin');
      if (content.includes('<block')) terms.add('block layout template');
    }

    if (fileType === 'graphql') {
      // Extract GraphQL types and fields
      const types = content.match(/(?:type|interface|input|enum)\s+(\w+)/g) || [];
      types.forEach(t => terms.add(t.split(/\s+/)[1]?.toLowerCase()));

      const fields = content.match(/(\w+)\s*[:\(]/g) || [];
      fields.forEach(f => terms.add(f.replace(/[:\(]/g, '').toLowerCase()));
    }

    // Add Magento metadata terms
    if (magentoMeta.eventName) terms.add(magentoMeta.eventName.replace(/_/g, ' '));
    if (magentoMeta.targetClass) {
      terms.add(magentoMeta.targetClass);
      magentoMeta.targetClass.split(/[\\\/]/).forEach(p => terms.add(p.toLowerCase()));
    }
    if (magentoMeta.pluginMethods) {
      magentoMeta.pluginMethods.forEach(pm => {
        terms.add(pm.name);
        terms.add(pm.type); // before, after, around
      });
    }

    return Array.from(terms).join(' ').substring(0, 500);
  }

  async search(query, options = {}) {
    const limit = options.limit || options.k || 10;
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter(t => t.length > 2);

    // Create query embedding with enrichment
    let enrichedQuery = query;

    // Pattern detection from query
    const queryPatterns = {
      isRepository: queryLower.includes('repository') || queryLower.includes('getbyid') || queryLower.includes('getlist'),
      isController: queryLower.includes('controller') || (queryLower.includes('execute') && !queryLower.includes('cron')),
      isObserver: queryLower.includes('observer') || queryLower.includes('observerinterface'),
      isPlugin: queryLower.includes('plugin') || queryLower.includes('interceptor') || /\b(before|after|around)\b/.test(queryLower),
      isModel: (queryLower.includes('model') && !queryLower.includes('abstractmodel')) || queryLower.includes('entity'),
      isBlock: queryLower.includes('block') && !queryLower.includes('blocked'),
      isResolver: queryLower.includes('resolver') || (queryLower.includes('graphql') && !queryLower.includes('webapi')),
      isDi: queryLower.includes('di.xml') || queryLower.includes('preference') || queryLower.includes('virtualtype') || queryLower.includes('dependency injection'),
      isEvents: queryLower.includes('events.xml') || (queryLower.includes('event') && queryLower.includes('observer')),
      isWebapi: queryLower.includes('webapi') || (queryLower.includes('rest') && queryLower.includes('api')) || (queryLower.includes('api') && queryLower.includes('endpoint')),
      isLayout: queryLower.includes('layout'),
      isConfig: queryLower.includes('system.xml') || (queryLower.includes('system') && queryLower.includes('configuration')),
      isSchema: queryLower.includes('db_schema') || (queryLower.includes('database') && queryLower.includes('schema')) || queryLower.includes('table definition'),
      isSetup: queryLower.includes('datapatch') || (queryLower.includes('upgrade') && queryLower.includes('setup')),
      isConsole: queryLower.includes('console') || (queryLower.includes('command') && queryLower.includes('cli')),
      isEav: queryLower.includes('eav') || (queryLower.includes('attribute') && (queryLower.includes('product') || queryLower.includes('entity'))),
      isIndexer: queryLower.includes('indexer') || queryLower.includes('reindex'),
      isAcl: queryLower.includes('acl.xml') || (queryLower.includes('acl') && queryLower.includes('permission')),
      isPayment: queryLower.includes('payment') || queryLower.includes('authorize') || queryLower.includes('capture'),
      isShipping: queryLower.includes('shipping') || queryLower.includes('carrier') || queryLower.includes('collectrates'),
      isCache: queryLower.includes('cache') || queryLower.includes('flush'),
      isCron: queryLower.includes('cron') || queryLower.includes('crontab') || (queryLower.includes('schedule') && queryLower.includes('task')),
      isApi: queryLower.includes('/api') || queryLower.includes('api interface') || queryLower.includes('api/') || queryLower.includes('service contract'),
      isTemplate: queryLower.includes('phtml') || queryLower.includes('template') || queryLower.includes('listing'),
      isInterface: queryLower.includes('interface') || queryLower.includes('contract')
    };

    // Expected path fragments based on query
    const expectedPaths = [];
    if (queryPatterns.isController) expectedPaths.push('controller');
    if (queryPatterns.isRepository) expectedPaths.push('repository');
    if (queryPatterns.isObserver) expectedPaths.push('observer');
    if (queryPatterns.isPlugin) expectedPaths.push('plugin');
    if (queryPatterns.isBlock) expectedPaths.push('block');
    if (queryPatterns.isResolver) expectedPaths.push('graphql', 'resolver');
    if (queryPatterns.isDi) expectedPaths.push('di.xml');
    if (queryPatterns.isEvents) expectedPaths.push('events.xml');
    if (queryPatterns.isWebapi) expectedPaths.push('webapi.xml');
    if (queryPatterns.isLayout) expectedPaths.push('layout');
    if (queryPatterns.isConfig) expectedPaths.push('system.xml');
    if (queryPatterns.isSchema) expectedPaths.push('db_schema');
    if (queryPatterns.isSetup) expectedPaths.push('setup');
    if (queryPatterns.isConsole) expectedPaths.push('console');
    if (queryPatterns.isEav) expectedPaths.push('eav');
    if (queryPatterns.isIndexer) expectedPaths.push('indexer');
    if (queryPatterns.isAcl) expectedPaths.push('acl');
    if (queryPatterns.isPayment) expectedPaths.push('payment');
    if (queryPatterns.isShipping) expectedPaths.push('shipping');
    if (queryPatterns.isCache) expectedPaths.push('cache');
    if (queryPatterns.isCron) expectedPaths.push('crontab.xml', 'cron');
    if (queryPatterns.isApi) expectedPaths.push('/api/', 'api/');
    if (queryPatterns.isTemplate) expectedPaths.push('.phtml', 'templates');
    if (queryPatterns.isInterface) expectedPaths.push('interface', 'api/');

    // Module hints from query - with priority (higher = more specific)
    const moduleHints = [];
    if (queryLower.includes('checkout') || queryLower.includes('cart')) {
      moduleHints.push({ path: 'checkout', priority: 1.0 });
      moduleHints.push({ path: 'cart', priority: 0.8 });
    }
    if (queryLower.includes('customer') && !queryLower.includes('catalog')) {
      moduleHints.push({ path: 'customer', priority: 1.0 });
    }
    if (queryLower.includes('catalog') || (queryLower.includes('product') && !queryLower.includes('cart'))) {
      moduleHints.push({ path: 'catalog', priority: 0.8 });
    }
    if (queryLower.includes('sales') || queryLower.includes('order')) {
      moduleHints.push({ path: 'sales', priority: 1.0 });
    }
    if (queryLower.includes('quote')) {
      moduleHints.push({ path: 'quote', priority: 1.0 });
    }

    // Explicit file name patterns
    const filePatterns = [];
    if (queryPatterns.isDi) filePatterns.push({ exact: 'di.xml', priority: 2.0 });
    if (queryPatterns.isEvents) filePatterns.push({ exact: 'events.xml', priority: 2.0 });
    if (queryPatterns.isWebapi) filePatterns.push({ exact: 'webapi.xml', priority: 2.0 });
    if (queryPatterns.isConfig) filePatterns.push({ exact: 'system.xml', priority: 2.0 });
    if (queryPatterns.isSchema) filePatterns.push({ exact: 'db_schema.xml', priority: 2.0 });
    if (queryPatterns.isCron) filePatterns.push({ exact: 'crontab.xml', priority: 2.0 });
    if (queryPatterns.isAcl) filePatterns.push({ exact: 'acl.xml', priority: 2.0 });
    if (queryPatterns.isConsole) filePatterns.push({ contains: '/console/', priority: 1.5 });
    if (queryPatterns.isApi) filePatterns.push({ contains: '/api/', priority: 1.5 });
    if (queryPatterns.isTemplate) filePatterns.push({ exact: '.phtml', priority: 1.5 });
    if (queryPatterns.isInterface) filePatterns.push({ contains: 'interface', priority: 1.0 });

    // Add synonyms and expansions
    if (queryPatterns.isRepository) {
      enrichedQuery += ' repositoryinterface getById save delete getList crud';
    }
    if (queryPatterns.isController) {
      enrichedQuery += ' action execute http request dispatch';
    }
    if (queryPatterns.isObserver) {
      enrichedQuery += ' observerinterface event listener execute';
    }
    if (queryPatterns.isPlugin) {
      enrichedQuery += ' interceptor before after around proceed';
    }
    if (queryPatterns.isModel) {
      enrichedQuery += ' entity abstractmodel beforesave afterload';
    }
    if (queryPatterns.isBlock) {
      enrichedQuery += ' template _toHtml _prepareLayout phtml';
    }
    if (queryPatterns.isResolver) {
      enrichedQuery += ' resolver resolve mutation query field graphqls';
    }

    // Extract class names from query (including single-word PascalCase)
    const classNames = query.match(/\b([A-Z][a-zA-Z]+)\b/g) || [];
    for (const cn of classNames) {
      enrichedQuery += ` class ${cn} ${cn}`;
      // Also add to module hints if it's a known Magento module pattern
      if (cn.toLowerCase().includes('repository') || cn.toLowerCase().includes('interface')) {
        const baseName = cn.replace(/Repository|Interface/gi, '');
        if (baseName.length > 2) {
          moduleHints.push({ path: baseName.toLowerCase(), priority: 1.2 });
        }
      }
    }

    const queryVector = this.embed(enrichedQuery);
    const results = await this.db.search({
      vector: Array.from(queryVector),
      k: limit * 10 // Get many more for re-ranking
    });

    // Re-rank with hybrid scoring
    const scored = results.map(r => {
      const meta = r.metadata || {};
      const pathLower = (meta.path || '').toLowerCase();
      const className = (meta.className || '').toLowerCase();
      let score = 1 - (r.score || 0); // Base vector similarity

      // Strong boost for file pattern matches (di.xml, webapi.xml, Console/, etc.)
      for (const fp of filePatterns) {
        const pattern = fp.exact || fp.contains;
        if (pathLower.includes(pattern.toLowerCase())) {
          score += fp.priority * 2.0; // Very strong boost for file pattern matches
        }
      }

      // Extra penalty for wrong file type when looking for config files
      const isXmlConfig = filePatterns.some(fp => fp.exact && fp.exact.endsWith('.xml'));
      if (isXmlConfig && !pathLower.endsWith('.xml')) {
        score -= 1.0;
      }

      // Direct file name mentions in query get extra boost
      for (const term of queryTerms) {
        if (term.endsWith('.xml') && pathLower.includes(term)) {
          score += 3.0;
        }
      }

      // Boost for path matches
      for (const ep of expectedPaths) {
        if (pathLower.includes(ep.toLowerCase())) {
          score += 0.5;
        }
      }

      // Boost for module hints with priority
      for (const mh of moduleHints) {
        if (pathLower.includes(mh.path.toLowerCase())) {
          score += mh.priority * 0.4;
        }
      }

      // Boost for query term matches in path/class/searchText
      const searchText = (meta.searchText || '').toLowerCase();
      for (const term of queryTerms) {
        if (term.length < 3) continue;
        if (pathLower.includes(term)) score += 0.2;
        if (className.includes(term)) score += 0.3;
        if (searchText.includes(term)) score += 0.25;
      }

      // Boost for metadata pattern matches
      if (queryPatterns.isController && meta.isController) score += 0.6;
      if (queryPatterns.isRepository && meta.isRepository) score += 0.6;
      if (queryPatterns.isObserver && meta.isObserver) score += 0.6;
      if (queryPatterns.isPlugin && meta.isPlugin) score += 0.6;
      if (queryPatterns.isModel && meta.isModel) score += 0.6;
      if (queryPatterns.isBlock && meta.isBlock) score += 0.6;
      if (queryPatterns.isResolver && meta.isResolver) score += 0.6;

      // Boost for API patterns - Interface files, Api directories
      if (queryPatterns.isApi) {
        if (pathLower.includes('/api/')) score += 0.8;
        if (className.includes('interface')) score += 0.4;
        if (pathLower.includes('interface')) score += 0.4;
      }

      // Boost for templates
      if (queryPatterns.isTemplate) {
        if (pathLower.endsWith('.phtml')) score += 1.0;
        if (pathLower.includes('templates/')) score += 0.5;
        if (pathLower.includes('/view/frontend/')) score += 0.3;
      }

      // Boost for cron jobs
      if (queryPatterns.isCron) {
        if (pathLower.includes('crontab.xml')) score += 1.5;
        if (pathLower.includes('/cron/')) score += 0.6;
      }

      // Boost for class name match
      for (const cn of classNames) {
        const cnLower = cn.toLowerCase();
        // Strong boost for exact class name match
        if (className.toLowerCase() === cnLower) {
          score += 2.0;
        } else if (className.includes(cnLower)) {
          score += 1.0;
        }
        // Also check path for class name
        if (pathLower.includes(cnLower)) {
          score += 0.5;
        }
        // Special case for AbstractModel and similar base class queries
        if (cnLower === 'abstractmodel') {
          if (pathLower.includes('abstractmodel')) {
            score += 1.5;
          } else if (className.toLowerCase().includes('abstractmodel')) {
            score += 1.5;
          }
        }
      }

      // Penalty for wrong module when query explicitly mentions a module
      if (moduleHints.length > 0) {
        const hasAnyModuleMatch = moduleHints.some(mh => pathLower.includes(mh.path.toLowerCase()));
        if (!hasAnyModuleMatch) {
          score -= 0.3;
        }
      }

      return { ...r, hybridScore: score };
    });

    // Sort by hybrid score
    scored.sort((a, b) => b.hybridScore - a.hybridScore);

    // Deduplicate by path
    const seen = new Set();
    const deduped = [];
    for (const r of scored) {
      const path = r.metadata?.path;
      if (!seen.has(path)) {
        seen.add(path);
        deduped.push(r);
      }
      if (deduped.length >= limit) break;
    }

    return deduped.map(r => ({
      content: '', // VectorDB doesn't store content, only metadata
      path: r.metadata?.path,
      module: r.metadata?.module,
      type: r.metadata?.type,
      magentoType: r.metadata?.magentoType,
      className: r.metadata?.className,
      methodName: r.metadata?.methodName,
      namespace: r.metadata?.namespace,
      isPlugin: r.metadata?.isPlugin,
      isController: r.metadata?.isController,
      isObserver: r.metadata?.isObserver,
      isRepository: r.metadata?.isRepository,
      isResolver: r.metadata?.isResolver,
      isModel: r.metadata?.isModel,
      isBlock: r.metadata?.isBlock,
      patterns: r.metadata?.patterns,
      area: r.metadata?.area,
      score: r.hybridScore
    }));
  }

  async getStats() {
    const vectorCount = await this.db.len();

    return {
      totalVectors: vectorCount,
      dbPath: this.dbPath
    };
  }

  async close() {
    // VectorDB auto-saves
  }
}
