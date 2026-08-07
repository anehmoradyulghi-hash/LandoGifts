// =========================================================================
// DATABASE CORE — PostgreSQL connection layer
// =========================================================================
// This replaces better-sqlite3. Because better-sqlite3 is synchronous and
// `pg` (node-postgres) is asynchronous, every call site that used to do
// `db.prepare(sql).get(...)` now has to do `await db.prepare(sql).get(...)`.
// To keep that diff as small and low-risk as possible across ~9,000 lines,
// this module exposes an object with the SAME shape (`db.prepare(sql).get/
// all/run(...)`, `db.exec(sql)`, `db.transaction(fn)`) but backed by real
// async Postgres queries under the hood.
//
// Placeholder syntax: SQLite uses `?`, Postgres uses `$1, $2, ...`. Rather
// than hand-rewriting every one of the hundreds of SQL strings in this
// project, `prepare()` auto-converts `?` -> `$1..$N` at call time.
//
// Transactions: better-sqlite3's `db.transaction(fn)` runs `fn` synchronously
// inside BEGIN/COMMIT. Here, `db.transaction(asyncFn)` checks a dedicated
// client out of the pool, runs BEGIN, and uses Node's built-in
// AsyncLocalStorage so that any `db.prepare(...).get/all/run(...)` call made
// *during* that async function automatically runs on the SAME client (so it
// participates in the transaction) instead of grabbing a random pooled
// connection. This means the call sites inside transaction callbacks don't
// need to be rewritten to pass a `tx` object around — they keep using the
// module-level `db` exactly like before, just with `await` added.
// =========================================================================

import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is required (e.g. postgres://user:pass@localhost:5432/lando_gifts)');
}

export const pool = new Pool({
  connectionString,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.PG_POOL_MAX || 10),
});

pool.on('error', (err) => {
  // A background/idle client failed — log but don't crash the whole process,
  // matching the "one bad request shouldn't take down the bot" philosophy
  // used throughout server.js.
  console.error('Unexpected PostgreSQL pool error:', err);
});

// Tracks the active transaction client (if any) for the current async
// execution context, so nested db.prepare() calls join the same transaction.
const txStorage = new AsyncLocalStorage();

function currentExecutor() {
  return txStorage.getStore() || pool;
}

// Converts SQLite-style `?` positional placeholders to Postgres `$1,$2,...`.
// Ignores `?` inside single-quoted string literals so it doesn't mangle
// literal question marks in stored text.
function convertPlaceholders(sql) {
  let index = 0;
  let out = '';
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") { inString = !inString; out += ch; continue; }
    if (ch === '?' && !inString) { index++; out += '$' + index; continue; }
    out += ch;
  }
  return out;
}

// Tables whose single-column INTEGER PRIMARY KEY is NOT an autoincrement
// surrogate id — inserts into these never rely on lastInsertRowid, so we
// don't need (and shouldn't force) a RETURNING clause for them.
const NO_RETURNING_ID_TABLES = new Set([
  'users', 'currencies', 'wallet_balances', 'task_claims', 'settings', 'zarinpal_payments',
  'clan_members', 'clan_state', 'user_league', 'user_rank', 'user_avatars',
  'daily_checkins', 'user_season', 'season_tier_claims', 'current_season',
  'user_quest_progress', 'daily_quest_assignments', 'card_task_claims',
  'user_album_claims', 'album_requirements', 'leaderboard_state', 'promo_redemptions',
  'clan_config', 'clan_war_config', 'game_config', 'gift_config',
  'league_config', 'league_state', 'quest_config', 'season_config', 'trade_config',
  'wheel_config', 'auction_config', 'rank_config', 'merge_costs',
  'card_level_power', 'game_queue', 'game_extra_plays', 'game_scores',
  'promo_codes', 'season_tiers', 'rank_titles',
]);

function tableNameFromInsert(sql) {
  const m = /insert\s+into\s+"?(\w+)"?/i.exec(sql);
  return m ? m[1] : null;
}

function needsReturningId(sql) {
  if (!/^\s*insert\s+into/i.test(sql)) return false;
  if (/returning/i.test(sql)) return false; // already has one
  const table = tableNameFromInsert(sql);
  if (!table || NO_RETURNING_ID_TABLES.has(table)) return false;
  return true;
}

async function execQuery(executor, sql, params) {
  const pgSql = convertPlaceholders(sql);
  const res = await executor.query(pgSql, params);
  return res;
}

function prepare(sql) {
  return {
    // .get(...) -> single row or undefined (mirrors better-sqlite3 .get)
    async get(...params) {
      const executor = currentExecutor();
      const res = await execQuery(executor, sql, params);
      return res.rows[0];
    },
    // .all(...) -> array of rows (mirrors better-sqlite3 .all)
    async all(...params) {
      const executor = currentExecutor();
      const res = await execQuery(executor, sql, params);
      return res.rows;
    },
    // .run(...) -> { changes, lastInsertRowid } (mirrors better-sqlite3 .run)
    async run(...params) {
      const executor = currentExecutor();
      let finalSql = sql;
      if (needsReturningId(sql)) finalSql = sql.replace(/;?\s*$/, ' RETURNING id');
      const res = await execQuery(executor, finalSql, params);
      return {
        changes: res.rowCount,
        lastInsertRowid: res.rows && res.rows[0] ? res.rows[0].id : undefined,
      };
    },
  };
}

// Runs raw/multi-statement DDL (schema setup). Splits on `;\n` boundaries
// since node-postgres's simple query protocol (used when no params are
// passed) already supports multiple statements in one call, but we still
// split to give clearer error messages pointing at the failing statement.
async function exec(sql) {
  const executor = currentExecutor();
  await executor.query(sql);
}

// better-sqlite3-compatible transaction wrapper. Usage is unchanged at call
// sites: `const tx = db.transaction(async () => {...}); await tx();`
// or the more common inline form used throughout this codebase:
// `await db.transaction(async () => {...})();`
function transaction(fn) {
  return async (...args) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await txStorage.run(client, () => fn(...args));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* ignore rollback failure */ }
      throw err;
    } finally {
      client.release();
    }
  };
}

const db = { prepare, exec, transaction };
export default db;

// Graceful shutdown helper, called from server.js on SIGTERM/SIGINT if wired up.
export async function closePool() {
  await pool.end();
}
