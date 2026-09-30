<?php
/**
 * Native check of Magento configuration files — the backend of magento_validate_config.
 *
 * Per file, what Magento does per file: Config\Reader\Filesystem::_readFiles() loads every file
 * with Magento\Framework\Config\Dom (a file that is not well-formed fails in every mode), and
 * di.xml / events.xml are converted by Magento's converters under Magento's ErrorHandler (to name
 * the file behind a converter exception).
 *
 * Per area, the ground truth: Magento's own readers (ObjectManager\Config\Reader\Dom,
 * Event\Config\Reader) read every scope in production and in developer mode. Developer mode adds
 * schema validation — per file where the reader has a per-file schema (events.xml), of the merged
 * document otherwise (di.xml: two files may each be valid and the merge not, or the reverse).
 *
 * Other files: validation against the schema the file declares (xsi:noNamespaceSchemaLocation).
 * Magento's reader for such a file may use another schema or none (module.xml is read without one).
 *
 * Usage: php validate-config.php <magento-root> <file relative to the root>...
 * Prints a marker line, then JSON: { php, libxml, root, files: [...], scopes: [...], scopeError }.
 * magector pipes it to MAGECTOR_PHP with the arguments in $magectorArgs (so no
 * declare(strict_types) — it must be a file's first statement).
 */

use Magento\Framework\App\Arguments\ValidationState;
use Magento\Framework\App\Bootstrap;
use Magento\Framework\App\ErrorHandler;
use Magento\Framework\App\ObjectManagerFactory;
use Magento\Framework\App\State;
use Magento\Framework\Config\Dom;
use Magento\Framework\Config\Dom\UrnResolver;
use Magento\Framework\Config\Dom\ValidationException;
use Magento\Framework\Event\Config\Converter as EventConverter;
use Magento\Framework\Event\Config\Reader as EventReader;
use Magento\Framework\ObjectManager\Config\Mapper\Dom as DiMapper;
use Magento\Framework\ObjectManager\Config\Reader\Dom as DiReader;
use Magento\Framework\Phrase;
use Magento\Framework\Stdlib\BooleanUtils;

$args = $magectorArgs ?? ['root' => $argv[1] ?? '.', 'files' => array_slice($argv, 2)];
$root = rtrim((string) $args['root'], '/');
require $root . '/app/autoload.php';

$describe = static fn(\Throwable $e): string => get_class($e) . ': ' . $e->getMessage();

/** Config\Reader\Filesystem::_readFiles() message for a file Config\Dom rejects. */
$load = static function (string $path, string $xml, ?string $schema) use ($describe): array {
    try {
        return [new Dom($xml, new ValidationState($schema ? State::MODE_DEVELOPER : State::MODE_PRODUCTION), [], null, $schema), null];
    } catch (ValidationException $e) {
        $phrase = new Phrase('The XML in file "%1" is invalid:' . "\n%2\nVerify the XML and try again.", [$path, $e->getMessage()]);
        return [null, $phrase->render()];
    } catch (\Throwable $e) {
        return [null, $describe($e)];
    }
};

$argumentInterpreter = (static function () {
    $factory = (new \ReflectionClass(ObjectManagerFactory::class))->newInstanceWithoutConstructor();
    $create = new \ReflectionMethod(ObjectManagerFactory::class, 'createArgumentInterpreter');
    return $create->invoke($factory, new BooleanUtils());
})();

$urnResolver = new UrnResolver();
$files = [];
$scopes = ['di' => ['primary' => true, 'global' => true], 'events' => ['global' => true]];
foreach ($args['files'] as $file) {
    $path = $root . '/' . ltrim((string) $file, '/');
    $base = basename($file);
    $kind = $base === 'di.xml' ? 'di' : ($base === 'events.xml' ? 'events' : null);
    if ($kind && preg_match('#/etc/([^/]+)/' . preg_quote($base, '#') . '$#', $file, $m)) {
        $scopes[$kind][$m[1]] = true;
    }
    $entry = ['file' => $file, 'xmlErrors' => [], 'production' => null, 'convert' => null, 'declaredSchema' => null];
    $xml = @file_get_contents($path);
    if ($xml === false) {
        $entry['production'] = 'Cannot read ' . $path;
        $files[] = $entry;
        continue;
    }

    if ($xml !== '') {
        $useErrors = libxml_use_internal_errors(true);
        libxml_clear_errors();
        if (!(new \DOMDocument())->loadXML($xml)) {
            foreach (libxml_get_errors() as $error) {
                $entry['xmlErrors'][] = ['line' => $error->line, 'level' => $error->level, 'message' => trim($error->message)];
            }
        }
        libxml_clear_errors();
        libxml_use_internal_errors($useErrors);
    }

    [$dom, $entry['production']] = $load($path, $xml, null);
    if ($dom && $kind) {
        set_error_handler([new ErrorHandler(), 'handler']);
        try {
            ($kind === 'di' ? new DiMapper($argumentInterpreter) : new EventConverter())->convert($dom->getDom());
        } catch (\Throwable $e) {
            $entry['convert'] = $describe($e);
        } finally {
            restore_error_handler();
        }
    } elseif ($dom) {
        $urn = $dom->getDom()->documentElement?->getAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'noNamespaceSchemaLocation');
        if ($urn && str_starts_with($urn, 'urn:')) {
            try {
                $schema = $urnResolver->getRealPath($urn);
                [, $error] = $load($path, $xml, $schema);
                $entry['declaredSchema'] = ['urn' => $urn, 'error' => $error];
            } catch (\Throwable $e) {
                $entry['declaredSchema'] = ['urn' => $urn, 'error' => null, 'unresolved' => $e->getMessage()];
            }
        }
    }
    $files[] = $entry;
}

// Magento's readers, per scope and mode: what actually happens when Magento loads the configuration.
$scopeResults = [];
$scopeError = null;
try {
    $objectManager = Bootstrap::create($root, $_SERVER)->getObjectManager();
    $readers = ['di' => DiReader::class, 'events' => EventReader::class];
    foreach ($scopes as $kind => $names) {
        foreach (array_keys($names) as $scope) {
            $result = ['kind' => $kind, 'scope' => $scope];
            foreach ([State::MODE_PRODUCTION, State::MODE_DEVELOPER] as $mode) {
                $reader = $objectManager->create($readers[$kind], ['validationState' => new ValidationState($mode)]);
                try {
                    $reader->read($scope);
                    $result[$mode] = null;
                } catch (\Throwable $e) {
                    $result[$mode] = $describe($e);
                }
            }
            $scopeResults[] = $result;
        }
    }
} catch (\Throwable $e) {
    $scopeError = 'Magento could not be bootstrapped, areas not read: ' . $describe($e);
}

// Anything the bootstrap prints (deprecations with display_errors on) stays before the marker.
echo "\n@@MAGECTOR-VALIDATE-CONFIG@@\n", json_encode(
    ['php' => PHP_VERSION, 'libxml' => LIBXML_DOTTED_VERSION, 'root' => $root, 'files' => $files, 'scopes' => $scopeResults, 'scopeError' => $scopeError],
    JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
), "\n";
