/**
 * Invocation details for running npm/npx via execFileSync.
 *
 * On Windows npm/npx are `.cmd` shims: Node >= 18.20 refuses to spawn them
 * without `shell: true` (EINVAL), and the bare name fails with ENOENT. With a
 * shell every argument is interpreted by cmd.exe, so on win32 only a strict
 * allow-list of characters is accepted; anything else throws.
 */
const SAFE_SHELL_ARG = /^[\w@.:\/\\=+-]+$/;

/**
 * @param {'npm'|'npx'} tool
 * @param {string[]} args
 * @param {string} [platform] - injectable for tests
 * @returns {{ file: string, args: string[], shell: boolean }}
 */
export function npmInvocation(tool, args, platform = process.platform) {
  if (platform !== 'win32') return { file: tool, args, shell: false };
  for (const a of args) {
    if (typeof a !== 'string' || !SAFE_SHELL_ARG.test(a)) {
      throw new Error(`unsafe argument for shell: ${JSON.stringify(a)}`);
    }
  }
  return { file: `${tool}.cmd`, args, shell: true };
}
