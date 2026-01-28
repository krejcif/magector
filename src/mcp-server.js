#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { MagentoIndexer } from './indexer.js';

const config = {
  dbPath: process.env.MAGECTOR_DB || './magector.db',
  magentoRoot: process.env.MAGENTO_ROOT || process.cwd()
};

let indexer = null;

async function getIndexer() {
  if (!indexer) {
    indexer = new MagentoIndexer(config);
    await indexer.init();
  }
  return indexer;
}

const server = new Server(
  {
    name: 'magector',
    version: '1.0.0'
  },
  {
    capabilities: {
      tools: {},
      resources: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'magento_search',
      description: 'Search Magento codebase semantically. Find classes, methods, configurations, templates by describing what you need.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural language search query (e.g., "product price calculation", "checkout controller", "customer authentication")'
          },
          limit: {
            type: 'number',
            description: 'Maximum results to return (default: 10)',
            default: 10
          },
          type: {
            type: 'string',
            enum: ['php', 'xml', 'template', 'javascript', 'graphql'],
            description: 'Filter by file type'
          },
          module: {
            type: 'string',
            description: 'Filter by Magento module (e.g., "Magento/Catalog", "Magento/Checkout")'
          },
        },
        required: ['query']
      }
    },
    {
      name: 'magento_find_class',
      description: 'Find a specific PHP class, interface, or trait in Magento',
      inputSchema: {
        type: 'object',
        properties: {
          className: {
            type: 'string',
            description: 'Class name to find (e.g., "ProductRepository", "AbstractModel")'
          },
          namespace: {
            type: 'string',
            description: 'Optional namespace filter'
          }
        },
        required: ['className']
      }
    },
    {
      name: 'magento_find_method',
      description: 'Find implementations of a specific method across Magento',
      inputSchema: {
        type: 'object',
        properties: {
          methodName: {
            type: 'string',
            description: 'Method name to find (e.g., "execute", "getPrice", "save")'
          },
          className: {
            type: 'string',
            description: 'Optional class name filter'
          }
        },
        required: ['methodName']
      }
    },
    {
      name: 'magento_find_config',
      description: 'Find XML configuration files and nodes in Magento',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Configuration to find (e.g., "di.xml preference", "routes.xml", "system.xml field")'
          },
          configType: {
            type: 'string',
            enum: ['di', 'routes', 'system', 'events', 'webapi', 'module', 'layout', 'other'],
            description: 'Type of configuration'
          }
        },
        required: ['query']
      }
    },
    {
      name: 'magento_find_template',
      description: 'Find PHTML templates in Magento',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Template description (e.g., "product listing", "checkout form", "customer account")'
          },
          area: {
            type: 'string',
            enum: ['frontend', 'adminhtml', 'base'],
            description: 'Magento area'
          }
        },
        required: ['query']
      }
    },
    {
      name: 'magento_index',
      description: 'Index or re-index Magento codebase for semantic search',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to Magento root (uses configured path if not specified)'
          },
        }
      }
    },
    {
      name: 'magento_stats',
      description: 'Get indexer statistics',
      inputSchema: {
        type: 'object',
        properties: {}
      }
    },
    {
      name: 'magento_find_plugin',
      description: 'Find plugins (interceptors) for a class or method - before/after/around methods',
      inputSchema: {
        type: 'object',
        properties: {
          targetClass: {
            type: 'string',
            description: 'Class being intercepted (e.g., "ProductRepository", "CartManagement")'
          },
          targetMethod: {
            type: 'string',
            description: 'Method being intercepted (e.g., "save", "getList")'
          }
        }
      }
    },
    {
      name: 'magento_find_observer',
      description: 'Find observers for a specific event',
      inputSchema: {
        type: 'object',
        properties: {
          eventName: {
            type: 'string',
            description: 'Event name (e.g., "checkout_cart_add_product_complete", "sales_order_place_after")'
          }
        },
        required: ['eventName']
      }
    },
    {
      name: 'magento_find_preference',
      description: 'Find DI preference overrides for an interface or class',
      inputSchema: {
        type: 'object',
        properties: {
          interfaceName: {
            type: 'string',
            description: 'Interface or class name to find preferences for (e.g., "ProductRepositoryInterface")'
          }
        },
        required: ['interfaceName']
      }
    },
    {
      name: 'magento_find_api',
      description: 'Find REST/SOAP API endpoints and their implementations',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'API endpoint URL pattern or service method (e.g., "/V1/products", "getList")'
          },
          method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'DELETE'],
            description: 'HTTP method filter'
          }
        },
        required: ['query']
      }
    },
    {
      name: 'magento_find_controller',
      description: 'Find controllers by route or action',
      inputSchema: {
        type: 'object',
        properties: {
          route: {
            type: 'string',
            description: 'Route path (e.g., "catalog/product/view", "checkout/cart/add")'
          },
          area: {
            type: 'string',
            enum: ['frontend', 'adminhtml'],
            description: 'Magento area'
          }
        },
        required: ['route']
      }
    },
    {
      name: 'magento_find_block',
      description: 'Find Block classes by name or template',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Block class name or functionality (e.g., "Product\\View", "cart totals")'
          }
        },
        required: ['query']
      }
    },
    {
      name: 'magento_find_cron',
      description: 'Find cron jobs by name or schedule',
      inputSchema: {
        type: 'object',
        properties: {
          jobName: {
            type: 'string',
            description: 'Cron job name or pattern (e.g., "catalog_product", "indexer")'
          }
        },
        required: ['jobName']
      }
    },
    {
      name: 'magento_find_graphql',
      description: 'Find GraphQL types, queries, mutations, or resolvers',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'GraphQL type, query, or mutation name (e.g., "products", "createCustomer", "CartItemInterface")'
          },
          schemaType: {
            type: 'string',
            enum: ['type', 'query', 'mutation', 'interface', 'resolver'],
            description: 'Type of GraphQL schema element'
          }
        },
        required: ['query']
      }
    },
    {
      name: 'magento_find_db_schema',
      description: 'Find database table definitions and columns',
      inputSchema: {
        type: 'object',
        properties: {
          tableName: {
            type: 'string',
            description: 'Table name pattern (e.g., "catalog_product", "sales_order")'
          }
        },
        required: ['tableName']
      }
    },
    {
      name: 'magento_module_structure',
      description: 'Get complete structure of a Magento module - all its classes, configs, templates',
      inputSchema: {
        type: 'object',
        properties: {
          moduleName: {
            type: 'string',
            description: 'Full module name (e.g., "Magento_Catalog", "Vendor_CustomModule")'
          }
        },
        required: ['moduleName']
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const idx = await getIndexer();

  try {
    switch (name) {
      case 'magento_search': {
        const options = { limit: args.limit || 10 };
        if (args.type) options.filter = { type: args.type };
        if (args.module) options.filter = { ...options.filter, module: args.module };

        const results = await idx.search(args.query, options);

        return {
          content: [{
            type: 'text',
            text: formatSearchResults(results)
          }]
        };
      }

      case 'magento_find_class': {
        const query = `class ${args.className} ${args.namespace || ''}`.trim();
        const results = await idx.search(query, { limit: 5, filter: { type: 'php' } });
        return {
          content: [{
            type: 'text',
            text: formatSearchResults(results.filter(r =>
              r.className?.toLowerCase().includes(args.className.toLowerCase())
            ))
          }]
        };
      }

      case 'magento_find_method': {
        const query = `function ${args.methodName} ${args.className || ''}`.trim();
        const results = await idx.search(query, { limit: 10, filter: { type: 'php' } });
        return {
          content: [{
            type: 'text',
            text: formatSearchResults(results.filter(r =>
              r.methodName?.toLowerCase() === args.methodName.toLowerCase() ||
              r.content?.includes(`function ${args.methodName}`)
            ))
          }]
        };
      }

      case 'magento_find_config': {
        let query = args.query;
        if (args.configType && args.configType !== 'other') {
          query = `${args.configType}.xml ${args.query}`;
        }
        const results = await idx.search(query, { limit: 10, filter: { type: 'xml' } });
        return {
          content: [{
            type: 'text',
            text: formatSearchResults(results)
          }]
        };
      }

      case 'magento_find_template': {
        let query = args.query;
        if (args.area) query = `${args.area} ${query}`;
        const results = await idx.search(query, { limit: 10, filter: { type: 'template' } });
        return {
          content: [{
            type: 'text',
            text: formatSearchResults(results)
          }]
        };
      }

      case 'magento_index': {
        const path = args.path || config.magentoRoot;
        const stats = await idx.indexDirectory(path);
        return {
          content: [{
            type: 'text',
            text: `Indexing complete!\n- Files indexed: ${stats.indexed}\n- Files skipped: ${stats.skipped}\n- Total files: ${stats.total}`
          }]
        };
      }

      case 'magento_stats': {
        const stats = await idx.getStats();
        return {
          content: [{
            type: 'text',
            text: `Magector Stats:\n- Total indexed chunks: ${stats.totalVectors}\n- Database path: ${stats.dbPath}`
          }]
        };
      }

      case 'magento_find_plugin': {
        let query = 'plugin interceptor';
        if (args.targetClass) query += ` ${args.targetClass}`;
        if (args.targetMethod) query += ` ${args.targetMethod} before after around`;

        const results = await idx.search(query, { limit: 15, filter: { type: 'php' } });
        const pluginResults = results.filter(r =>
          r.content?.includes('[PLUGIN:') ||
          r.magentoType === 'Plugin' ||
          r.isPlugin ||
          r.content?.match(/function\s+(before|after|around)\w+/)
        );

        // Also search di.xml for plugin configs
        const diResults = await idx.search(`plugin ${args.targetClass || ''}`, { limit: 10, filter: { type: 'xml' } });
        const configResults = diResults.filter(r => r.content?.includes('[DI:plugin]'));

        return {
          content: [{
            type: 'text',
            text: formatSearchResults([...pluginResults, ...configResults])
          }]
        };
      }

      case 'magento_find_observer': {
        const query = `event ${args.eventName} observer`;

        // Search events.xml
        const xmlResults = await idx.search(query, { limit: 10, filter: { type: 'xml' } });
        const eventConfigs = xmlResults.filter(r => r.content?.includes('[EVENT]'));

        // Search observer PHP classes
        const phpResults = await idx.search(`observer execute ${args.eventName}`, { limit: 10, filter: { type: 'php' } });
        const observers = phpResults.filter(r => r.isObserver || r.magentoType === 'Observer');

        return {
          content: [{
            type: 'text',
            text: `## Observers for event: ${args.eventName}\n\n` + formatSearchResults([...eventConfigs, ...observers])
          }]
        };
      }

      case 'magento_find_preference': {
        const query = `preference ${args.interfaceName}`;
        const results = await idx.search(query, { limit: 15, filter: { type: 'xml' } });
        const preferences = results.filter(r =>
          r.content?.includes('[DI:preference]') ||
          r.content?.includes(`for="${args.interfaceName}`) ||
          r.content?.includes(`for="\\${args.interfaceName}`)
        );

        return {
          content: [{
            type: 'text',
            text: `## Preferences for: ${args.interfaceName}\n\n` + formatSearchResults(preferences)
          }]
        };
      }

      case 'magento_find_api': {
        let query = `webapi route ${args.query}`;
        if (args.method) query += ` method="${args.method}"`;

        const results = await idx.search(query, { limit: 15, filter: { type: 'xml' } });
        const apiResults = results.filter(r =>
          r.content?.includes('[API:route]') ||
          r.path?.includes('webapi.xml')
        );

        // Also find the implementing service classes
        const serviceResults = await idx.search(`service api ${args.query}`, { limit: 10, filter: { type: 'php' } });

        return {
          content: [{
            type: 'text',
            text: `## API Endpoints matching: ${args.query}\n\n` + formatSearchResults([...apiResults, ...serviceResults])
          }]
        };
      }

      case 'magento_find_controller': {
        const parts = args.route.split('/');
        const query = `controller ${parts.join(' ')} execute action`;

        const results = await idx.search(query, { limit: 15, filter: { type: 'php' } });
        let filtered = results.filter(r =>
          r.isController ||
          r.magentoType === 'Controller' ||
          r.content?.includes('[CONTROLLER:execute]')
        );

        if (args.area) {
          filtered = filtered.filter(r => r.area === args.area || r.path?.includes(`/${args.area}/`));
        }

        // Also search routes.xml
        const routeResults = await idx.search(`routes ${args.route}`, { limit: 5, filter: { type: 'xml' } });

        return {
          content: [{
            type: 'text',
            text: `## Controllers for route: ${args.route}\n\n` + formatSearchResults([...filtered, ...routeResults])
          }]
        };
      }

      case 'magento_find_block': {
        const query = `block ${args.query}`;
        const results = await idx.search(query, { limit: 15, filter: { type: 'php' } });
        const blocks = results.filter(r =>
          r.isBlock ||
          r.magentoType === 'Block' ||
          r.path?.includes('/Block/')
        );

        // Also search layout XML
        const layoutResults = await idx.search(`block class ${args.query}`, { limit: 10, filter: { type: 'xml' } });
        const layoutBlocks = layoutResults.filter(r => r.content?.includes('[LAYOUT:block]'));

        return {
          content: [{
            type: 'text',
            text: formatSearchResults([...blocks, ...layoutBlocks])
          }]
        };
      }

      case 'magento_find_cron': {
        const query = `cron job ${args.jobName}`;

        // Search crontab.xml
        const xmlResults = await idx.search(query, { limit: 10, filter: { type: 'xml' } });
        const cronConfigs = xmlResults.filter(r => r.path?.includes('crontab.xml'));

        // Search Cron PHP classes
        const phpResults = await idx.search(`cron ${args.jobName} execute`, { limit: 10, filter: { type: 'php' } });
        const cronClasses = phpResults.filter(r => r.path?.includes('/Cron/'));

        return {
          content: [{
            type: 'text',
            text: `## Cron jobs matching: ${args.jobName}\n\n` + formatSearchResults([...cronConfigs, ...cronClasses])
          }]
        };
      }

      case 'magento_find_graphql': {
        let query = `graphql ${args.query}`;
        if (args.schemaType) query += ` ${args.schemaType}`;

        const schemaResults = await idx.search(query, { limit: 10, filter: { type: 'graphql' } });

        // If looking for resolver, also search PHP
        let resolverResults = [];
        if (!args.schemaType || args.schemaType === 'resolver') {
          const phpResults = await idx.search(`resolver ${args.query} resolve`, { limit: 10, filter: { type: 'php' } });
          resolverResults = phpResults.filter(r =>
            r.isResolver ||
            r.magentoType === 'GraphQlResolver' ||
            r.path?.includes('/Resolver/')
          );
        }

        return {
          content: [{
            type: 'text',
            text: `## GraphQL matching: ${args.query}\n\n` + formatSearchResults([...schemaResults, ...resolverResults])
          }]
        };
      }

      case 'magento_find_db_schema': {
        const query = `table ${args.tableName} column`;
        const results = await idx.search(query, { limit: 15, filter: { type: 'xml' } });
        const schemaResults = results.filter(r =>
          r.path?.includes('db_schema.xml') ||
          r.content?.includes('[SCHEMA:table]')
        );

        return {
          content: [{
            type: 'text',
            text: `## Database schema for: ${args.tableName}\n\n` + formatSearchResults(schemaResults)
          }]
        };
      }

      case 'magento_module_structure': {
        const results = await idx.search(args.moduleName, { limit: 100 });
        const moduleName = args.moduleName.replace('_', '/');
        const moduleResults = results.filter(r =>
          r.path?.includes(moduleName) || r.module?.includes(args.moduleName)
        );

        // Group by type
        const structure = {
          controllers: moduleResults.filter(r => r.isController || r.path?.includes('/Controller/')),
          models: moduleResults.filter(r => r.isModel || (r.path?.includes('/Model/') && !r.path?.includes('ResourceModel'))),
          blocks: moduleResults.filter(r => r.isBlock || r.path?.includes('/Block/')),
          plugins: moduleResults.filter(r => r.isPlugin || r.path?.includes('/Plugin/')),
          observers: moduleResults.filter(r => r.isObserver || r.path?.includes('/Observer/')),
          apis: moduleResults.filter(r => r.path?.includes('/Api/')),
          configs: moduleResults.filter(r => r.type === 'xml'),
          other: moduleResults.filter(r =>
            !r.isController && !r.isModel && !r.isBlock && !r.isPlugin && !r.isObserver &&
            !r.path?.includes('/Api/') && r.type !== 'xml' &&
            !r.path?.includes('/Controller/') && !r.path?.includes('/Model/') &&
            !r.path?.includes('/Block/') && !r.path?.includes('/Plugin/') &&
            !r.path?.includes('/Observer/')
          )
        };

        let text = `## Module Structure: ${args.moduleName}\n\n`;

        for (const [category, items] of Object.entries(structure)) {
          if (items.length > 0) {
            text += `### ${category.charAt(0).toUpperCase() + category.slice(1)} (${items.length})\n`;
            items.slice(0, 10).forEach(item => {
              text += `- ${item.className || item.path} (${item.path})\n`;
            });
            if (items.length > 10) text += `  ... and ${items.length - 10} more\n`;
            text += '\n';
          }
        }

        if (moduleResults.length === 0) {
          text += 'No code found for this module. Try re-indexing or check the module name.';
        }

        return { content: [{ type: 'text', text }] };
      }

      default:
        return {
          content: [{
            type: 'text',
            text: `Unknown tool: ${name}`
          }],
          isError: true
        };
    }
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error: ${error.message}`
      }],
      isError: true
    };
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: 'magector://stats',
      name: 'Indexer Statistics',
      description: 'Current indexer statistics and status',
      mimeType: 'application/json'
    }
  ]
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  if (uri === 'magector://stats') {
    const idx = await getIndexer();
    const stats = await idx.getStats();
    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(stats, null, 2)
      }]
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
});

function formatSearchResults(results) {
  if (!results || results.length === 0) {
    return 'No results found.';
  }

  return results.map((r, i) => {
    const header = `## Result ${i + 1} (score: ${r.score?.toFixed(3) || 'N/A'})`;

    // Build metadata array with Magento-specific info
    const meta = [
      `**Path:** ${r.path || 'unknown'}`,
      r.module ? `**Module:** ${r.module}` : null,
      r.magentoType ? `**Magento Type:** ${r.magentoType}` : null,
      r.area && r.area !== 'global' ? `**Area:** ${r.area}` : null,
      r.className ? `**Class:** ${r.className}` : null,
      r.namespace ? `**Namespace:** ${r.namespace}` : null,
      r.methodName ? `**Method:** ${r.methodName}` : null,
      r.type ? `**File Type:** ${r.type}` : null,
      r.relation ? `**Relation:** ${r.relation}` : null
    ].filter(Boolean).join('\n');

    // Add Magento pattern badges
    let badges = '';
    if (r.patterns && r.patterns.length > 0) {
      badges = `\n**Patterns:** ${r.patterns.map(p => `\`${p}\``).join(' ')}`;
    }
    if (r.isPlugin) badges += ' `plugin`';
    if (r.isController) badges += ' `controller`';
    if (r.isObserver) badges += ' `observer`';
    if (r.isRepository) badges += ' `repository`';
    if (r.isResolver) badges += ' `graphql-resolver`';

    // Additional context for specific types
    let additionalInfo = '';
    if (r.dependencies && r.dependencies.length > 0) {
      const deps = r.dependencies.slice(0, 5).map(d => d.type).join(', ');
      additionalInfo += `\n**DI Dependencies:** ${deps}${r.dependencies.length > 5 ? '...' : ''}`;
    }
    if (r.pluginMethods && r.pluginMethods.length > 0) {
      additionalInfo += `\n**Plugin Methods:** ${r.pluginMethods.map(p => `${p.type}:${p.name}`).join(', ')}`;
    }
    if (r.configItems && r.configItems.length > 0) {
      additionalInfo += `\n**Config Items:** ${r.configItems.slice(0, 5).join(', ')}${r.configItems.length > 5 ? '...' : ''}`;
    }
    if (r.apiRoutes && r.apiRoutes.length > 0) {
      additionalInfo += `\n**API Routes:** ${r.apiRoutes.map(a => `${a.method} ${a.url}`).join(', ')}`;
    }

    const content = r.content?.substring(0, 600) || '';

    // Determine code block language
    let lang = '';
    if (r.type === 'php' || r.content?.includes('<?php') || r.content?.includes('function ')) lang = 'php';
    else if (r.type === 'xml' || r.content?.startsWith('<')) lang = 'xml';
    else if (r.type === 'graphql' || r.content?.includes('type ') || r.content?.includes('query ')) lang = 'graphql';

    const codeBlock = `\`\`\`${lang}\n${content}${content.length >= 600 ? '\n...(truncated)' : ''}\n\`\`\``;

    return `${header}\n${meta}${badges}${additionalInfo}\n\n${codeBlock}`;
  }).join('\n\n---\n\n');
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Magector MCP server started');
}

main().catch(console.error);
