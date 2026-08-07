-- =========================================================================
-- Migration 005: card trade board — converted from src/trade-db.js.
-- =========================================================================

CREATE TABLE IF NOT EXISTS trade_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  max_tradable_level INTEGER NOT NULL DEFAULT 3,
  max_trades_per_month INTEGER NOT NULL DEFAULT 3,
  min_user_level INTEGER NOT NULL DEFAULT 10,
  trade_fee_toman INTEGER NOT NULL DEFAULT 1000
);
INSERT INTO trade_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS trade_offers (
  id SERIAL PRIMARY KEY,
  from_tg_id BIGINT NOT NULL,
  to_tg_id BIGINT NOT NULL,
  from_user_card_id INTEGER NOT NULL,
  to_user_card_id INTEGER NOT NULL,
  listing_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | declined | cancelled
  created_at TEXT NOT NULL DEFAULT now_text(),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS trade_listings (
  id SERIAL PRIMARY KEY,
  tg_id BIGINT NOT NULL,
  user_card_id INTEGER NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open | completed | cancelled
  created_at TEXT NOT NULL DEFAULT now_text()
);

CREATE INDEX IF NOT EXISTS idx_trade_offers_to ON trade_offers (to_tg_id, status);
CREATE INDEX IF NOT EXISTS idx_trade_offers_from ON trade_offers (from_tg_id, status);
CREATE INDEX IF NOT EXISTS idx_trade_listings_status ON trade_listings (status);
