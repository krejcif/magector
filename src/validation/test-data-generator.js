/**
 * Generates synthetic Magento code for validation testing
 */

export const MOCK_MODULES = [
  'Acme_Catalog',
  'Acme_Checkout',
  'Acme_Customer',
  'Acme_Sales',
  'Acme_Inventory'
];

export function generateMockController(moduleName, controllerName, action = 'execute') {
  const [vendor, module] = moduleName.split('_');
  return {
    path: `app/code/${vendor}/${module}/Controller/${controllerName}.php`,
    content: `<?php
declare(strict_types=1);

namespace ${vendor}\\${module}\\Controller;

use Magento\\Framework\\App\\Action\\HttpGetActionInterface;
use Magento\\Framework\\Controller\\ResultFactory;
use Magento\\Framework\\View\\Result\\Page;

/**
 * ${controllerName} controller action
 */
class ${controllerName} implements HttpGetActionInterface
{
    private ResultFactory \$resultFactory;

    public function __construct(
        ResultFactory \$resultFactory
    ) {
        \$this->resultFactory = \$resultFactory;
    }

    /**
     * Execute action
     * @return Page
     */
    public function ${action}(): Page
    {
        /** @var Page \$page */
        \$page = \$this->resultFactory->create(ResultFactory::TYPE_PAGE);
        return \$page;
    }
}
`,
    metadata: {
      type: 'php',
      magentoType: 'Controller',
      module: moduleName,
      className: controllerName,
      methodName: action,
      isController: true
    }
  };
}

export function generateMockModel(moduleName, modelName, tableName) {
  const [vendor, module] = moduleName.split('_');
  return {
    path: `app/code/${vendor}/${module}/Model/${modelName}.php`,
    content: `<?php
declare(strict_types=1);

namespace ${vendor}\\${module}\\Model;

use Magento\\Framework\\Model\\AbstractModel;
use ${vendor}\\${module}\\Model\\ResourceModel\\${modelName} as ResourceModel;

/**
 * ${modelName} model
 */
class ${modelName} extends AbstractModel
{
    protected \$_eventPrefix = '${tableName}';

    protected function _construct(): void
    {
        \$this->_init(ResourceModel::class);
    }

    protected function _beforeSave(): AbstractModel
    {
        // Custom before save logic
        return parent::_beforeSave();
    }

    protected function _afterLoad(): AbstractModel
    {
        // Custom after load logic
        return parent::_afterLoad();
    }

    public function getName(): ?string
    {
        return \$this->getData('name');
    }

    public function setName(string \$name): self
    {
        return \$this->setData('name', \$name);
    }
}
`,
    metadata: {
      type: 'php',
      magentoType: 'Model',
      module: moduleName,
      className: modelName,
      isModel: true,
      tableName
    }
  };
}

export function generateMockRepository(moduleName, entityName) {
  const [vendor, module] = moduleName.split('_');
  return {
    path: `app/code/${vendor}/${module}/Model/${entityName}Repository.php`,
    content: `<?php
declare(strict_types=1);

namespace ${vendor}\\${module}\\Model;

use ${vendor}\\${module}\\Api\\${entityName}RepositoryInterface;
use ${vendor}\\${module}\\Api\\Data\\${entityName}Interface;
use ${vendor}\\${module}\\Model\\ResourceModel\\${entityName} as ResourceModel;
use Magento\\Framework\\Api\\SearchCriteriaInterface;
use Magento\\Framework\\Api\\SearchResultsInterface;
use Magento\\Framework\\Exception\\CouldNotSaveException;
use Magento\\Framework\\Exception\\NoSuchEntityException;

/**
 * ${entityName} repository implementation
 */
class ${entityName}Repository implements ${entityName}RepositoryInterface
{
    private ResourceModel \$resourceModel;
    private ${entityName}Factory \$${entityName.toLowerCase()}Factory;

    public function __construct(
        ResourceModel \$resourceModel,
        ${entityName}Factory \$${entityName.toLowerCase()}Factory
    ) {
        \$this->resourceModel = \$resourceModel;
        \$this->${entityName.toLowerCase()}Factory = \$${entityName.toLowerCase()}Factory;
    }

    public function getById(int \$id): ${entityName}Interface
    {
        \$entity = \$this->${entityName.toLowerCase()}Factory->create();
        \$this->resourceModel->load(\$entity, \$id);
        if (!\$entity->getId()) {
            throw new NoSuchEntityException(__('Entity with id "%1" does not exist.', \$id));
        }
        return \$entity;
    }

    public function save(${entityName}Interface \$entity): ${entityName}Interface
    {
        try {
            \$this->resourceModel->save(\$entity);
        } catch (\\Exception \$e) {
            throw new CouldNotSaveException(__(\$e->getMessage()));
        }
        return \$entity;
    }

    public function delete(${entityName}Interface \$entity): bool
    {
        \$this->resourceModel->delete(\$entity);
        return true;
    }

    public function deleteById(int \$id): bool
    {
        return \$this->delete(\$this->getById(\$id));
    }

    public function getList(SearchCriteriaInterface \$searchCriteria): SearchResultsInterface
    {
        // Implementation
    }
}
`,
    metadata: {
      type: 'php',
      magentoType: 'Repository',
      module: moduleName,
      className: `${entityName}Repository`,
      isRepository: true,
      repositoryMethods: ['getById', 'save', 'delete', 'deleteById', 'getList']
    }
  };
}

export function generateMockPlugin(moduleName, targetClass, targetMethod) {
  const [vendor, module] = moduleName.split('_');
  const pluginName = `${targetClass}${targetMethod.charAt(0).toUpperCase() + targetMethod.slice(1)}Plugin`;
  return {
    path: `app/code/${vendor}/${module}/Plugin/${pluginName}.php`,
    content: `<?php
declare(strict_types=1);

namespace ${vendor}\\${module}\\Plugin;

use ${targetClass.includes('\\') ? targetClass : `Magento\\Framework\\${targetClass}`};

/**
 * Plugin for ${targetClass}::${targetMethod}
 */
class ${pluginName}
{
    /**
     * Before ${targetMethod}
     */
    public function before${targetMethod.charAt(0).toUpperCase() + targetMethod.slice(1)}(
        ${targetClass.split('\\').pop()} \$subject,
        ...\$args
    ): array {
        // Modify arguments before method execution
        return \$args;
    }

    /**
     * After ${targetMethod}
     */
    public function after${targetMethod.charAt(0).toUpperCase() + targetMethod.slice(1)}(
        ${targetClass.split('\\').pop()} \$subject,
        \$result
    ) {
        // Modify result after method execution
        return \$result;
    }

    /**
     * Around ${targetMethod}
     */
    public function around${targetMethod.charAt(0).toUpperCase() + targetMethod.slice(1)}(
        ${targetClass.split('\\').pop()} \$subject,
        callable \$proceed,
        ...\$args
    ) {
        // Execute before
        \$result = \$proceed(...\$args);
        // Execute after
        return \$result;
    }
}
`,
    metadata: {
      type: 'php',
      magentoType: 'Plugin',
      module: moduleName,
      className: pluginName,
      isPlugin: true,
      targetClass,
      targetMethod,
      pluginMethods: [
        { type: 'before', name: `before${targetMethod.charAt(0).toUpperCase() + targetMethod.slice(1)}` },
        { type: 'after', name: `after${targetMethod.charAt(0).toUpperCase() + targetMethod.slice(1)}` },
        { type: 'around', name: `around${targetMethod.charAt(0).toUpperCase() + targetMethod.slice(1)}` }
      ]
    }
  };
}

export function generateMockObserver(moduleName, eventName, observerName) {
  const [vendor, module] = moduleName.split('_');
  return {
    path: `app/code/${vendor}/${module}/Observer/${observerName}.php`,
    content: `<?php
declare(strict_types=1);

namespace ${vendor}\\${module}\\Observer;

use Magento\\Framework\\Event\\Observer;
use Magento\\Framework\\Event\\ObserverInterface;
use Psr\\Log\\LoggerInterface;

/**
 * Observer for ${eventName} event
 */
class ${observerName} implements ObserverInterface
{
    private LoggerInterface \$logger;

    public function __construct(LoggerInterface \$logger)
    {
        \$this->logger = \$logger;
    }

    /**
     * Execute observer
     * @param Observer \$observer
     * @return void
     */
    public function execute(Observer \$observer): void
    {
        \$event = \$observer->getEvent();
        \$this->logger->info('Event ${eventName} triggered');
        // Observer logic here
    }
}
`,
    metadata: {
      type: 'php',
      magentoType: 'Observer',
      module: moduleName,
      className: observerName,
      isObserver: true,
      eventName
    }
  };
}

export function generateMockDiXml(moduleName, configs) {
  const [vendor, module] = moduleName.split('_');
  let content = `<?xml version="1.0"?>
<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:noNamespaceSchemaLocation="urn:magento:framework:ObjectManager/etc/config.xsd">
`;

  for (const config of configs) {
    if (config.type === 'preference') {
      content += `    <preference for="${config.for}" type="${config.implementation}" />\n`;
    } else if (config.type === 'plugin') {
      content += `    <type name="${config.target}">
        <plugin name="${config.name}" type="${config.class}" sortOrder="${config.sortOrder || 10}" />
    </type>\n`;
    } else if (config.type === 'virtualType') {
      content += `    <virtualType name="${config.name}" type="${config.extends}">
        <arguments>
            <argument name="${config.argName}" xsi:type="string">${config.argValue}</argument>
        </arguments>
    </virtualType>\n`;
    }
  }

  content += `</config>`;

  return {
    path: `app/code/${vendor}/${module}/etc/di.xml`,
    content,
    metadata: {
      type: 'xml',
      magentoType: 'di.xml',
      module: moduleName,
      preferences: configs.filter(c => c.type === 'preference'),
      plugins: configs.filter(c => c.type === 'plugin'),
      virtualTypes: configs.filter(c => c.type === 'virtualType')
    }
  };
}

export function generateMockEventsXml(moduleName, events) {
  const [vendor, module] = moduleName.split('_');
  let content = `<?xml version="1.0"?>
<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:noNamespaceSchemaLocation="urn:magento:framework:Event/etc/events.xsd">
`;

  for (const event of events) {
    content += `    <event name="${event.name}">
        <observer name="${event.observerName}" instance="${vendor}\\${module}\\Observer\\${event.observerClass}" />
    </event>\n`;
  }

  content += `</config>`;

  return {
    path: `app/code/${vendor}/${module}/etc/events.xml`,
    content,
    metadata: {
      type: 'xml',
      magentoType: 'events.xml',
      module: moduleName,
      events: events.map(e => e.name),
      observers: events.map(e => ({ name: e.observerName, instance: `${vendor}\\${module}\\Observer\\${e.observerClass}` }))
    }
  };
}

export function generateMockWebApiXml(moduleName, routes) {
  const [vendor, module] = moduleName.split('_');
  let content = `<?xml version="1.0"?>
<routes xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:noNamespaceSchemaLocation="urn:magento:module:Magento_Webapi:etc/webapi.xsd">
`;

  for (const route of routes) {
    content += `    <route url="${route.url}" method="${route.method}">
        <service class="${vendor}\\${module}\\Api\\${route.serviceClass}" method="${route.serviceMethod}" />
        <resources>
            <resource ref="${route.resource || 'anonymous'}" />
        </resources>
    </route>\n`;
  }

  content += `</routes>`;

  return {
    path: `app/code/${vendor}/${module}/etc/webapi.xml`,
    content,
    metadata: {
      type: 'xml',
      magentoType: 'webapi.xml',
      module: moduleName,
      apiRoutes: routes.map(r => ({ url: r.url, method: r.method })),
      apiServices: routes.map(r => ({ class: `${vendor}\\${module}\\Api\\${r.serviceClass}`, method: r.serviceMethod }))
    }
  };
}

export function generateMockGraphqlSchema(moduleName, types, queries, mutations) {
  const [vendor, module] = moduleName.split('_');
  let content = '';

  for (const type of types) {
    content += `type ${type.name} ${type.implements ? `implements ${type.implements}` : ''} {
${type.fields.map(f => `    ${f.name}: ${f.type}`).join('\n')}
}\n\n`;
  }

  if (queries.length > 0) {
    content += `type Query {\n`;
    for (const q of queries) {
      content += `    ${q.name}(${q.args || ''}): ${q.returnType} @resolver(class: "${vendor}\\\\${module}\\\\Model\\\\Resolver\\\\${q.resolver}")\n`;
    }
    content += `}\n\n`;
  }

  if (mutations.length > 0) {
    content += `type Mutation {\n`;
    for (const m of mutations) {
      content += `    ${m.name}(${m.args || ''}): ${m.returnType} @resolver(class: "${vendor}\\\\${module}\\\\Model\\\\Resolver\\\\${m.resolver}")\n`;
    }
    content += `}\n`;
  }

  return {
    path: `app/code/${vendor}/${module}/etc/schema.graphqls`,
    content,
    metadata: {
      type: 'graphql',
      magentoType: 'graphql_schema',
      module: moduleName,
      types: types.map(t => t.name),
      queries: queries.map(q => q.name),
      mutations: mutations.map(m => m.name),
      resolvers: [...queries, ...mutations].map(x => x.resolver)
    }
  };
}

export function generateMockResolver(moduleName, resolverName, queryName) {
  const [vendor, module] = moduleName.split('_');
  return {
    path: `app/code/${vendor}/${module}/Model/Resolver/${resolverName}.php`,
    content: `<?php
declare(strict_types=1);

namespace ${vendor}\\${module}\\Model\\Resolver;

use Magento\\Framework\\GraphQl\\Config\\Element\\Field;
use Magento\\Framework\\GraphQl\\Query\\ResolverInterface;
use Magento\\Framework\\GraphQl\\Schema\\Type\\ResolveInfo;

/**
 * GraphQL resolver for ${queryName}
 */
class ${resolverName} implements ResolverInterface
{
    /**
     * @inheritdoc
     */
    public function resolve(
        Field \$field,
        \$context,
        ResolveInfo \$info,
        array \$value = null,
        array \$args = null
    ) {
        // Resolver implementation
        return [];
    }
}
`,
    metadata: {
      type: 'php',
      magentoType: 'GraphQlResolver',
      module: moduleName,
      className: resolverName,
      isResolver: true,
      queryName
    }
  };
}

export function generateMockBlock(moduleName, blockName) {
  const [vendor, module] = moduleName.split('_');
  return {
    path: `app/code/${vendor}/${module}/Block/${blockName}.php`,
    content: `<?php
declare(strict_types=1);

namespace ${vendor}\\${module}\\Block;

use Magento\\Framework\\View\\Element\\Template;
use Magento\\Framework\\View\\Element\\Template\\Context;

/**
 * ${blockName} block
 */
class ${blockName} extends Template
{
    protected \$_template = '${vendor}_${module}::${blockName.toLowerCase()}.phtml';

    public function __construct(Context \$context, array \$data = [])
    {
        parent::__construct(\$context, \$data);
    }

    protected function _prepareLayout(): self
    {
        parent::_prepareLayout();
        return \$this;
    }

    protected function _toHtml(): string
    {
        return parent::_toHtml();
    }

    public function getItems(): array
    {
        return [];
    }
}
`,
    metadata: {
      type: 'php',
      magentoType: 'Block',
      module: moduleName,
      className: blockName,
      isBlock: true
    }
  };
}

export function generateMockCronJob(moduleName, cronName, schedule = '0 * * * *') {
  const [vendor, module] = moduleName.split('_');
  return {
    php: {
      path: `app/code/${vendor}/${module}/Cron/${cronName}.php`,
      content: `<?php
declare(strict_types=1);

namespace ${vendor}\\${module}\\Cron;

use Psr\\Log\\LoggerInterface;

/**
 * ${cronName} cron job
 */
class ${cronName}
{
    private LoggerInterface \$logger;

    public function __construct(LoggerInterface \$logger)
    {
        \$this->logger = \$logger;
    }

    public function execute(): void
    {
        \$this->logger->info('Cron job ${cronName} executed');
        // Cron logic here
    }
}
`,
      metadata: {
        type: 'php',
        magentoType: 'Cron',
        module: moduleName,
        className: cronName,
        isCron: true
      }
    },
    xml: {
      path: `app/code/${vendor}/${module}/etc/crontab.xml`,
      content: `<?xml version="1.0"?>
<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:noNamespaceSchemaLocation="urn:magento:module:Magento_Cron:etc/crontab.xsd">
    <group id="default">
        <job name="${vendor.toLowerCase()}_${module.toLowerCase()}_${cronName.toLowerCase()}"
             instance="${vendor}\\${module}\\Cron\\${cronName}"
             method="execute">
            <schedule>${schedule}</schedule>
        </job>
    </group>
</config>`,
      metadata: {
        type: 'xml',
        magentoType: 'crontab.xml',
        module: moduleName,
        cronJobs: [{ name: `${vendor.toLowerCase()}_${module.toLowerCase()}_${cronName.toLowerCase()}`, instance: `${vendor}\\${module}\\Cron\\${cronName}` }]
      }
    }
  };
}

/**
 * Generate a complete mock module with all components
 */
export function generateCompleteMockModule(moduleName) {
  const [vendor, module] = moduleName.split('_');
  const files = [];

  // Controllers
  files.push(generateMockController(moduleName, 'Index', 'execute'));
  files.push(generateMockController(moduleName, 'View', 'execute'));

  // Models
  files.push(generateMockModel(moduleName, 'Item', `${vendor.toLowerCase()}_${module.toLowerCase()}_item`));
  files.push(generateMockRepository(moduleName, 'Item'));

  // Plugin
  files.push(generateMockPlugin(moduleName, 'Magento\\Catalog\\Model\\Product', 'getPrice'));

  // Observer
  files.push(generateMockObserver(moduleName, 'catalog_product_save_after', 'ProductSaveObserver'));

  // Block
  files.push(generateMockBlock(moduleName, 'ItemList'));

  // DI config
  files.push(generateMockDiXml(moduleName, [
    { type: 'preference', for: `${vendor}\\${module}\\Api\\ItemRepositoryInterface`, implementation: `${vendor}\\${module}\\Model\\ItemRepository` },
    { type: 'plugin', target: 'Magento\\Catalog\\Model\\Product', name: `${vendor.toLowerCase()}_${module.toLowerCase()}_product_price`, class: `${vendor}\\${module}\\Plugin\\ProductGetPricePlugin` }
  ]));

  // Events
  files.push(generateMockEventsXml(moduleName, [
    { name: 'catalog_product_save_after', observerName: `${vendor.toLowerCase()}_product_save`, observerClass: 'ProductSaveObserver' }
  ]));

  // Web API
  files.push(generateMockWebApiXml(moduleName, [
    { url: `/V1/${module.toLowerCase()}/items/:id`, method: 'GET', serviceClass: 'ItemRepositoryInterface', serviceMethod: 'getById' },
    { url: `/V1/${module.toLowerCase()}/items`, method: 'POST', serviceClass: 'ItemRepositoryInterface', serviceMethod: 'save' }
  ]));

  // GraphQL
  files.push(generateMockGraphqlSchema(moduleName,
    [{ name: `${module}Item`, fields: [{ name: 'id', type: 'Int!' }, { name: 'name', type: 'String' }] }],
    [{ name: `${module.toLowerCase()}Item`, args: 'id: Int!', returnType: `${module}Item`, resolver: 'ItemResolver' }],
    [{ name: `create${module}Item`, args: 'input: CreateItemInput!', returnType: `${module}Item`, resolver: 'CreateItemResolver' }]
  ));
  files.push(generateMockResolver(moduleName, 'ItemResolver', `${module.toLowerCase()}Item`));

  // Cron
  const cronJob = generateMockCronJob(moduleName, 'CleanupJob');
  files.push(cronJob.php);
  files.push(cronJob.xml);

  return files;
}
