/**
 * Pure rate-limit policy for respawning the long-lived `magector-core serve`
 * process after it exits unexpectedly (OOM, manual kill, crash). Without a
 * limit, a process that keeps crashing on startup would be respawned in a
 * tight loop, burning CPU forever instead of falling back cleanly.
 */

export const MAX_RESPAWNS_PER_WINDOW = 3;
export const RESPAWN_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
export const RESPAWN_BASE_DELAY_MS = 5000; // 5s, growing per respawn already used in the window

/**
 * @param {number[]} recentExitTimestamps - unexpected-exit timestamps (ms), any order
 * @param {number} now - current time in ms
 * @returns {{
 *   respawn: boolean,
 *   delayMs: number,
 *   prunedTimestamps: number[]
 * }} prunedTimestamps is recentExitTimestamps with entries older than the
 *    window dropped — the caller should store this (plus `now`) as its new
 *    tracking state regardless of whether respawn is true or false.
 */
export function shouldRespawnServe(recentExitTimestamps, now) {
  const pruned = (recentExitTimestamps || []).filter((ts) => now - ts < RESPAWN_WINDOW_MS);
  if (pruned.length >= MAX_RESPAWNS_PER_WINDOW) {
    return { respawn: false, delayMs: 0, prunedTimestamps: pruned };
  }
  const delayMs = RESPAWN_BASE_DELAY_MS * (pruned.length + 1);
  return { respawn: true, delayMs, prunedTimestamps: pruned };
}
