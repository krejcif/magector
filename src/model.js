/**
 * Resolve and download ONNX model files for magector-core.
 *
 * Resolution order:
 * 1. MAGECTOR_MODELS env var
 * 2. ~/.magector/models/ (global cache)
 * 3. rust-core/models/ (dev fallback)
 *
 * Downloads from HuggingFace if not found.
 */
import { existsSync, mkdirSync, createWriteStream } from 'fs';
import { get as httpsGet } from 'https';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MODEL_FILES = [
  {
    name: 'all-MiniLM-L6-v2.onnx',
    url: 'https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx',
    description: 'ONNX embedding model (~86MB)'
  },
  {
    name: 'tokenizer.json',
    url: 'https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/tokenizer.json',
    description: 'Tokenizer vocabulary (~700KB)'
  }
];

function getGlobalCacheDir() {
  return path.join(os.homedir(), '.magector', 'models');
}

/**
 * Find the model directory. Does NOT download — returns null if not found.
 */
export function resolveModels() {
  // 1. Explicit env var
  if (process.env.MAGECTOR_MODELS) {
    if (hasModels(process.env.MAGECTOR_MODELS)) {
      return process.env.MAGECTOR_MODELS;
    }
  }

  // 2. Global cache
  const globalDir = getGlobalCacheDir();
  if (hasModels(globalDir)) {
    return globalDir;
  }

  // 3. Dev fallback
  const devDir = path.join(__dirname, '..', 'rust-core', 'models');
  if (hasModels(devDir)) {
    return devDir;
  }

  return null;
}

function hasModels(dir) {
  return MODEL_FILES.every(f => existsSync(path.join(dir, f.name)));
}

/**
 * Ensure models exist, downloading if needed. Returns the model directory path.
 */
export async function ensureModels({ silent = false } = {}) {
  const existing = resolveModels();
  if (existing) return existing;

  const targetDir = getGlobalCacheDir();
  mkdirSync(targetDir, { recursive: true });

  if (!silent) {
    console.log(`Downloading ONNX model to ${targetDir} ...`);
  }

  for (const file of MODEL_FILES) {
    const dest = path.join(targetDir, file.name);
    if (existsSync(dest)) continue;

    if (!silent) {
      process.stdout.write(`  ${file.description} ... `);
    }
    await downloadFile(file.url, dest);
    if (!silent) {
      console.log('done');
    }
  }

  if (!hasModels(targetDir)) {
    throw new Error('Model download failed — files missing after download');
  }

  return targetDir;
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);

    function follow(currentUrl) {
      httpsGet(currentUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = new URL(res.headers.location, currentUrl).href;
          follow(next);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close(resolve);
        });
      }).on('error', (err) => {
        file.close();
        reject(err);
      });
    }

    follow(url);
  });
}
