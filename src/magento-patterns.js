/**
 * Magento-specific code patterns for high-precision indexing
 */

// Magento file type detection based on path
export const MAGENTO_FILE_TYPES = {
  // PHP patterns
  'Controller': /\/Controller\/.*\.php$/,
  'Block': /\/Block\/.*\.php$/,
  'Model': /\/Model\/(?!ResourceModel).*\.php$/,
  'ResourceModel': /\/Model\/ResourceModel\/.*\.php$/,
  'Collection': /\/Collection\.php$/,
  'Repository': /Repository\.php$/,
  'RepositoryInterface': /RepositoryInterface\.php$/,
  'Api': /\/Api\/.*Interface\.php$/,
  'ApiData': /\/Api\/Data\/.*\.php$/,
  'Plugin': /\/Plugin\/.*\.php$/,
  'Observer': /\/Observer\/.*\.php$/,
  'Helper': /\/Helper\/.*\.php$/,
  'Setup': /\/Setup\/.*\.php$/,
  'Console': /\/Console\/Command\/.*\.php$/,
  'Cron': /\/Cron\/.*\.php$/,
  'ViewModel': /\/ViewModel\/.*\.php$/,
  'GraphQlResolver': /\/Model\/Resolver\/.*\.php$/,
  'DataProvider': /\/DataProvider\/.*\.php$/,
  'UiComponent': /\/Ui\/.*\.php$/,

  // XML config patterns
  'di.xml': /\/etc\/.*di\.xml$/,
  'events.xml': /\/etc\/.*events\.xml$/,
  'routes.xml': /\/etc\/.*routes\.xml$/,
  'webapi.xml': /\/etc\/webapi\.xml$/,
  'system.xml': /\/etc\/adminhtml\/system\.xml$/,
  'config.xml': /\/etc\/config\.xml$/,
  'acl.xml': /\/etc\/acl\.xml$/,
  'crontab.xml': /\/etc\/crontab\.xml$/,
  'module.xml': /\/etc\/module\.xml$/,
  'db_schema.xml': /\/etc\/db_schema\.xml$/,
  'indexer.xml': /\/etc\/indexer\.xml$/,
  'mview.xml': /\/etc\/mview\.xml$/,
  'widget.xml': /\/etc\/widget\.xml$/,
  'layout.xml': /\/layout\/.*\.xml$/,
  'ui_component.xml': /\/ui_component\/.*\.xml$/,

  // Frontend
  'template': /\.phtml$/,
  'less': /\.less$/,
  'requirejs': /requirejs-config\.js$/,
  'knockout': /\/view\/.*\.html$/,

  // GraphQL
  'graphql_schema': /\.graphqls$/
};

// Magento-specific PHP patterns
export const PHP_PATTERNS = {
  // Plugin methods
  plugin: {
    before: /public\s+function\s+(before\w+)\s*\(/g,
    after: /public\s+function\s+(after\w+)\s*\(/g,
    around: /public\s+function\s+(around\w+)\s*\(/g
  },

  // Controller actions
  controller: {
    execute: /public\s+function\s+execute\s*\(\s*\)/,
    resultFactory: /\$this->resultFactory->create\s*\(\s*ResultFactory::TYPE_(\w+)/g
  },

  // Repository patterns
  repository: {
    getById: /public\s+function\s+getById\s*\(/,
    getList: /public\s+function\s+getList\s*\(/,
    save: /public\s+function\s+save\s*\(/,
    delete: /public\s+function\s+delete\s*\(/,
    deleteById: /public\s+function\s+deleteById\s*\(/
  },

  // Model patterns
  model: {
    beforeSave: /protected\s+function\s+_beforeSave\s*\(/,
    afterSave: /protected\s+function\s+_afterSave\s*\(/,
    beforeLoad: /protected\s+function\s+_beforeLoad\s*\(/,
    afterLoad: /protected\s+function\s+_afterLoad\s*\(/,
    construct: /protected\s+function\s+_construct\s*\(/
  },

  // Observer
  observer: {
    execute: /public\s+function\s+execute\s*\(\s*Observer\s+\$observer\s*\)/
  },

  // Block patterns
  block: {
    toHtml: /protected\s+function\s+_toHtml\s*\(/,
    prepareLayout: /protected\s+function\s+_prepareLayout\s*\(/,
    beforeToHtml: /protected\s+function\s+_beforeToHtml\s*\(/
  },

  // GraphQL Resolver
  resolver: {
    resolve: /public\s+function\s+resolve\s*\(\s*Field\s+\$field/
  },

  // Setup scripts
  setup: {
    install: /public\s+function\s+install\s*\(/,
    upgrade: /public\s+function\s+upgrade\s*\(/,
    apply: /public\s+function\s+apply\s*\(/
  },

  // Console command
  console: {
    configure: /protected\s+function\s+configure\s*\(/,
    execute: /protected\s+function\s+execute\s*\(\s*InputInterface/
  },

  // Data provider
  dataProvider: {
    getData: /public\s+function\s+getData\s*\(/,
    getMeta: /public\s+function\s+getMeta\s*\(/
  }
};

// XML config patterns
export const XML_PATTERNS = {
  // di.xml
  di: {
    preference: /<preference\s+for="([^"]+)"\s+type="([^"]+)"/g,
    virtualType: /<virtualType\s+name="([^"]+)"\s+type="([^"]+)"/g,
    plugin: /<plugin\s+name="([^"]+)"[^>]*type="([^"]+)"/g,
    type: /<type\s+name="([^"]+)"/g,
    argument: /<argument\s+name="([^"]+)"\s+xsi:type="([^"]+)"/g
  },

  // events.xml
  events: {
    event: /<event\s+name="([^"]+)"/g,
    observer: /<observer\s+name="([^"]+)"[^>]*instance="([^"]+)"/g
  },

  // layout.xml
  layout: {
    block: /<block\s+[^>]*class="([^"]+)"/g,
    container: /<container\s+name="([^"]+)"/g,
    referenceBlock: /<referenceBlock\s+name="([^"]+)"/g,
    referenceContainer: /<referenceContainer\s+name="([^"]+)"/g,
    uiComponent: /<uiComponent\s+name="([^"]+)"/g
  },

  // webapi.xml
  webapi: {
    route: /<route\s+url="([^"]+)"\s+method="([^"]+)"/g,
    service: /<service\s+class="([^"]+)"\s+method="([^"]+)"/g,
    resource: /<resource\s+ref="([^"]+)"/g
  },

  // system.xml
  system: {
    section: /<section\s+id="([^"]+)"/g,
    group: /<group\s+id="([^"]+)"/g,
    field: /<field\s+id="([^"]+)"/g,
    sourceModel: /<source_model>([^<]+)<\/source_model>/g,
    backendModel: /<backend_model>([^<]+)<\/backend_model>/g
  },

  // db_schema.xml
  dbSchema: {
    table: /<table\s+name="([^"]+)"/g,
    column: /<column\s+[^>]*name="([^"]+)"/g,
    constraint: /<constraint\s+[^>]*referenceId="([^"]+)"/g,
    index: /<index\s+[^>]*referenceId="([^"]+)"/g
  },

  // acl.xml
  acl: {
    resource: /<resource\s+id="([^"]+)"/g
  },

  // crontab.xml
  crontab: {
    job: /<job\s+name="([^"]+)"[^>]*instance="([^"]+)"/g,
    schedule: /<schedule>([^<]+)<\/schedule>/g
  }
};

// GraphQL schema patterns
export const GRAPHQL_PATTERNS = {
  type: /type\s+(\w+)\s*(?:implements\s+[\w\s,&]+)?\s*\{/g,
  interface: /interface\s+(\w+)\s*\{/g,
  input: /input\s+(\w+)\s*\{/g,
  enum: /enum\s+(\w+)\s*\{/g,
  query: /(\w+)\s*\([^)]*\)\s*:\s*([\w\[\]!]+)/g,
  mutation: /(\w+)\s*\([^)]*\)\s*:\s*([\w\[\]!]+)/g,
  resolver: /@resolver\s*\(\s*class:\s*"([^"]+)"/g
};

// Magento module areas
export const AREAS = ['frontend', 'adminhtml', 'webapi_rest', 'webapi_soap', 'graphql', 'crontab', 'global'];

// Common Magento interfaces
export const CORE_INTERFACES = {
  'Magento\\Framework\\App\\ActionInterface': 'Controller',
  'Magento\\Framework\\View\\Element\\BlockInterface': 'Block',
  'Magento\\Framework\\Model\\AbstractModel': 'Model',
  'Magento\\Framework\\Model\\ResourceModel\\AbstractResource': 'ResourceModel',
  'Magento\\Framework\\Data\\Collection\\AbstractDb': 'Collection',
  'Magento\\Framework\\Event\\ObserverInterface': 'Observer',
  'Magento\\Framework\\Interception\\InterceptorInterface': 'Plugin',
  'Magento\\Framework\\Api\\SearchCriteriaInterface': 'SearchCriteria',
  'Magento\\Framework\\Api\\ExtensibleDataInterface': 'DataInterface',
  'Magento\\Framework\\GraphQl\\Query\\ResolverInterface': 'GraphQlResolver',
  'Magento\\Framework\\Setup\\InstallSchemaInterface': 'InstallSchema',
  'Magento\\Framework\\Setup\\UpgradeSchemaInterface': 'UpgradeSchema',
  'Magento\\Framework\\Setup\\Patch\\DataPatchInterface': 'DataPatch',
  'Magento\\Framework\\Setup\\Patch\\SchemaPatchInterface': 'SchemaPatch',
  'Magento\\Framework\\Console\\Cli': 'ConsoleCommand',
  'Magento\\Ui\\DataProvider\\AbstractDataProvider': 'UiDataProvider'
};

/**
 * Detect Magento-specific file type from path
 */
export function detectMagentoFileType(filePath) {
  for (const [type, pattern] of Object.entries(MAGENTO_FILE_TYPES)) {
    if (pattern.test(filePath)) {
      return type;
    }
  }
  return null;
}

/**
 * Extract Magento-specific metadata from PHP content
 */
export function extractPhpMagentoMetadata(content, filePath) {
  const metadata = {
    magentoType: detectMagentoFileType(filePath),
    patterns: []
  };

  // Detect plugin methods
  for (const [method, pattern] of Object.entries(PHP_PATTERNS.plugin)) {
    const matches = [...content.matchAll(pattern)];
    if (matches.length > 0) {
      metadata.isPlugin = true;
      metadata.pluginMethods = matches.map(m => ({ type: method, name: m[1] }));
      metadata.patterns.push('plugin');
    }
  }

  // Detect controller
  if (PHP_PATTERNS.controller.execute.test(content)) {
    metadata.isController = true;
    metadata.patterns.push('controller');

    const resultTypes = [...content.matchAll(PHP_PATTERNS.controller.resultFactory)];
    if (resultTypes.length > 0) {
      metadata.resultTypes = resultTypes.map(m => m[1]);
    }
  }

  // Detect repository pattern
  const repoMethods = [];
  for (const [method, pattern] of Object.entries(PHP_PATTERNS.repository)) {
    if (pattern.test(content)) {
      repoMethods.push(method);
    }
  }
  if (repoMethods.length >= 2) {
    metadata.isRepository = true;
    metadata.repositoryMethods = repoMethods;
    metadata.patterns.push('repository');
  }

  // Detect model hooks
  const modelHooks = [];
  for (const [hook, pattern] of Object.entries(PHP_PATTERNS.model)) {
    if (pattern.test(content)) {
      modelHooks.push(hook);
    }
  }
  if (modelHooks.length > 0) {
    metadata.isModel = true;
    metadata.modelHooks = modelHooks;
    metadata.patterns.push('model');
  }

  // Detect observer
  if (PHP_PATTERNS.observer.execute.test(content)) {
    metadata.isObserver = true;
    metadata.patterns.push('observer');
  }

  // Detect block
  for (const [method, pattern] of Object.entries(PHP_PATTERNS.block)) {
    if (pattern.test(content)) {
      metadata.isBlock = true;
      metadata.patterns.push('block');
      break;
    }
  }

  // Detect GraphQL resolver
  if (PHP_PATTERNS.resolver.resolve.test(content)) {
    metadata.isResolver = true;
    metadata.patterns.push('graphql_resolver');
  }

  // Detect setup script
  for (const [type, pattern] of Object.entries(PHP_PATTERNS.setup)) {
    if (pattern.test(content)) {
      metadata.isSetup = true;
      metadata.setupType = type;
      metadata.patterns.push('setup');
      break;
    }
  }

  // Detect console command
  if (PHP_PATTERNS.console.configure.test(content)) {
    metadata.isConsoleCommand = true;
    metadata.patterns.push('console');
  }

  // Detect data provider
  if (PHP_PATTERNS.dataProvider.getData.test(content)) {
    metadata.isDataProvider = true;
    metadata.patterns.push('data_provider');
  }

  // Extract injected dependencies
  const constructorMatch = content.match(/function\s+__construct\s*\(([^)]*)\)/s);
  if (constructorMatch) {
    const deps = [];
    const depRegex = /([\w\\]+(?:Interface)?)\s+\$(\w+)/g;
    let match;
    while ((match = depRegex.exec(constructorMatch[1])) !== null) {
      const fullType = match[1];
      const shortType = fullType.split('\\').pop();
      deps.push({
        type: shortType,
        fullType: fullType.includes('\\') ? fullType : null,
        variable: match[2]
      });
    }
    if (deps.length > 0) {
      metadata.dependencies = deps;
      metadata.dependencyCount = deps.length;
    }
  }

  return metadata;
}

/**
 * Extract Magento-specific metadata from XML content
 */
export function extractXmlMagentoMetadata(content, filePath) {
  const metadata = {
    magentoType: detectMagentoFileType(filePath),
    configItems: []
  };

  // di.xml parsing
  if (filePath.includes('di.xml')) {
    const preferences = [...content.matchAll(XML_PATTERNS.di.preference)];
    if (preferences.length > 0) {
      metadata.preferences = preferences.map(m => ({ for: m[1], type: m[2] }));
      metadata.configItems.push(...metadata.preferences.map(p => `preference:${p.for}`));
    }

    const virtualTypes = [...content.matchAll(XML_PATTERNS.di.virtualType)];
    if (virtualTypes.length > 0) {
      metadata.virtualTypes = virtualTypes.map(m => ({ name: m[1], type: m[2] }));
      metadata.configItems.push(...metadata.virtualTypes.map(v => `virtualType:${v.name}`));
    }

    const plugins = [...content.matchAll(XML_PATTERNS.di.plugin)];
    if (plugins.length > 0) {
      metadata.plugins = plugins.map(m => ({ name: m[1], type: m[2] }));
      metadata.configItems.push(...metadata.plugins.map(p => `plugin:${p.name}`));
    }

    const types = [...content.matchAll(XML_PATTERNS.di.type)];
    if (types.length > 0) {
      metadata.types = types.map(m => m[1]);
    }
  }

  // events.xml parsing
  if (filePath.includes('events.xml')) {
    const events = [...content.matchAll(XML_PATTERNS.events.event)];
    if (events.length > 0) {
      metadata.events = events.map(m => m[1]);
      metadata.configItems.push(...metadata.events.map(e => `event:${e}`));
    }

    const observers = [...content.matchAll(XML_PATTERNS.events.observer)];
    if (observers.length > 0) {
      metadata.observers = observers.map(m => ({ name: m[1], instance: m[2] }));
    }
  }

  // webapi.xml parsing
  if (filePath.includes('webapi.xml')) {
    const routes = [...content.matchAll(XML_PATTERNS.webapi.route)];
    if (routes.length > 0) {
      metadata.apiRoutes = routes.map(m => ({ url: m[1], method: m[2] }));
      metadata.configItems.push(...metadata.apiRoutes.map(r => `api:${r.method}:${r.url}`));
    }

    const services = [...content.matchAll(XML_PATTERNS.webapi.service)];
    if (services.length > 0) {
      metadata.apiServices = services.map(m => ({ class: m[1], method: m[2] }));
    }
  }

  // layout.xml parsing
  if (filePath.includes('/layout/')) {
    const blocks = [...content.matchAll(XML_PATTERNS.layout.block)];
    if (blocks.length > 0) {
      metadata.blocks = blocks.map(m => m[1]);
      metadata.configItems.push(...metadata.blocks.map(b => `block:${b.split('\\').pop()}`));
    }

    const uiComponents = [...content.matchAll(XML_PATTERNS.layout.uiComponent)];
    if (uiComponents.length > 0) {
      metadata.uiComponents = uiComponents.map(m => m[1]);
    }
  }

  // system.xml parsing
  if (filePath.includes('system.xml')) {
    const sections = [...content.matchAll(XML_PATTERNS.system.section)];
    const groups = [...content.matchAll(XML_PATTERNS.system.group)];
    const fields = [...content.matchAll(XML_PATTERNS.system.field)];

    if (sections.length > 0) metadata.configSections = sections.map(m => m[1]);
    if (groups.length > 0) metadata.configGroups = groups.map(m => m[1]);
    if (fields.length > 0) {
      metadata.configFields = fields.map(m => m[1]);
      metadata.configItems.push(...metadata.configFields.map(f => `config:${f}`));
    }
  }

  // db_schema.xml parsing
  if (filePath.includes('db_schema.xml')) {
    const tables = [...content.matchAll(XML_PATTERNS.dbSchema.table)];
    if (tables.length > 0) {
      metadata.tables = tables.map(m => m[1]);
      metadata.configItems.push(...metadata.tables.map(t => `table:${t}`));
    }

    const columns = [...content.matchAll(XML_PATTERNS.dbSchema.column)];
    if (columns.length > 0) {
      metadata.columns = columns.map(m => m[1]);
    }
  }

  // crontab.xml parsing
  if (filePath.includes('crontab.xml')) {
    const jobs = [...content.matchAll(XML_PATTERNS.crontab.job)];
    if (jobs.length > 0) {
      metadata.cronJobs = jobs.map(m => ({ name: m[1], instance: m[2] }));
      metadata.configItems.push(...metadata.cronJobs.map(j => `cron:${j.name}`));
    }
  }

  // acl.xml parsing
  if (filePath.includes('acl.xml')) {
    const resources = [...content.matchAll(XML_PATTERNS.acl.resource)];
    if (resources.length > 0) {
      metadata.aclResources = resources.map(m => m[1]);
      metadata.configItems.push(...metadata.aclResources.map(r => `acl:${r}`));
    }
  }

  return metadata;
}

/**
 * Extract GraphQL schema metadata
 */
export function extractGraphqlMetadata(content, filePath) {
  const metadata = {
    magentoType: 'graphql_schema',
    types: [],
    interfaces: [],
    inputs: [],
    enums: [],
    queries: [],
    mutations: [],
    resolvers: []
  };

  const types = [...content.matchAll(GRAPHQL_PATTERNS.type)];
  metadata.types = types.map(m => m[1]);

  const interfaces = [...content.matchAll(GRAPHQL_PATTERNS.interface)];
  metadata.interfaces = interfaces.map(m => m[1]);

  const inputs = [...content.matchAll(GRAPHQL_PATTERNS.input)];
  metadata.inputs = inputs.map(m => m[1]);

  const enums = [...content.matchAll(GRAPHQL_PATTERNS.enum)];
  metadata.enums = enums.map(m => m[1]);

  const resolvers = [...content.matchAll(GRAPHQL_PATTERNS.resolver)];
  metadata.resolvers = resolvers.map(m => m[1]);

  // Extract queries from Query type
  const queryBlock = content.match(/type\s+Query\s*\{([^}]+)\}/s);
  if (queryBlock) {
    const queries = [...queryBlock[1].matchAll(/(\w+)\s*\(/g)];
    metadata.queries = queries.map(m => m[1]);
  }

  // Extract mutations from Mutation type
  const mutationBlock = content.match(/type\s+Mutation\s*\{([^}]+)\}/s);
  if (mutationBlock) {
    const mutations = [...mutationBlock[1].matchAll(/(\w+)\s*\(/g)];
    metadata.mutations = mutations.map(m => m[1]);
  }

  return metadata;
}

/**
 * Get Magento area from file path
 */
export function detectArea(filePath) {
  if (filePath.includes('/adminhtml/')) return 'adminhtml';
  if (filePath.includes('/frontend/')) return 'frontend';
  if (filePath.includes('/webapi_rest/')) return 'webapi_rest';
  if (filePath.includes('/webapi_soap/')) return 'webapi_soap';
  if (filePath.includes('/graphql/')) return 'graphql';
  if (filePath.includes('/crontab/')) return 'crontab';
  return 'global';
}

/**
 * Extract module vendor and name from path
 */
export function extractModuleInfo(filePath) {
  // app/code/Vendor/Module
  const appMatch = filePath.match(/app\/code\/(\w+)\/(\w+)/);
  if (appMatch) {
    return { vendor: appMatch[1], module: appMatch[2], full: `${appMatch[1]}_${appMatch[2]}` };
  }

  // vendor/vendor/module-name
  const vendorMatch = filePath.match(/vendor\/([\w-]+)\/(module-[\w-]+)/);
  if (vendorMatch) {
    const vendor = vendorMatch[1].replace(/-/g, '');
    const module = vendorMatch[2].replace('module-', '').split('-').map(
      s => s.charAt(0).toUpperCase() + s.slice(1)
    ).join('');
    return { vendor, module, full: `${vendor}_${module}` };
  }

  return null;
}
