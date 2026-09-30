/**
 * Parser robustness tests for src/di-config.js (pure functions, no server, no index).
 *
 * Every case is valid PHP 8.1+ / valid Magento XML with an unusual but legal shape that a naive,
 * regex-over-text parser gets wrong: strings and heredocs containing comment markers or declarations,
 * attributes, several namespaces per file, keyword case, imports after classes, traits, anonymous
 * classes, several <arguments> blocks, preference chains, CDATA vs comments, event name case,
 * config.php variants.
 *
 * Usage:
 *   node tests/di-parsing.test.js
 */

import {
  parsePhpFile, parsePhpTypes, parsePhpMembers, createAncestorResolver, createMemberResolver,
  interceptionStatus, buildClassHierarchy, instancesOf, parseXml, parseDiXml, buildDiModel,
  applyModuleOrder, resolveInstance, resolveVirtualType, argumentInjectionsOf, parseEventsXml,
  parseConfigPhpModules, buildModuleIndex, effectivePluginDeclarations,
  checkXmlWellFormed, checkConfigValues, magentoInvalidXmlMessage, phpIntCast,
} from '../src/di-config.js';

let passed = 0;
let failed = 0;

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n      expected ${e}\n      actual   ${a}`); }
}

const types = src => parsePhpTypes(src).map(t => `${t.fqcn}<${[...t.parents, ...t.interfaces].join(',')}>`);
const methods = (src, cls) => [...(parsePhpMembers(src, cls)?.methods.values() || [])]
  .map(m => `${m.name}:${m.visibility}${m.isStatic ? ':static' : ''}${m.isFinal ? ':final' : ''}`);

/** Resolvers over an in-memory set of files keyed by FQCN. */
function memoryResolvers(files) {
  const byClass = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
  const findFile = fqcn => (byClass.has(fqcn.toLowerCase()) ? fqcn.toLowerCase() : '');
  const readFile = key => byClass.get(key);
  return { ancestorsOf: createAncestorResolver(findFile, readFile), membersOf: createMemberResolver(findFile, readFile) };
}

console.log('\nPHP source\n');

eq("'*/*/edit' in a string does not swallow the following methods", methods(`<?php
namespace A; class C { public function a() { return $this->r->setPath('*/*/edit'); }
  private function b() {} /** d */ public function c() {} }`, 'C'), ['a:public', 'b:private', 'c:public']);

eq("'image/*' and '// app/code/*' in strings keep the class", types(`<?php namespace A;
$x = 'image/*'; $y = "// app/code/*"; class C extends P {} /* x */`), ['A\\C<A\\P>']);

eq('namespace on the same line as <?php', types('<?php namespace A; class C extends P {}'), ['A\\C<A\\P>']);
eq('declare(); namespace on one line', types('<?php\ndeclare(strict_types=1); namespace A;\nclass C implements I {}'), ['A\\C<A\\I>']);

eq('several namespaces per file, each with its own imports', types(`<?php
namespace A { use X\\Y; class C extends Y {} }
namespace B { use Z\\Y; class D extends Y {} }`), ['A\\C<X\\Y>', 'B\\D<Z\\Y>']);

eq('methods do not leak between classes of one file', methods(`<?php namespace A;
class C { public function execute() {} } class D { private function execute() {} private function only() {} }`, 'C'), ['execute:public']);

eq('methods of an anonymous class inside a method are not the outer class methods', methods(`<?php namespace A;
class C { public function run() { return new class { private function run() {} private function inner() {} }; } }`, 'C'), ['run:public']);

eq('# comment right after a comma in implements', types('<?php namespace A;\nclass C implements I1,#x\n I2 {}'), ['A\\C<A\\I1,A\\I2>']);
eq('attribute directly followed by class', types('<?php namespace A; #[\\Attribute]class C extends P {}'), ['A\\C<A\\P>']);
eq('use statement after the first class applies to later classes', types('<?php namespace A; class C {} use X\\Y; class D extends Y {}'), ['A\\C<>', 'A\\D<X\\Y>']);

eq('heredoc / nowdoc containing a class declaration is not a type', types(`<?php namespace A;
$h = <<<EOT
class Fake extends Evil {
EOT;
$n = <<<'EOT'
interface Ghost {
EOT;
class Real {}`), ['A\\Real<>']);

eq('string containing a declaration does not replace the real one', types(`<?php namespace A;
$s = 'class C implements Evil {'; class C implements Good {}`), ['A\\C<A\\Good>']);

eq('anonymous class is not a named type', types('<?php namespace A; $o = new class extends \\B {}; class C {}'), ['A\\C<>']);

eq('upper-case modifiers', methods('<?php namespace A; class C { PRIVATE function f() {} PUBLIC STATIC function g() {} FINAL PUBLIC function h() {} }', 'C'),
  ['f:private', 'g:public:static', 'h:public:final']);

eq('namespace\\Relative name', types('<?php namespace A; class C extends namespace\\P {}'), ['A\\C<A\\P>']);
eq('group use with a space before \\{', types('<?php namespace A; use X \\{Y}; class C extends Y {}'), ['A\\C<X\\Y>']);
eq("'a//b' string, class later on the same line", types("<?php namespace A; $x = 'a//b'; class C extends P {}"), ['A\\C<A\\P>']);
eq('enum with backing type implementing several interfaces', types('<?php namespace A; enum E: string implements I, \\J { case X = "x"; }'), ['A\\E<A\\I,J>']);
eq('group use with alias, function/const items skipped', types(`<?php namespace A;
use X\\{Y as Z, function f, const K}; class C extends Z {}`), ['A\\C<X\\Y>']);

{
  const { ancestorsOf, membersOf } = memoryResolvers({
    'A\\C': '<?php namespace A; class C { use T; }',
    'A\\T': '<?php namespace A; trait T { public function foo() {} }',
  });
  eq('method provided by a trait is interceptable', interceptionStatus('A\\C', 'foo', ancestorsOf, membersOf).interceptable, true);
}
{
  const { ancestorsOf, membersOf } = memoryResolvers({
    'A\\C': '<?php namespace A; class C extends P implements I {}',
    'A\\P': '<?php namespace A; class P extends G {}',
    'A\\G': '<?php namespace A; class G { final public function foo() {} }',
    'A\\I': '<?php namespace A; interface I { public function foo(); }',
  });
  eq('method resolution: parent chain before interfaces', interceptionStatus('A\\C', 'foo', ancestorsOf, membersOf).interceptable, false);
}
{
  const h = buildClassHierarchy([
    { relPath: 'a.php', source: '<?php namespace Api; interface FooInterface {}' },
    { relPath: 'b.php', source: '<?php namespace X; class Foo implements \\api\\fooInterface {}' },
  ]);
  eq('class names are case-insensitive for instanceof', instancesOf(h, 'Api\\FooInterface').map(e => e.fqcn), ['X\\Foo']);
}

console.log('\nXML and DI\n');

const di = (rel, body) => ({ relPath: rel, content: `<?xml version="1.0"?><config>${body}</config>` });

{
  const d = parseDiXml(`<config><type name="A"><arguments><argument name="a" xsi:type="object">X</argument></arguments>
    <plugin name="p" type="P"/><arguments><argument name="b" xsi:type="object">Y</argument></arguments></type></config>`, 'etc/di.xml');
  eq('several <arguments> blocks per type', d.types[0].objectRefs.map(r => r.value), ['X', 'Y']);
}
{
  const m = buildDiModel([di('app/code/V/M/etc/di.xml', '<preference for="I" type="J"/><preference for="J" type="K"/>')]);
  eq('preference chain I → J → K', resolveInstance(m, 'I').real, 'K');
}
{
  const files = [
    di('app/code/V/Old/etc/di.xml', '<virtualType name="VT" type="Old\\Cls"/>'),
    di('app/code/V/New/etc/di.xml', '<virtualType name="VT" type="New\\Cls"/>'),
  ];
  const m = buildDiModel([...files].reverse());   // file order must not decide
  const idx = buildModuleIndex([
    { relPath: 'app/code/V/Old/etc/module.xml', content: '<config><module name="V_Old"/></config>' },
    { relPath: 'app/code/V/New/etc/module.xml', content: '<config><module name="V_New"/></config>' },
  ], "<?php return ['modules' => ['V_Old' => 1, 'V_New' => 1]];");
  applyModuleOrder(m, idx);
  eq('virtual type re-declared by a later module wins', resolveVirtualType(m, 'VT').real, 'New\\Cls');
}
{
  const m = buildDiModel([
    di('app/code/V/M/etc/adminhtml/di.xml', '<preference for="Api\\I" type="Impl\\C"/>'),
    di('app/code/V/M/etc/di.xml', '<type name="Owner"><arguments><argument name="x" xsi:type="object">Api\\I</argument></arguments></type>'),
  ]);
  eq('injection through an area-specific preference', argumentInjectionsOf(m, 'Impl\\C').map(i => `${i.owner}@${i.preferenceArea}`), ['Owner@adminhtml']);
}
{
  const m = buildDiModel([di('app/code/V/M/etc/di.xml', `<virtualType name="VT1" type="VT2"/><virtualType name="VT2" type="Real"/>
    <type name="VT2"><plugin name="on_vt2" type="P"/></type><type name="Real"><plugin name="on_real" type="P"/></type>`)]);
  const eff = effectivePluginDeclarations(m, 'VT1', () => []);
  eq('plugin on an intermediate virtual type is reported as not running', eff.declarations.map(d => `${d.name}${d.onVirtualType ? ':virtual' : ''}`), ['on_real', 'on_vt2:virtual']);
}
eq('"<!--" inside CDATA does not start a comment', parseXml(`<config><a><![CDATA[<!--]]></a><b/><!-- real --><c/></config>`)
  .children[0].children.map(c => c.name), ['a', 'b', 'c']);
eq('"<?" inside CDATA does not start a processing instruction', parseXml(`<config><a><![CDATA[<?]]></a><b/><c>?&gt;</c></config>`)
  .children[0].children.map(c => c.name), ['a', 'b', 'c']);
eq('event names are matched case-insensitively', parseEventsXml(
  '<config><event name="controller_action_predispatch_customer_account_loginPost"><observer name="o" instance="O"/></event></config>',
  'etc/events.xml', 'controller_action_predispatch_customer_account_loginpost').map(o => o.name), ['o']);

eq('observer disabled="1" does not disable (events converter accepts only "true"); plugin disabled="1" does', [
  parseEventsXml('<config><event name="e"><observer name="o" instance="O" disabled="1"/></event></config>', 'etc/events.xml', 'e')[0].disabled,
  parseEventsXml('<config><event name="e"><observer name="o" instance="O" disabled="true"/></event></config>', 'etc/events.xml', 'e')[0].disabled,
  parseDiXml('<config><type name="T"><plugin name="p" type="P" disabled="1"/></type></config>', 'etc/di.xml').types[0].plugins[0].disabled,
], [false, true, true]);

eq('config.php: comments, array(), double quotes, true/false', parseConfigPhpModules(`<?php
return Array(
  'modules' => ARRAY(
    // 'Old_Module' => 1,
    /* 'Gone_Module' => 1, */
    "A_One" => 1,
    'B_Two' =>/*x*/ 0,
    'C_Three' => true,
    'D_Four' => false,
  ),
  'system' => [],
);`).map(m => `${m.name}:${m.enabled}`), ['A_One:true', 'B_Two:false', 'C_Three:true', 'D_Four:false']);

// ── Configuration validation (what Magento rejects) ─────────────
// Expected first fatal error = libxml 2.9.14 / PHP 8.3 (DOMDocument::loadXML, as Config\Dom does);
// for comment / CDATA errors libxml appends the start of the section, the check reports the prefix.
const WELL_FORMED_CASES = [
  ["amp_attr", "<?xml version=\"1.0\"?>\n<config>\n  <type name=\"A&B\"/>\n</config>\n", [3, "EntityRef: expecting ';'"]],
  ["amp_text", "<?xml version=\"1.0\"?>\n<config>\n  <x>a & b</x>\n</config>\n", [3, "xmlParseEntityRef: no name"]],
  ["badname", "<?xml version=\"1.0\"?>\n<config>\n  <1x/>\n</config>\n", [3, "StartTag: invalid element name"]],
  ["blank", "   \n", [2, "Start tag expected, '<' not found"]],
  ["cdata", "<?xml version=\"1.0\"?>\n<config>\n  <x><![CDATA[ a\n</config>\n", [5, "CData section not finished"]],
  ["comment", "<?xml version=\"1.0\"?>\n<config>\n  <!-- open\n</config>\n", [5, "Comment not terminated"]],
  ["decl_not_first", "\n<?xml version=\"1.0\"?>\n<config/>\n", [2, "XML declaration allowed only at the start of the document"]],
  ["empty", "", [0, "DOMDocument::loadXML(): Argument #1 ($source) must not be empty"]],
  ["entity_nosemi", "<?xml version=\"1.0\"?>\n<config>\n  <x>&amp</x>\n</config>\n", [3, "EntityRef: expecting ';'"]],
  ["lt_attr", "<?xml version=\"1.0\"?>\n<config>\n  <type name=\"a<b\"/>\n</config>\n", [3, "Unescaped '<' not allowed in attributes values"]],
  ["mismatch", "<?xml version=\"1.0\"?>\n<config>\n  <type name=\"A\">\n    <plugin name=\"p\" type=\"B\"/>\n  </typ>\n</config>\n", [5, "Opening and ending tag mismatch: type line 3 and typ"]],
  ["nospace", "<?xml version=\"1.0\"?>\n<config>\n  <type name=\"A\" shared=\"false\"shared=\"true\"/>\n</config>\n", [3, "attributes construct error"]],
  ["notxml", "text\n", [1, "Start tag expected, '<' not found"]],
  ["novalue", "<?xml version=\"1.0\"?>\n<config>\n  <type name/>\n</config>\n", [3, "Specification mandates value for attribute name"]],
  ["ns_ok", "<?xml version=\"1.0\"?>\n<config>\n  <a:b xmlns:a=\"u\"/>\n</config>\n", null],
  ["premature", "<?xml version=\"1.0\"?>\n<config>\n  <type name=\"A\">\n    <plugin name=\"p\" type=\"B\"/>\n", [5, "Premature end of data in tag type line 3"]],
  ["redefined", "<?xml version=\"1.0\"?>\n<config>\n  <type name=\"A\" name=\"B\"/>\n</config>\n", [3, "Attribute name redefined"]],
  ["space_slash", "<?xml version=\"1.0\"?>\n<config>\n  <x a=\"1\" / >\n</config>\n", [3, "error parsing attribute name"]],
  ["stray_close", "<?xml version=\"1.0\"?>\n<config>\n  </x>\n</config>\n", [3, "Opening and ending tag mismatch: config line 2 and x"]],
  ["trailing", "<?xml version=\"1.0\"?>\n<config/>\ntrailing\n", [3, "Extra content at the end of the document"]],
  ["tworoots", "<?xml version=\"1.0\"?>\n<config/>\n<config/>\n", [3, "Extra content at the end of the document"]],
  ["unclosed_tag", "<?xml version=\"1.0\"?>\n<config>\n  <type name=\"A\"\n</config>\n", [4, "error parsing attribute name"]],
  ["undefined_entity", "<?xml version=\"1.0\"?>\n<config>\n  <x>&nbsp;</x>\n</config>\n", [3, "Entity 'nbsp' not defined"]],
  ["unquoted", "<?xml version=\"1.0\"?>\n<config>\n  <type name=A/>\n</config>\n", [3, "AttValue: \" or ' expected"]],
  ["valid", "<?xml version=\"1.0\"?>\n<config>\n  <type name=\"A\"/>\n</config>\n", null],
  ["decl_gt", "<?xml version=\"1.0\" >\n<config/>\n", [1, "parsing XML declaration: '?>' expected"]],
  ["decl_no_blank", "<?xml version=\"1.0\"encoding=\"UTF-8\"?>\n<config/>\n", [1, "Blank needed here"]],
  ["decl_version_bad", "<?xml version=\"1.0:\"?>\n<config/>\n", [1, "String not closed expecting \" or '"]],
  ["decl_version_empty", "<?xml version=\"\"?>\n<config/>\n", [1, "Malformed declaration expecting version"]],
  ["double_hyphen", "<?xml version=\"1.0\"?>\n<!--\n a -- b\n-->\n<config/>\n", [3, "Double hyphen within comment: <!--"]],
  ["double_hyphen_nonascii", "<?xml version=\"1.0\"?>\n<!--\n \u00a9 a -- b\n-->\n<config/>\n", [3, "Comment must not contain '--' (double-hyphen)"]],
  ["dtd_entity", "<?xml version=\"1.0\"?>\n<!DOCTYPE config [ <!ENTITY acme \"x\"> ]>\n<config>&acme;</config>\n", null],
  ["entity_colon", "<?xml version=\"1.0\"?>\n<config a=\"urn&:x/y\"/>\n", [2, "EntityRef: expecting ';'"]],
  ["pi_xml_prefix", "<?xmlversion=\"1.0\"?>\n<config/>\n", [1, "ParsePI: PI xmlversion space expected"]],
  ["qname_empty_local", "<?xml version=\"1.0\"?>\n<config xsi:/>\n", [2, "Specification mandates value for attribute xsi:"]],
];
for (const [name, src, expected] of WELL_FORMED_CASES) {
  const got = checkXmlWellFormed(src)[0] || null;
  eq(`well-formedness as libxml: ${name}`, got && [got.line, got.message], expected);
}
eq('Magento\'s message for a file Config\\Dom rejects (Config\\Reader\\Filesystem, ERROR_FORMAT_DEFAULT)',
  magentoInvalidXmlMessage('/m/etc/di.xml', [{ line: 5, message: 'Opening and ending tag mismatch: type line 3 and typ' }]),
  'The XML in file "/m/etc/di.xml" is invalid:\nOpening and ending tag mismatch: type line 3 and typ\nLine: 5\n\nVerify the XML and try again.');
eq('PHP (int) cast of sortOrder', ['10', '10abc', 'abc', ' 5', '1e2', '0x1A', '+5', '5.9', '-3', ''].map(phpIntCast), [10, 10, 0, 5, 100, 0, 5, 5, -3, 0]);

const DI_HEAD = '<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><type name="A\\B">';
const diValues = body => checkConfigValues(`${DI_HEAD}${body}</type></config>`, 'etc/di.xml')
  .map(p => `${p.severity}:${p.message.slice(p.message.indexOf('": ') + 3).split('\n')[0]}`);
// Expected = what Magento's DI argument interpreters throw (ObjectManagerFactory::createArgumentInterpreter),
// checked in PHP 8.3 / Mage-OS 2.4.9
eq('DI argument values as Magento\'s interpreters read them', [
  '<arguments><argument name="x" xsi:type="boolean"> true </argument></arguments>',
  '<arguments><argument name="x" xsi:type="boolean">yes</argument></arguments>',
  '<arguments><argument name="x" xsi:type="boolean">   </argument></arguments>',
  '<arguments><argument name="x" xsi:type="number"> 12 </argument></arguments>',
  '<arguments><argument name="x" xsi:type="number">1e3</argument></arguments>',
  '<arguments><argument name="x" xsi:type="number">0x1A</argument></arguments>',
  '<arguments><argument name="x">v</argument></arguments>',
  '<arguments><argument name="x" xsi:type="foo">v</argument></arguments>',
  '<arguments><argument name="x" xsi:type="object" shared="nope">A\\B</argument></arguments>',
  '<arguments><argument name="x" xsi:type="array"><item xsi:type="string">v</item></argument></arguments>',
  '<arguments><argument name="x" xsi:type="array"><item name="a" xsi:type="array"><item name="b" xsi:type="number">n</item></item></argument></arguments>',
  '<arguments><argument name="x" xsi:type="boolean">&#49;</argument></arguments>',
  '<arguments><argument name="x" xsi:type="boolean"><![CDATA[]]></argument></arguments>',
  '<arguments><argument name="x" xsi:type="boolean">a<!--c-->true</argument></arguments>',
  '<arguments><argument name="x" xsi:type="object"></argument></arguments>',
  '<arguments><argument name="x" xsi:type="init_parameter"></argument></arguments>',
  '<arguments><argument name="x" xsi:type="array"><foo>1</foo><foo>2</foo></argument></arguments>',
  '<arguments><argument name="x" xsi:type="array" item="z"/></arguments>',
  '<arguments><argument name="x" xsi:type="bool"><item xsi:type="string">v</item></argument></arguments>',
  '<arguments><argument name="x" xsi:type="array"><item name="a" xsi:type="number" sortOrder="20">n</item><item name="b" xsi:type="boolean" sortOrder="10">q</item></argument></arguments>',
  '<arguments><argument name="x" xsi:type="array"><item name="a" xsi:type="bool">v</item>!</argument></arguments>',
].map(diValues), [
  [],
  ["error:InvalidArgumentException 'Boolean value is expected, supported values: array ("],
  ["error:InvalidArgumentException 'Boolean value is missing.'"],
  [],
  [],
  ["error:InvalidArgumentException 'Numeric value is expected.'"],
  ["error:InvalidArgumentException 'Value for key \"xsi:type\" is missing in the argument data.'"],
  ["error:InvalidArgumentException 'Argument interpreter named 'foo' has not been defined.'"],
  ["error:InvalidArgumentException 'Boolean value is expected, supported values: array ("],
  ["error:UnexpectedValueException 'Array is expected to contain value for key 'name'.'"],
  ["error:InvalidArgumentException 'Numeric value is expected.'"],
  [],
  ["error:InvalidArgumentException 'Boolean value is expected, supported values: array ("],
  ["error:InvalidArgumentException 'Boolean value is expected, supported values: array ("],
  ["error:Exception 'Warning: Undefined array key \"value\"'"],
  ["error:InvalidArgumentException 'Constant name is expected.'"],
  ["error:UnexpectedValueException 'Node path 'argument/foo' is not unique, but it has not been marked as array.'"],
  ["error:InvalidArgumentException 'Array items are expected.'"],
  ["error:UnexpectedValueException 'Array is expected to contain value for key 'name'.'"],
  ["error:InvalidArgumentException 'Boolean value is expected, supported values: array ("],
  ['warning:text "!" next to 1 child element(s) — Magento\'s Config\\Converter\\Dom\\Flat reads the text as the value and drops the elements'],
]);
const diMessages = body => checkConfigValues(`${DI_HEAD}${body}</type></config>`, 'etc/di.xml')
  .map(p => `${p.severity}:${p.message.split('\n')[0]}`);
eq('DI nodes and attributes as ObjectManager\\Config\\Mapper\\Dom reads them', [
  '<plugin name="p" type="P" disabled="1"/>',
  '<plugin name="p" type="P" disabled="yes"/>',
  '<plugin type="P"/>',
  '<plugin name="p" type="P" sortOrder="10abc"/>',
  '<plugin name="p" type="P" sortOrder="-5"/>',
  '<foo/>',
].map(diMessages), [
  [],
  ['error:<plugin name="p"> disabled="yes": InvalidArgumentException \'Boolean value is expected, supported values: array ('],
  ['error:<plugin> without name in <type name="A\\B">: Warning: Attempt to read property "nodeValue" on null in Magento\\Framework\\ObjectManager\\Config\\Mapper\\Dom (Magento\'s ErrorHandler throws it as an exception)'],
  ['warning:<plugin name="p"> sortOrder="10abc" is read as (int) 10'],
  [],
  ["error:Exception 'Invalid application config. Unknown node: foo.'"],
]);
const eventValues = body => checkConfigValues(`<config>${body}</config>`, 'etc/events.xml')
  .map(p => `${p.severity}:${p.message.split(' — ')[0]}`);
eq('events as Event\\Config\\Converter reads them', [
  '<event name="e"><observer name="o" instance="O" disabled="true"/></event>',
  '<event name="e"><observer name="o" instance="O" disabled="1"/></event>',
  '<event name="e"><observer instance="O"/></event>',
  '<event><observer name="o" instance="O"/></event>',
].map(eventValues), [
  [],
  ['warning:<observer name="o"> disabled="1" does not disable the observer'],
  ["error:<observer> without name: InvalidArgumentException 'Attribute name is missed'"],
  ['error:<event> without name: Warning: Attempt to read property "nodeValue" on null in Magento\\Framework\\Event\\Config\\Converter (Magento\'s ErrorHandler throws it as an exception)'],
]);
eq('problems carry the line of the element',
  checkConfigValues('<config>\n  <type name="A">\n    <plugin name="p" disabled="x"/>\n  </type>\n</config>', 'etc/di.xml').map(p => p.line), [3]);

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
