// Applies every .sql file in migrations/ (in filename order) against
// DATABASE_URL, tracking which ones have already run in a
// `schema_migrations` table so it's safe to run this repeatedly (e.g. on
// every deploy) — already-applied files are skipped.
//
// Usage:  npm run migrate
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import pg from 'pg';

const { Client } = pg;

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in first.');
    process.exit(1);
  }

  const client = new Client({
    connectionString,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const dir = path.join(process.cwd(), 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

  const { rows: applied } = await client.query('SELECT filename FROM schema_migrations');
  const appliedSet = new Set(applied.map(r => r.filename));

  let ranCount = 0;
  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`skip  ${file} (already applied)`);
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    console.log(`apply ${file} ...`);
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      ranCount++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`FAILED on ${file}:`, err.message);
      await client.end();
      process.exit(1);
    }
  }

  console.log(ranCount ? `Done — ${ranCount} migration(s) applied.` : 'Nothing to do — database is already up to date.');
  await client.end();
}

main().catch(err => { console.error(err); process.exit(1); });
