# Migrating from SQLite to PostgreSQL

This project now runs on PostgreSQL + Redis instead of SQLite
(`better-sqlite3`). The API and all app behavior are unchanged — only the
database layer moved.

## What changed

- `src/db-core.js` — new PostgreSQL connection layer. It exposes the same
  `db.prepare(sql).get/all/run(...)` shape the code used before, so the
  rest of the codebase didn't need to be rewritten from scratch, but every
  call is now `async` (Postgres access is inherently asynchronous, unlike
  `better-sqlite3`).
- `src/redis.js` — Redis client, currently used for admin panel login
  sessions (previously an in-memory `Map`, which didn't survive restarts
  or work with more than one server instance).
- `migrations/*.sql` — the full schema, split into one file per feature
  area, numbered in the order they must run.
- `scripts/migrate.js` — applies every file in `migrations/` that hasn't
  run yet (tracked in a `schema_migrations` table). Safe to run on every
  deploy.
- `scripts/migrate-data-from-sqlite.js` — one-time data copy from your old
  `data/lando-gifts.db` file into Postgres.

## Steps to migrate an existing deployment

1. **Provision PostgreSQL and Redis.** Any standard managed Postgres
   (Railway, Supabase, Neon, RDS, etc.) or a self-hosted instance works.
   Redis can be a small managed instance or `redis-server` on the same box.

2. **Set the new environment variables** in `.env` (see `.env.example`):
   ```
   DATABASE_URL=postgres://user:password@host:5432/lando_gifts
   PGSSL=true          # only if your provider requires SSL
   REDIS_URL=redis://127.0.0.1:6379
   ```

3. **Install dependencies** (this also installs `better-sqlite3` as a
   devDependency, needed only for the one-time data copy):
   ```
   npm install
   ```

4. **Create the schema:**
   ```
   npm run migrate
   ```

5. **Copy your existing data** from the old SQLite file (make sure
   `data/lando-gifts.db` from your current deployment is present, or set
   `SQLITE_PATH` to point at it):
   ```
   npm run migrate:data
   ```
   This is safe to re-run — it clears each table before copying, so running
   it twice just re-copies the same data.

6. **Start the app as usual:**
   ```
   npm start
   ```
   or `npm run pm2:restart` if you're using PM2.

7. Spot-check a few things in both the mini app and the admin panel
   (wallet balance, a few game cards, an existing order) to confirm the
   data came across correctly, then you can retire the old `.db` file.

## Notes

- `tg_id` columns are `BIGINT` in Postgres (they were `INTEGER` in SQLite).
  SQLite's `INTEGER` is dynamically sized so this never mattered there, but
  Postgres `INTEGER` is a strict 32-bit type and modern Telegram user IDs
  can exceed that — `BIGINT` avoids a future overflow bug.
- SQLite's `datetime('now')` / `date('now')` are replaced with two small
  Postgres helper functions, `now_text()` and `today_text()` (defined in
  `migrations/001_core.sql` and `migrations/002_card_game.sql`), which
  return the same text format the app already expects everywhere.
- No foreign key constraints were added — the original SQLite schema
  didn't enforce them either, and adding them now would be a behavior
  change, not just a database swap.
