// One-time data migration: copies every row from the old better-sqlite3
// database (data/lando-gifts.db) into PostgreSQL (DATABASE_URL).
//
// Run this AFTER `npm run migrate` (which creates the schema) and only
// once — it clears each target table first (so re-running it is safe and
// idempotent, but it will overwrite anything already in Postgres with
// whatever is currently in the SQLite file).
//
// Requires the `better-sqlite3` devDependency: `npm install` installs it
// since it's listed under devDependencies specifically for this script.
//
// Usage:  npm run migrate:data
import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import pg from 'pg';
import Database from 'better-sqlite3';

const { Client } = pg;

const SQLITE_PATH = process.env.SQLITE_PATH || path.join(process.cwd(), 'data', 'lando-gifts.db');

async function main() {
  if (!fs.existsSync(SQLITE_PATH)) {
    console.error(`No SQLite database found at ${SQLITE_PATH}. Nothing to migrate — set SQLITE_PATH if it's somewhere else.`);
    process.exit(1);
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in first.');
    process.exit(1);
  }

  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  const pgClient = new Client({
    connectionString,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
  await pgClient.connect();

  const tables = sqlite.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).all().map(r => r.name);

  console.log(`Found ${tables.length} table(s) in the SQLite database.`);

  let totalRows = 0;
  for (const table of tables) {
    // Skip tables that don't exist in the Postgres schema (e.g. leftover/
    // experimental tables from an old version) rather than crashing.
    const existsRes = await pgClient.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
      [table]
    );
    if (existsRes.rowCount === 0) {
      console.log(`skip  ${table} (no matching table in the Postgres schema)`);
      continue;
    }

    const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all();
    await pgClient.query(`DELETE FROM "${table}"`); // safe/idempotent re-runs; no FK constraints to worry about

    if (rows.length === 0) {
      console.log(`done  ${table}: 0 rows`);
      continue;
    }

    const columns = Object.keys(rows[0]);
    const colList = columns.map(c => `"${c}"`).join(', ');
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const insertSql = `INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`;
    const insertStmt = { text: insertSql };

    await pgClient.query('BEGIN');
    try {
      for (const row of rows) {
        const values = columns.map(c => row[c]);
        await pgClient.query(insertStmt.text, values);
      }
      // Bring the SERIAL sequence (if this table has one) up to date so
      // future inserts do not collide with the migrated ids.
      if (columns.includes('id')) {
        await pgClient.query(`
          SELECT setval(
            pg_get_serial_sequence('"${table}"', 'id'),
            COALESCE((SELECT MAX(id) FROM "${table}"), 1)
          )
          WHERE pg_get_serial_sequence('"${table}"', 'id') IS NOT NULL
        `);
      }
      await pgClient.query('COMMIT');
    } catch (err) {
      await pgClient.query('ROLLBACK');
      console.error(`FAILED on table ${table}:`, err.message);
      await pgClient.end();
      process.exit(1);
    }

    console.log(`done  ${table}: ${rows.length} row(s)`);
    totalRows += rows.length;
  }

  console.log(`\nMigration complete — ${totalRows} row(s) copied across ${tables.length} table(s).`);
  console.log('Double-check a few tables in Postgres, then you can retire the old SQLite file.');
  sqlite.close();
  await pgClient.end();
}

main().catch(err => { console.error(err); process.exit(1); });
