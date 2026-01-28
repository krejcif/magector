/**
 * Full init command: verify Magento project, index, detect IDE, write configs.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { resolveBinary } from './binary.js';
import { ensureModels } from './model.js';
import { CURSORRULES } from './templates/cursorrules.js';
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
    existsSync(path.join(projectPath, '.cursorrules'));
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
  const mcpConfig = {
    mcpServers: {
      magector: {
        command: 'npx',
        args: ['-y', 'magector', 'mcp'],
        env: {
          MAGENTO_ROOT: projectPath,
          MAGECTOR_DB: dbPath
        }
      }
    }
  };

  const configJson = JSON.stringify(mcpConfig, null, 2);
  const written = [];

  if (ides.cursor) {
    const cursorDir = path.join(projectPath, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(path.join(cursorDir, 'mcp.json'), configJson);
    written.push('.cursor/mcp.json');
  }

  if (ides.claude) {
    writeFileSync(path.join(projectPath, '.mcp.json'), configJson);
    written.push('.mcp.json');
  }

  // If neither detected, set up both
  if (!ides.cursor && !ides.claude) {
    writeFileSync(path.join(projectPath, '.mcp.json'), configJson);
    written.push('.mcp.json');
    const cursorDir = path.join(projectPath, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(path.join(cursorDir, 'mcp.json'), configJson);
    written.push('.cursor/mcp.json');
  }

  return written;
}

/**
 * Write IDE rules files.
 */
function writeRules(projectPath, ides) {
  const written = [];

  const writeCursor = ides.cursor || (!ides.cursor && !ides.claude);
  const writeClaude = ides.claude || (!ides.cursor && !ides.claude);

  if (writeCursor) {
    const rulesPath = path.join(projectPath, '.cursorrules');
    if (!existsSync(rulesPath)) {
      writeFileSync(rulesPath, CURSORRULES);
      written.push('.cursorrules (created)');
    } else {
      const existing = readFileSync(rulesPath, 'utf-8');
      if (!existing.includes('Magector')) {
        appendFileSync(rulesPath, '\n\n' + CURSORRULES);
        written.push('.cursorrules (appended)');
      } else {
        written.push('.cursorrules (already configured)');
      }
    }
  }

  if (writeClaude) {
    const claudePath = path.join(projectPath, 'CLAUDE.md');
    if (!existsSync(claudePath)) {
      writeFileSync(claudePath, CLAUDE_MD);
      written.push('CLAUDE.md (created)');
    } else {
      const existing = readFileSync(claudePath, 'utf-8');
      if (!existing.includes('Magector')) {
        appendFileSync(claudePath, '\n\n' + CLAUDE_MD);
        written.push('CLAUDE.md (appended)');
      } else {
        written.push('CLAUDE.md (already configured)');
      }
    }
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
