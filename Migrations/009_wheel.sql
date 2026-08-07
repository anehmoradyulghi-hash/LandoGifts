-- =========================================================================
-- Migration 009: daily wheel of fortune — converted from src/wheel-db.js.
-- =========================================================================

CREATE TABLE IF NOT EXISTS wheel_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  cooldown_hours INTEGER NOT NULL DEFAULT 24,
  require_purchase INTEGER NOT NULL DEFAULT 0
);
INSERT INTO wheel_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS wheel_slots (
  id SERIAL PRIMARY KEY,
  label TEXT NOT NULL,
  type TEXT NOT NULL,             -- toman | card | extra_games
  amount_toman INTEGER DEFAULT 0,
  card_id INTEGER,
  extra_games_count INTEGER DEFAULT 0,
  probability_percent DOUBLE PRECISION NOT NULL DEFAULT 0,
  color TEXT DEFAULT '#8b5cf6',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT now_text()
);

CREATE TABLE IF NOT EXISTS wheel_spins (
  id SERIAL PRIMARY KEY,
  tg_id BIGINT NOT NULL,
  slot_id INTEGER,
  result_label TEXT,
  spun_at TEXT NOT NULL DEFAULT now_text()
);

CREATE INDEX IF NOT EXISTS idx_wheel_spins_tg ON wheel_spins (tg_id, spun_at DESC);
