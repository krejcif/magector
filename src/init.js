/**
 * Full init command: verify Magento project, index, detect IDE, write configs.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import path from 'path';
import { resolveBinary } from './binary.js';
import { ensureModels } from './model.js';
import { CURSOR_RULES_MDC } from './templates/cursor-rules-mdc.js';
import { CLAUDE_MD } from './templates/claude-md.js';

/**
 * Detect if the given path is a Magento 2 project root.
 */
function isMagentoProject(projectPath) {
  // Check app/etc/env.php
  if (existsSync(path.join(projectPath, 'app', 'etc', 'env.php'))) {
    return true;
  }
  // Check composer.json for magento packages
  const composerPath = path.join(projectPath, 'composer.json');
  if (existsSync(composerPath)) {
    try {
      const content = readFileSync(composerPath, 'utf-8');
      if (content.includes('magento/') || content.includes('"magento-')) {
        return true;
      }
    } catch {
      // ignore read errors
    }
  }
  return false;
}

/**
 * Detect which IDEs are present.
 * Returns { cursor: boolean, claude: boolean }
 */
function detectIDEs(projectPath) {
  const cursor =
    existsSync(path.join(projectPath, '.cursor')) ||
    existsSync(path.join(projectPath, '.cursor', 'rules'));
  const claude =
    existsSync(path.join(projectPath, '.claude')) ||
    existsSync(path.join(projectPath, 'CLAUDE.md')) ||
    existsSync(path.join(projectPath, '.mcp.json'));
  return { cursor, claude };
}

/**
 * Write MCP server configuration for the given IDE(s).
 */
function writeMcpConfig(projectPath, ides, dbPath) {
  const mcpEntry = {
    command: 'npx',
    args: ['-y', 'magector@latest', 'mcp'],
    env: {
      MAGENTO_ROOT: projectPath,
      MAGECTOR_DB: dbPath
    }
  };

  const written = [];

  if (ides.cursor) {
    const globalCursorDir = path.join(homedir(), '.cursor');
    mkdirSync(globalCursorDir, { recursive: true });
    const globalMcpPath = path.join(globalCursorDir, 'mcp.json');
    const globalConfig = existsSync(globalMcpPath)
      ? JSON.parse(readFileSync(globalMcpPath, 'utf-8'))
      : { mcpServers: {} };
    globalConfig.mcpServers = globalConfig.mcpServers || {};
    globalConfig.mcpServers.magector = mcpEntry;
    writeFileSync(globalMcpPath, JSON.stringify(globalConfig, null, 2));
    written.push('~/.cursor/mcp.json');
  }

  if (ides.claude) {
    const claudeConfig = { mcpServers: { magector: mcpEntry } };
    writeFileSync(path.join(projectPath, '.mcp.json'), JSON.stringify(claudeConfig, null, 2));
    written.push('.mcp.json');
  }

  // If neither detected, set up both
  if (!ides.cursor && !ides.claude) {
    const claudeConfig = { mcpServers: { magector: mcpEntry } };
    writeFileSync(path.join(projectPath, '.mcp.json'), JSON.stringify(claudeConfig, null, 2));
    written.push('.mcp.json');

    const globalCursorDir = path.join(homedir(), '.cursor');
    mkdirSync(globalCursorDir, { recursive: true });
    const globalMcpPath = path.join(globalCursorDir, 'mcp.json');
    const globalConfig = existsSync(globalMcpPath)
      ? JSON.parse(readFileSync(globalMcpPath, 'utf-8'))
      : { mcpServers: {} };
    globalConfig.mcpServers = globalConfig.mcpServers || {};
    globalConfig.mcpServers.magector = mcpEntry;
    writeFileSync(globalMcpPath, JSON.stringify(globalConfig, null, 2));
    written.push('~/.cursor/mcp.json');
  }

  return written;
}

/**
 * Write IDE rules files.
 */
/**
 * Replace the Magector section in an existing file, or append if not present.
 * Magector sections are delimited by marker comments.
 */
function upsertMagectorSection(filePath, content, markerStart, markerEnd) {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, markerStart + '\n' + content + markerEnd + '\n');
    return 'created';
  }
  const existing = readFileSync(filePath, 'utf-8');
  const startIdx = existing.indexOf(markerStart);
  const endIdx = existing.indexOf(markerEnd);
  if (startIdx !== -1 && endIdx !== -1) {
    const updated = existing.slice(0, startIdx) + markerStart + '\n' + content + existing.slice(endIdx);
    writeFileSync(filePath, updated);
    return 'updated';
  }
  if (existing.includes('Magector')) {
    // Legacy format without markers — append fresh section
    appendFileSync(filePath, '\n\n' + markerStart + '\n' + content + markerEnd + '\n');
    return 'updated';
  }
  appendFileSync(filePath, '\n\n' + markerStart + '\n' + content + markerEnd + '\n');
  return 'appended';
}

const MARKER_START = '<!-- magector:start -->';
const MARKER_END = '<!-- magector:end -->';

function writeRules(projectPath, ides) {
  const written = [];

  const writeCursor = ides.cursor || (!ides.cursor && !ides.claude);
  const writeClaude = ides.claude || (!ides.cursor && !ides.claude);

  if (writeCursor) {
    const rulesDir = path.join(projectPath, '.cursor', 'rules');
    mkdirSync(rulesDir, { recursive: true });
    const mdcPath = path.join(rulesDir, 'magector.mdc');
    writeFileSync(mdcPath, CURSOR_RULES_MDC);
    written.push('.cursor/rules/magector.mdc (created)');
  }

  if (writeClaude) {
    const claudePath = path.join(projectPath, 'CLAUDE.md');
    const result = upsertMagectorSection(claudePath, CLAUDE_MD, MARKER_START, MARKER_END);
    written.push(`CLAUDE.md (${result})`);
  }

  return written;
}

/**
 * Add magector.db to .gitignore if not already present.
 */
function updateGitignore(projectPath) {
  const giPath = path.join(projectPath, '.gitignore');
  if (existsSync(giPath)) {
    const content = readFileSync(giPath, 'utf-8');
    if (!content.includes('magector.db')) {
      appendFileSync(giPath, '\n# Magector index\nmagector.db\n');
      return true;
    }
    return false;
  }
  writeFileSync(giPath, '# Magector index\nmagector.db\n');
  return true;
}

/**
 * Main init function.
 */
export async function init(projectPath) {
  projectPath = path.resolve(projectPath || process.cwd());
  const dbPath = path.join(projectPath, 'magector.db');

  console.log('\nMagector Init\n');

  // 1. Verify Magento project
  console.log('Checking Magento project...');
  if (!isMagentoProject(projectPath)) {
    console.error(
      `Error: ${projectPath} does not appear to be a Magento 2 project.\n` +
      `Expected app/etc/env.php or composer.json with "magento/" dependencies.`
    );
    process.exit(1);
  }
  console.log(`  Magento project: ${projectPath}`);

  // 2. Resolve binary
  console.log('\nResolving binary...');
  let binary;
  try {
    binary = resolveBinary();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
  console.log(`  Binary: ${binary}`);

  // 3. Ensure ONNX model
  console.log('\nChecking ONNX model...');
  let modelPath;
  try {
    modelPath = await ensureModels();
  } catch (err) {
    console.error(`Error downloading model: ${err.message}`);
    process.exit(1);
  }
  console.log(`  Models: ${modelPath}`);

  // 4. Run indexing
  console.log('\nIndexing codebase...');
  const startTime = Date.now();
  try {
    execFileSync(binary, [
      'index',
      '-m', projectPath,
      '-d', dbPath,
      '-c', modelPath
    ], { timeout: 600000, stdio: 'inherit' });
  } catch (err) {
    if (err.status) {
      console.error('Indexing failed.');
      process.exit(err.status);
    }
    console.error(`Indexing error: ${err.message}`);
    process.exit(1);
  }
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // 5. Detect IDE
  console.log('\nDetecting IDE...');
  const ides = detectIDEs(projectPath);
  const ideNames = [];
  if (ides.cursor) ideNames.push('Cursor');
  if (ides.claude) ideNames.push('Claude Code');
  if (ideNames.length === 0) ideNames.push('Cursor', 'Claude Code');
  console.log(`  Detected: ${ideNames.join(' + ') || 'none (configuring both)'}`);

  // 6. Write MCP config
  console.log('\nWriting MCP config...');
  const mcpFiles = writeMcpConfig(projectPath, ides, dbPath);
  mcpFiles.forEach(f => console.log(`  ${f}`));

  // 7. Write rules
  console.log('\nWriting IDE rules...');
  const rulesFiles = writeRules(projectPath, ides);
  rulesFiles.forEach(f => console.log(`  ${f}`));

  // 8. Update .gitignore
  const giUpdated = updateGitignore(projectPath);
  if (giUpdated) {
    console.log('\nUpdated .gitignore with magector.db');
  }

  // 9. Get stats and print summary
  let vectorCount = '?';
  try {
    const statsOutput = execFileSync(binary, ['stats', '-d', dbPath], {
      encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe']
    });
    const match = statsOutput.match(/Total vectors:\s*(\d+)/);
    if (match) vectorCount = match[1];
  } catch {
    // ignore
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Setup complete!`);
  console.log(`  Indexed ${vectorCount} vectors in ${elapsed}s`);
  console.log(`  Configured for: ${ideNames.join(' + ')}`);
  console.log(`  Database: ${dbPath}`);
  console.log(`\nTest it:`);
  console.log(`  npx magector search "product price calculation"`);
  console.log(`${'='.repeat(50)}\n`);
}

/**
 * IDE setup only (no indexing). For projects already indexed.
 */
export async function setup(projectPath) {
  projectPath = path.resolve(projectPath || process.cwd());
  const dbPath = path.join(projectPath, 'magector.db');

  console.log('\nMagector IDE Setup\n');

  const ides = detectIDEs(projectPath);
  const ideNames = [];
  if (ides.cursor) ideNames.push('Cursor');
  if (ides.claude) ideNames.push('Claude Code');
  if (ideNames.length === 0) ideNames.push('Cursor', 'Claude Code');

  console.log(`Detected: ${ideNames.join(' + ')}`);

  const mcpFiles = writeMcpConfig(projectPath, ides, dbPath);
  console.log('\nMCP config:');
  mcpFiles.forEach(f => console.log(`  ${f}`));

  const rulesFiles = writeRules(projectPath, ides);
  console.log('\nIDE rules:');
  rulesFiles.forEach(f => console.log(`  ${f}`));

  updateGitignore(projectPath);

  console.log(`\nDone. Configured for: ${ideNames.join(' + ')}\n`);
}
