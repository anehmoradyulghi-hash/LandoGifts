-- =========================================================================
-- Migration 006: flash auctions — converted from src/auction-db.js.
-- =========================================================================

CREATE TABLE IF NOT EXISTS auction_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  discount_percent INTEGER NOT NULL DEFAULT 50,
  duration_minutes INTEGER NOT NULL DEFAULT 5,
  bid_step INTEGER NOT NULL DEFAULT 1000,
  anti_snipe_enabled INTEGER NOT NULL DEFAULT 1,
  min_wallet_balance INTEGER NOT NULL DEFAULT 0
);
INSERT INTO auction_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS auctions (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  image_url TEXT,
  start_price INTEGER NOT NULL,
  current_price INTEGER NOT NULL,
  bid_step INTEGER NOT NULL,
  winner_tg_id BIGINT,
  anti_snipe INTEGER NOT NULL DEFAULT 1,
  min_wallet_balance INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', -- active | ended | cancelled | unpaid
  ends_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT now_text(),
  item_type TEXT NOT NULL DEFAULT 'product',
  card_id INTEGER
);

CREATE TABLE IF NOT EXISTS auction_bids (
  id SERIAL PRIMARY KEY,
  auction_id INTEGER NOT NULL,
  tg_id BIGINT NOT NULL,
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT now_text()
);

CREATE INDEX IF NOT EXISTS idx_auctions_status ON auctions (status);
CREATE INDEX IF NOT EXISTS idx_auction_bids_auction ON auction_bids (auction_id);
