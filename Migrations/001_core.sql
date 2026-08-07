-- =========================================================================
-- Migration 001: core schema (users, wallet, currencies, shop, gifts,
-- tasks, tickets, ledger, settings) — converted from the original
-- better-sqlite3 schema in src/db.js.
--
-- Notes on the conversion choices (kept deliberately close to the SQLite
-- original so application behavior is unchanged):
--   * `INTEGER PRIMARY KEY AUTOINCREMENT` -> `SERIAL PRIMARY KEY`
--   * boolean-ish columns (`active`, `is_banned`, ...) stay INTEGER (0/1)
--     instead of native BOOLEAN, because the JS code writes `x ? 1 : 0`
--     and compares `WHERE active = 1` throughout — changing the column
--     type would require touching hundreds of call sites for no behavior
--     change. Postgres is happy to store/compare 0/1 in an INTEGER column.
--   * `datetime('now')` (SQLite) has no direct Postgres equivalent, so this
--     migration defines `now_text()`, a tiny SQL function that returns the
--     same 'YYYY-MM-DD HH:MI:SS' text format SQLite produced, so existing
--     JS code that parses/compares/displays these strings keeps working
--     unmodified. All `DEFAULT (datetime('now'))` clauses become
--     `DEFAULT now_text()`.
-- =========================================================================

CREATE OR REPLACE FUNCTION now_text() RETURNS TEXT AS $$
  SELECT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS');
$$ LANGUAGE SQL STABLE;

CREATE TABLE IF NOT EXISTS users (
  tg_id BIGINT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  balance_toman INTEGER NOT NULL DEFAULT 0,
  ref_code TEXT UNIQUE,
  referred_by BIGINT,
  is_banned INTEGER NOT NULL DEFAULT 0,
  ban_reason TEXT,
  created_at TEXT NOT NULL DEFAULT now_text(),
  last_seen_at TEXT NOT NULL DEFAULT now_text()
);

CREATE TABLE IF NOT EXISTS currencies (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  rate_toman DOUBLE PRECISION NOT NULL DEFAULT 0,
  min_deposit DOUBLE PRECISION NOT NULL DEFAULT 0,
  min_withdraw DOUBLE PRECISION NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT now_text(),
  deposit_address TEXT
);

CREATE TABLE IF NOT EXISTS wallet_balances (
  tg_id BIGINT NOT NULL,
  currency_code TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (tg_id, currency_code)
);

CREATE TABLE IF NOT EXISTS toman_topups (
  id SERIAL PRIMARY KEY,
  tg_id BIGINT NOT NULL,
  amount INTEGER NOT NULL,
  tracking_code TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT now_text(),
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS toman_withdrawals (
  id SERIAL PRIMARY KEY,
  tg_id BIGINT NOT NULL,
  amount INTEGER NOT NULL,
  card_number TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT now_text(),
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS currency_requests (
  id SERIAL PRIMARY KEY,
  tg_id BIGINT NOT NULL,
  currency_code TEXT NOT NULL,
  kind TEXT NOT NULL,          -- 'deposit' | 'withdraw'
  amount DOUBLE PRECISION NOT NULL,
  tx_hash TEXT,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT now_text(),
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  price_toman INTEGER NOT NULL,
  category_id INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT now_text()
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  tg_id BIGINT NOT NULL,
  product_id INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  total_toman INTEGER NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'paid',   -- paid | delivered | cancelled
  created_at TEXT NOT NULL DEFAULT now_text()
);

CREATE TABLE IF NOT EXISTS gift_offers (
  id SERIAL PRIMARY KEY,
  seller_tg_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  image_url TEXT,
  price_toman INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active | reserved | completed | cancelled
  buyer_tg_id BIGINT,
  created_at TEXT NOT NULL DEFAULT now_text(),
  reserved_at TEXT,
  completed_at TEXT,
  serial_number TEXT,
  link TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'join_channel', -- join_channel | custom
  channel_username TEXT,
  reward_toman INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT now_text()
);

CREATE TABLE IF NOT EXISTS task_claims (
  tg_id BIGINT NOT NULL,
  task_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT now_text(),
  PRIMARY KEY (tg_id, task_id)
);

CREATE TABLE IF NOT EXISTS tickets (
  id SERIAL PRIMARY KEY,
  tg_id BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT now_text()
);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER NOT NULL,
  sender TEXT NOT NULL,   -- user | admin
  body TEXT,
  image_url TEXT,
  created_at TEXT NOT NULL DEFAULT now_text()
);

CREATE TABLE IF NOT EXISTS ledger (
  id SERIAL PRIMARY KEY,
  tg_id BIGINT NOT NULL,
  currency_code TEXT NOT NULL DEFAULT 'LNDC',
  direction TEXT NOT NULL,  -- in | out
  amount DOUBLE PRECISION NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT now_text()
);

-- Simple key/value settings the admin changes from the panel (e.g. the deposit card number)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS star_payments (
  id SERIAL PRIMARY KEY,
  tg_id BIGINT NOT NULL,
  stars_amount INTEGER NOT NULL,
  rate_toman DOUBLE PRECISION NOT NULL,
  toman_credited INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | paid
  telegram_charge_id TEXT,
  created_at TEXT NOT NULL DEFAULT now_text(),
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS gift_categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT now_text(),
  image_url TEXT
);

CREATE TABLE IF NOT EXISTS zarinpal_payments (
  authority TEXT PRIMARY KEY,
  tg_id BIGINT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT now_text()
);

-- Helpful indexes for the WHERE clauses used throughout db.js
CREATE INDEX IF NOT EXISTS idx_ledger_tg_id ON ledger (tg_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gift_offers_status ON gift_offers (status);
CREATE INDEX IF NOT EXISTS idx_gift_offers_seller ON gift_offers (seller_tg_id);
CREATE INDEX IF NOT EXISTS idx_orders_tg_id ON orders (tg_id);
CREATE INDEX IF NOT EXISTS idx_users_ref_code ON users (ref_code);
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users (referred_by);

-- Default currencies (inactive until the admin sets a real rate) — was seeded
-- from JS on every boot before; now seeded once here. The app additionally
-- re-runs this seed idempotently on startup (see db.js) in case a fresh
-- database was created without migrations for some reason.
INSERT INTO currencies (code, name, rate_toman, min_deposit, min_withdraw, active)
VALUES ('USDT', 'USDT', 0, 1, 1, 0)
ON CONFLICT (code) DO NOTHING;

INSERT INTO currencies (code, name, rate_toman, min_deposit, min_withdraw, active)
VALUES ('TON', 'TON Coin', 0, 0.1, 0.1, 0)
ON CONFLICT (code) DO NOTHING;
