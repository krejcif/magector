<?php
/**
 * Ground truth for compare.mjs webapi|graphql|cron|dbschema: what Magento itself reads from
 * webapi.xml, schema.graphqls, crontab.xml (+ crontab config) and db_schema.xml, after merging.
 *
 * Usage (in the Magento root, inside the PHP container):
 *   php config-truth.php webapi|graphql|cron|dbschema > <kind>-truth.json
 *
 * webapi   — Magento\Webapi\Model\Config::getServices() routes: url → method → service class/method, ACL
 * graphql  — GraphQlSchemaStitching\Reader::read(): type → kind, fields → resolver; fields GraphQlReader reads
 *            from schema.graphqls apart from the ones the other readers add (dynamicFields, from EAV)
 * cron     — Magento\Cron\Model\ConfigInterface::getJobs(): group → job → instance/method/schedule/config_path
 *            (crontab.xml merged with the `crontab` system config, as Magento's cron reads it)
 * dbschema — SchemaConfigInterface::getDeclarationConfig(): table → resource, columns, indexes, constraints
 * modules  — ComponentRegistrar: module → directory (relative to the root), enabled (ModuleList), load order
 */
declare(strict_types=1);

use Magento\Framework\App\Bootstrap;

require getcwd() . '/app/bootstrap.php';
$om = Bootstrap::create(BP, $_SERVER)->getObjectManager();
$kind = $argv[1] ?? '';
$out = [];

switch ($kind) {
    case 'webapi':
        foreach ($om->get(\Magento\Webapi\Model\Config::class)->getServices()['routes'] ?? [] as $url => $methods) {
            foreach ($methods as $method => $route) {
                $out[$url][$method] = [
                    'class' => ltrim($route['service']['class'], '\\'),
                    'method' => $route['service']['method'],
                    'resources' => array_keys($route['resources'] ?? []),
                ];
            }
        }
        break;
    case 'graphql':
        // fields: what GraphQlReader reads from schema.graphqls; dynamicFields: what the other readers of
        // GraphQlSchemaStitching\Reader add on top (e.g. CatalogGraphQl's EAV attribute readers)
        $fromFiles = $om->get(\Magento\Framework\GraphQlSchemaStitching\GraphQlReader::class)->read();
        $full = $om->get('Magento\Framework\GraphQlSchemaStitching\Reader')->read();
        foreach ($full as $name => $type) {
            $fields = [];
            $dynamic = [];
            foreach ($type['fields'] ?? [] as $fieldName => $field) {
                $resolver = isset($field['resolver']) ? ltrim((string) $field['resolver'], '\\') : null;
                if (isset($fromFiles[$name]['fields'][$fieldName])) {
                    $fields[$fieldName] = $resolver;
                } else {
                    $dynamic[$fieldName] = $resolver;
                }
            }
            $out[$name] = ['kind' => $type['type'] ?? null, 'fields' => (object) $fields, 'dynamicFields' => (object) $dynamic,
                'fromFiles' => isset($fromFiles[$name]),
                'typeResolver' => isset($type['typeResolver']) ? ltrim((string) $type['typeResolver'], '\\') : null];
        }
        break;
    case 'cron':
        foreach ($om->get(\Magento\Cron\Model\ConfigInterface::class)->getJobs() as $group => $jobs) {
            foreach ($jobs as $name => $job) {
                $out[$group][$name] = [
                    'instance' => isset($job['instance']) ? ltrim($job['instance'], '\\') : null,
                    'method' => $job['method'] ?? null,
                    'schedule' => $job['schedule'] ?? null,
                    'config_path' => $job['config_path'] ?? null,
                ];
            }
        }
        // what comes from core_config_data (saved in the admin), not from files
        $connection = $om->get(\Magento\Framework\App\ResourceConnection::class)->getConnection();
        $out['__core_config_data__'] = $connection->fetchPairs(
            $connection->select()->from($connection->getTableName('core_config_data'), ['path', 'value'])
                ->where('scope = ?', 'default')->where('path LIKE ?', 'crontab/%')
        );
        break;
    case 'dbschema':
        $schema = $om->get(\Magento\Framework\Setup\Declaration\Schema\SchemaConfigInterface::class)->getDeclarationConfig();
        foreach ($schema->getTables() as $name => $table) {
            $out[$name] = [
                'resource' => $table->getResource(),
                'columns' => array_keys($table->getColumns()),
                'indexes' => array_keys($table->getIndexes()),
                'constraints' => array_keys($table->getConstraints()),
            ];
        }
        break;
    case 'modules':
        $registrar = new \Magento\Framework\Component\ComponentRegistrar();
        $enabled = array_flip($om->get(\Magento\Framework\Module\ModuleListInterface::class)->getNames());
        foreach ($registrar->getPaths(\Magento\Framework\Component\ComponentRegistrar::MODULE) as $name => $dir) {
            $real = realpath($dir) ?: $dir;
            $out[$name] = [
                'dir' => ltrim(substr($real, strlen(realpath(BP))), '/'),
                'enabled' => isset($enabled[$name]),
                'order' => $enabled[$name] ?? null,
            ];
        }
        break;
    default:
        fwrite(STDERR, "usage: php config-truth.php webapi|graphql|cron|dbschema|modules\n");
        exit(2);
}
echo json_encode($out, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT), "\n";
