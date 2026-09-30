// Stands in for MAGECTOR_PHP in tests/validate-config.test.js: reads the program magector pipes to
// PHP, takes the file list from it and answers in the format of src/php/validate-config.php.
let program = '';
process.stdin.on('data', d => { program += d; });
process.stdin.on('end', () => {
  const { root, files } = JSON.parse(Buffer.from(/base64_decode\('([^']+)'\)/.exec(program)[1], 'base64').toString());
  const result = files.map(file => ({
    file,
    xmlErrors: [],
    production: file.includes('/Broken/') ? `FAKE-NATIVE production error for ${root}/${file}` : null,
    // a converter exception in a file whose area loads: a later file overrides the value
    convert: file.endsWith('Values/etc/di.xml') ? 'InvalidArgumentException: FAKE-NATIVE converter error' : null,
    declaredSchema: file.endsWith('Good/etc/module.xml') ? { urn: 'urn:magento:framework:Module/etc/module.xsd', error: 'FAKE-NATIVE declared schema error' } : null,
  }));
  const scopes = [
    { kind: 'di', scope: 'global', production: null, developer: 'FAKE-NATIVE merged schema error' },
    { kind: 'di', scope: 'frontend', production: 'FAKE-NATIVE frontend reader error', developer: 'FAKE-NATIVE frontend reader error' },
    { kind: 'events', scope: 'global', production: null, developer: null },
  ];
  process.stdout.write('Deprecated: noise before the marker\n@@MAGECTOR-VALIDATE-CONFIG@@\n' +
    JSON.stringify({ php: '8.3.0-fake', libxml: '2.9.14', root, files: result, scopes, scopeError: null }) + '\n');
});
