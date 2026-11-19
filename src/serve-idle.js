/**
 * Idle sleep of the serve process (magector-core serve).
 *
 * The serve process holds the vector index and the embedding model (GBs on a large project).
 * With MAGECTOR_SERVE_IDLE_SEC set, the primary instance stops it after that many seconds
 * without a query and starts it again on the next query that needs the index ("wake").
 * Commands that do not need the index (grep, data.db state, AST queries) are answered by a
 * one-shot `magector-core request` while serve sleeps, so they never wake it.
 *
 * Frequent use keeps it loaded: with MAGECTOR_SERVE_KEEP_IF_DAILY index uses (search, describe,
 * stats) in the last 24 h, the idle time is MAGECTOR_SERVE_KEEP_SEC instead.
 */

/** Serve commands that do not touch the index or the model (rust-core LIGHT_COMMANDS). */
export const LIGHT_SERVE_COMMANDS = new Set([
  'grep', 'ast_query', 'descriptions', 'enrich', 'enrich_query',
  'process_set', 'process_get', 'process_remove', 'cache_set', 'cache_get',
]);

/** Serve commands that count as a use of the index for the keep-loaded rule. */
export const INDEX_USE_COMMANDS = new Set(['search', 'describe', 'stats']);

const DAY_MS = 24 * 60 * 60 * 1000;

function envSeconds(env, name, fallback) {
  const raw = (env[name] ?? '').trim();
  if (raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/**
 * Idle settings from the environment. idleMs 0 = never sleep (the default).
 * keepMs defaults to 4 h, keepIfDaily to 10 uses.
 */
export function serveIdleConfig(env = process.env) {
  const idleMs = envSeconds(env, 'MAGECTOR_SERVE_IDLE_SEC', 0) * 1000;
  const keepMs = Math.max(idleMs, envSeconds(env, 'MAGECTOR_SERVE_KEEP_SEC', 4 * 60 * 60) * 1000);
  const keepIfDaily = Math.floor(envSeconds(env, 'MAGECTOR_SERVE_KEEP_IF_DAILY', 10));
  return { idleMs, keepMs, keepIfDaily };
}

/** Index-use timestamps from the last 24 h (oldest first). */
export function pruneUses(uses, now) {
  return uses.filter((t) => now - t < DAY_MS);
}

/**
 * How long serve may stay idle before it sleeps: keepMs when the index was used at least
 * keepIfDaily times in the last 24 h (keepIfDaily 0 turns the rule off), else idleMs.
 */
export function serveIdleDelayMs(uses, now, { idleMs, keepMs, keepIfDaily }) {
  if (keepIfDaily > 0 && pruneUses(uses, now).length >= keepIfDaily) return keepMs;
  return idleMs;
}
