<?php
/**
 * Ground truth for a synthetic fixture: Magento's own readers and converters run on the fixture's
 * files instead of the installation's. Output has the shape of config-truth.php, so compare.mjs
 * checks Magector on the fixture with the same code it uses on a real project.
 *
 * Usage (inside a Magento installation's PHP container; the fixture copied into the container):
 *   php fixture-truth.php <magento-root> <fixture-root> webapi|graphql|cron|dbschema > <kind>.json
 *
 * The fixture is a minimal Magento root: app/etc/config.php, modules with registration.php and
 * etc/*.xml / etc/schema.graphqls, optionally app/etc/db_schema.xml. Files are handed to the readers
 * the way Module\Dir\Reader::getConfigurationFiles() does: enabled modules, config.php order.
 */
declare(strict_types=1);

use Magento\Framework\App\Arguments\ValidationState;
use Magento\Framework\App\Bootstrap;
use Magento\Framework\Component\ComponentRegistrar;
use Magento\Framework\Config\FileResolverInterface;

[$magentoRoot, $fixture, $kind] = array_slice($argv, 1) + [null, null, null];
require rtrim($magentoRoot, '/') . '/app/bootstrap.php';
$om = Bootstrap::create(BP, $_SERVER)->getObjectManager();
$fixture = rtrim(realpath($fixture), '/');

// The fixture's modules, registered as Magento registers them: the registration.php files composer
// autoloads (vendor/composer/autoload_files.php) and those app/etc/registration_globlist.php names
$registrations = [];
if (is_file("$fixture/vendor/composer/autoload_files.php")) {
    $registrations = array_filter(require "$fixture/vendor/composer/autoload_files.php", fn($f) => str_ends_with($f, 'registration.php'));
}
$globs = is_file("$fixture/app/etc/registration_globlist.php") ? require "$fixture/app/etc/registration_globlist.php"
    : ['app/code/*/*/registration.php', 'app/design/*/*/*/registration.php', 'app/i18n/*/*/registration.php',
       'lib/internal/*/*/registration.php', 'lib/internal/*/*/*/registration.php', 'setup/src/*/*/registration.php'];
foreach ($globs as $pattern) {
    $registrations = array_merge($registrations, glob("$fixture/$pattern") ?: []);
}
foreach (array_unique($registrations) as $file) {
    require_once $file;
}
$config = require $fixture . '/app/etc/config.php';
$paths = (new ComponentRegistrar())->getPaths(ComponentRegistrar::MODULE);
$moduleDirs = [];
foreach ($config['modules'] as $name => $enabled) {
    if ($enabled && isset($paths[$name]) && str_starts_with(realpath($paths[$name]), $fixture)) {
        $moduleDirs[$name] = realpath($paths[$name]);
    }
}

$resolver = static function (string $fileName, bool $withPrimary = false) use ($moduleDirs, $fixture): FileResolverInterface {
    $files = [];
    foreach ($moduleDirs as $dir) {
        if (is_file("$dir/etc/$fileName")) {
            $files["$dir/etc/$fileName"] = file_get_contents("$dir/etc/$fileName");
        }
    }
    if ($withPrimary && is_file("$fixture/app/etc/$fileName")) {
        $files["$fixture/app/etc/$fileName"] = file_get_contents("$fixture/app/etc/$fileName");
    }
    return new class($files) implements FileResolverInterface {
        public function __construct(private readonly array $files)
        {
        }

        public function get($filename, $scope)
        {
            return $this->files;
        }
    };
};
$production = new ValidationState('production');
$out = [];

switch ($kind) {
    case 'webapi':
        $reader = $om->create(\Magento\Webapi\Model\Config\Reader::class, ['fileResolver' => $resolver('webapi.xml'), 'validationState' => $production]);
        foreach ($reader->read()['routes'] ?? [] as $url => $methods) {
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
        $reader = $om->create(\Magento\Framework\GraphQlSchemaStitching\GraphQlReader::class, ['fileResolver' => $resolver('schema.graphqls')]);
        foreach ($reader->read() as $name => $type) {
            $fields = [];
            foreach ($type['fields'] ?? [] as $fieldName => $field) {
                $fields[$fieldName] = isset($field['resolver']) ? ltrim((string) $field['resolver'], '\\') : null;
            }
            $out[$name] = ['kind' => $type['type'] ?? null, 'fields' => (object) $fields, 'dynamicFields' => (object) [],
                'fromFiles' => true,
                'typeResolver' => isset($type['typeResolver']) ? ltrim((string) $type['typeResolver'], '\\') : null];
        }
        break;
    case 'cron':
        // Cron\Model\Config\Data: crontab.xml (Reader\Xml), then the crontab system config (Reader\Db
        // → Converter\Db) merged over it; the system config's defaults are config.xml's <default>.
        $xml = $om->create(\Magento\Cron\Model\Config\Reader\Xml::class, ['fileResolver' => $resolver('crontab.xml'), 'validationState' => $production])->read();
        $initial = $om->create(\Magento\Framework\App\Config\Initial\Reader::class, ['fileResolver' => $resolver('config.xml')])->read();
        $db = $om->get(\Magento\Cron\Model\Config\Converter\Db::class)->convert(['crontab' => $initial['data']['default']['crontab'] ?? []]);
        foreach (array_replace_recursive($xml, $db) as $group => $jobs) {
            foreach ($jobs as $name => $job) {
                $out[$group][$name] = [
                    'instance' => isset($job['instance']) ? ltrim($job['instance'], '\\') : null,
                    'method' => $job['method'] ?? null,
                    'schedule' => $job['schedule'] ?? null,
                    'config_path' => $job['config_path'] ?? null,
                ];
            }
        }
        $out['__core_config_data__'] = [];
        break;
    case 'dbschema':
        $reader = $om->create('Magento\Framework\Setup\Declaration\Schema\FileSystem\XmlReader', ['fileResolver' => $resolver('db_schema.xml', true)]);
        $data = $reader->read('all');
        $builder = $om->create(\Magento\Framework\Setup\Declaration\Schema\Declaration\SchemaBuilder::class);
        $schema = $builder->addTablesData($data['table'] ?? [])->build($om->create(\Magento\Framework\Setup\Declaration\Schema\Dto\Schema::class));
        foreach ($schema->getTables() as $name => $table) {
            $out[$name] = [
                'resource' => $table->getResource(),
                'columns' => array_keys($table->getColumns()),
                'indexes' => array_keys($table->getIndexes()),
                'constraints' => array_keys($table->getConstraints()),
            ];
        }
        break;
    default:
        fwrite(STDERR, "usage: php fixture-truth.php <magento-root> <fixture-root> webapi|graphql|cron|dbschema\n");
        exit(2);
}
echo json_encode($out, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT), "\n";
