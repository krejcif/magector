import path from 'path';
import { statSync } from 'fs';

/**
 * Resolve the directory magento_index should index.
 * Indexing a different root than the configured one is a supported feature;
 * only paths that are not directories are refused.
 * @returns {{ root: string } | { error: string }}
 */
export function resolveIndexRoot(argPath, configured) {
  const root = argPath ? path.resolve(argPath) : configured;
  try {
    if (statSync(root).isDirectory()) return { root };
  } catch { /* fall through */ }
  return { error: `Index path is not a directory: ${root}` };
}
