-- =========================================================================
-- Migration 010: seasonal battle pass — converted from src/season-db.js.
-- =========================================================================

CREATE TABLE IF NOT EXISTS season_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  price_toman INTEGER NOT NULL DEFAULT 50000,
  duration_days INTEGER NOT NULL DEFAULT 30,
  tier_count INTEGER NOT NULL DEFAULT 30,
  xp_per_tier INTEGER NOT NULL DEFAULT 100,
  xp_per_win INTEGER NOT NULL DEFAULT 20,
  xp_per_purchase INTEGER NOT NULL DEFAULT 10,
  xp_per_donation INTEGER NOT NULL DEFAULT 15,
  tier_skip_price_toman INTEGER NOT NULL DEFAULT 0
);
INSERT INTO season_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS current_season (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  started_at TEXT NOT NULL DEFAULT now_text(),
  ends_at TEXT
);
INSERT INTO current_season (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS season_tiers (
  tier_number INTEGER PRIMARY KEY,
  free_reward_type TEXT,      -- toman | card | extra_games | avatar | none
  free_reward_value TEXT,
  premium_reward_type TEXT,
  premium_reward_value TEXT
);

CREATE TABLE IF NOT EXISTS user_season (
  tg_id BIGINT PRIMARY KEY,
  xp INTEGER NOT NULL DEFAULT 0,
  purchased_premium INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS season_tier_claims (
  tg_id BIGINT NOT NULL,
  tier_number INTEGER NOT NULL,
  track TEXT NOT NULL, -- free | premium
  claimed_at TEXT NOT NULL DEFAULT now_text(),
  PRIMARY KEY (tg_id, tier_number, track)
);
