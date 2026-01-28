/**
 * Test queries with expected results for accuracy validation
 */

export const TEST_QUERIES = [
  // Controller queries
  {
    id: 'ctrl-1',
    query: 'controller execute action',
    type: 'semantic',
    expectedTypes: ['Controller'],
    expectedPatterns: ['controller'],
    minResults: 1,
    category: 'controller'
  },
  {
    id: 'ctrl-2',
    query: 'Index controller',
    type: 'exact',
    expectedClasses: ['Index'],
    expectedTypes: ['Controller'],
    category: 'controller'
  },

  // Model queries
  {
    id: 'model-1',
    query: 'model beforeSave afterLoad',
    type: 'semantic',
    expectedTypes: ['Model'],
    expectedPatterns: ['model'],
    category: 'model'
  },
  {
    id: 'model-2',
    query: 'AbstractModel extends',
    type: 'semantic',
    expectedInContent: ['extends AbstractModel'],
    category: 'model'
  },

  // Repository queries
  {
    id: 'repo-1',
    query: 'repository getById save delete',
    type: 'semantic',
    expectedTypes: ['Repository'],
    expectedPatterns: ['repository'],
    category: 'repository'
  },
  {
    id: 'repo-2',
    query: 'ItemRepository',
    type: 'exact',
    expectedClasses: ['ItemRepository'],
    category: 'repository'
  },
  {
    id: 'repo-3',
    query: 'getList SearchCriteria',
    type: 'semantic',
    expectedInContent: ['getList', 'SearchCriteria'],
    category: 'repository'
  },

  // Plugin queries
  {
    id: 'plugin-1',
    query: 'plugin interceptor before after around',
    type: 'semantic',
    expectedTypes: ['Plugin'],
    expectedPatterns: ['plugin'],
    category: 'plugin'
  },
  {
    id: 'plugin-2',
    query: 'beforeGetPrice plugin',
    type: 'semantic',
    expectedInContent: ['beforeGetPrice', 'before'],
    category: 'plugin'
  },
  {
    id: 'plugin-3',
    query: 'around method interceptor',
    type: 'semantic',
    expectedInContent: ['around', 'proceed'],
    category: 'plugin'
  },

  // Observer queries
  {
    id: 'obs-1',
    query: 'observer execute event',
    type: 'semantic',
    expectedTypes: ['Observer'],
    expectedPatterns: ['observer'],
    category: 'observer'
  },
  {
    id: 'obs-2',
    query: 'catalog_product_save_after observer',
    type: 'semantic',
    expectedInContent: ['catalog_product_save_after'],
    category: 'observer'
  },
  {
    id: 'obs-3',
    query: 'ObserverInterface implement',
    type: 'semantic',
    expectedInContent: ['ObserverInterface'],
    category: 'observer'
  },

  // Block queries
  {
    id: 'block-1',
    query: 'block template phtml',
    type: 'semantic',
    expectedTypes: ['Block'],
    expectedPatterns: ['block'],
    category: 'block'
  },
  {
    id: 'block-2',
    query: '_toHtml _prepareLayout',
    type: 'semantic',
    expectedInContent: ['_toHtml', '_prepareLayout'],
    category: 'block'
  },

  // DI.xml queries
  {
    id: 'di-1',
    query: 'preference interface implementation',
    type: 'semantic',
    expectedFileTypes: ['xml'],
    expectedInContent: ['preference'],
    category: 'di'
  },
  {
    id: 'di-2',
    query: 'plugin configuration di.xml',
    type: 'semantic',
    expectedFileTypes: ['xml'],
    expectedInContent: ['plugin'],
    category: 'di'
  },
  {
    id: 'di-3',
    query: 'virtualType argument',
    type: 'semantic',
    expectedInContent: ['virtualType'],
    category: 'di'
  },

  // Events.xml queries
  {
    id: 'event-1',
    query: 'event observer configuration',
    type: 'semantic',
    expectedFileTypes: ['xml'],
    expectedInContent: ['event', 'observer'],
    category: 'events'
  },
  {
    id: 'event-2',
    query: 'catalog_product_save_after event config',
    type: 'exact',
    expectedInContent: ['catalog_product_save_after'],
    category: 'events'
  },

  // Web API queries
  {
    id: 'api-1',
    query: 'REST API endpoint route',
    type: 'semantic',
    expectedFileTypes: ['xml'],
    expectedInContent: ['route', 'service'],
    category: 'webapi'
  },
  {
    id: 'api-2',
    query: 'GET /V1/items',
    type: 'semantic',
    expectedInContent: ['GET', '/V1/'],
    category: 'webapi'
  },

  // GraphQL queries
  {
    id: 'gql-1',
    query: 'GraphQL resolver',
    type: 'semantic',
    expectedTypes: ['GraphQlResolver'],
    expectedPatterns: ['graphql_resolver'],
    category: 'graphql'
  },
  {
    id: 'gql-2',
    query: 'type Query mutation',
    type: 'semantic',
    expectedFileTypes: ['graphql'],
    expectedInContent: ['type', 'Query'],
    category: 'graphql'
  },
  {
    id: 'gql-3',
    query: 'ResolverInterface resolve Field',
    type: 'semantic',
    expectedInContent: ['ResolverInterface', 'resolve'],
    category: 'graphql'
  },

  // Cron queries
  {
    id: 'cron-1',
    query: 'cron job schedule execute',
    type: 'semantic',
    expectedTypes: ['Cron'],
    category: 'cron'
  },
  {
    id: 'cron-2',
    query: 'crontab.xml job instance',
    type: 'semantic',
    expectedFileTypes: ['xml'],
    expectedInContent: ['job', 'instance'],
    category: 'cron'
  },

  // Cross-cutting queries
  {
    id: 'cross-1',
    query: 'dependency injection constructor',
    type: 'semantic',
    expectedInContent: ['__construct'],
    minResults: 3,
    category: 'di_pattern'
  },
  {
    id: 'cross-2',
    query: 'LoggerInterface logging',
    type: 'semantic',
    expectedInContent: ['LoggerInterface', 'logger'],
    category: 'logging'
  },
  {
    id: 'cross-3',
    query: 'exception handling try catch',
    type: 'semantic',
    expectedInContent: ['Exception', 'throw'],
    category: 'error_handling'
  },

  // Module-specific queries
  {
    id: 'mod-1',
    query: 'Acme_Catalog module',
    type: 'module',
    expectedModule: 'Acme_Catalog',
    minResults: 3,
    category: 'module'
  },

  // Method-specific queries
  {
    id: 'method-1',
    query: 'function getById',
    type: 'method',
    expectedMethods: ['getById'],
    category: 'method'
  },
  {
    id: 'method-2',
    query: 'save method repository',
    type: 'method',
    expectedMethods: ['save'],
    category: 'method'
  }
];

export const QUERY_CATEGORIES = {
  controller: { weight: 1.0, description: 'Controller action detection' },
  model: { weight: 1.0, description: 'Model and lifecycle hooks' },
  repository: { weight: 1.2, description: 'Repository pattern detection' },
  plugin: { weight: 1.3, description: 'Plugin/interceptor detection' },
  observer: { weight: 1.2, description: 'Observer pattern detection' },
  block: { weight: 1.0, description: 'Block class detection' },
  di: { weight: 1.2, description: 'DI configuration detection' },
  events: { weight: 1.1, description: 'Event configuration detection' },
  webapi: { weight: 1.2, description: 'Web API route detection' },
  graphql: { weight: 1.3, description: 'GraphQL schema/resolver detection' },
  cron: { weight: 1.0, description: 'Cron job detection' },
  di_pattern: { weight: 0.8, description: 'DI pattern recognition' },
  logging: { weight: 0.7, description: 'Logging pattern recognition' },
  error_handling: { weight: 0.7, description: 'Error handling patterns' },
  module: { weight: 1.0, description: 'Module filtering' },
  method: { weight: 1.0, description: 'Method search' }
};

/**
 * Generate edge case queries for stress testing
 */
export function generateEdgeCaseQueries() {
  return [
    // Very short queries
    { id: 'edge-1', query: 'save', type: 'short', category: 'edge_short', minResults: 1, expectedMethods: ['save'] },
    { id: 'edge-2', query: 'get', type: 'short', category: 'edge_short', minResults: 1 },

    // Very long queries
    { id: 'edge-3', query: 'public function execute action controller', type: 'long', category: 'edge_long', minResults: 1, expectedPatterns: ['controller'] },

    // Technical jargon
    { id: 'edge-4', query: 'CRUD operations repository interface', type: 'jargon', category: 'edge_jargon', minResults: 1, expectedTypes: ['Repository'] },

    // Magento-specific terms - lower expectations
    { id: 'edge-5', query: 'service contract API', type: 'magento_specific', category: 'edge_magento', minResults: 1 },

    // Negative queries (should return few/no results)
    { id: 'edge-6', query: 'wordpress drupal laravel', type: 'negative', category: 'edge_negative', maxResults: 2 },

    // Mixed case
    { id: 'edge-7', query: 'REPOSITORY getbyid SAVE', type: 'case', category: 'edge_case', minResults: 1, expectedTypes: ['Repository'] }
  ];
}
