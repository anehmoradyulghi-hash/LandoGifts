-- =========================================================================
-- Migration 003: clan system (clans, members, donations, config, state)
-- — converted from src/clan-db.js.
-- =========================================================================

CREATE TABLE IF NOT EXISTS clan_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  creation_cost_toman INTEGER NOT NULL DEFAULT 50000,
  max_members INTEGER NOT NULL DEFAULT 20,
  score_per_1k_purchase INTEGER NOT NULL DEFAULT 10,
  score_per_win INTEGER NOT NULL DEFAULT 5,
  score_per_1k_donation INTEGER NOT NULL DEFAULT 20,
  reward_toman INTEGER NOT NULL DEFAULT 0,
  winners_count INTEGER NOT NULL DEFAULT 1,     -- 1 or 3
  distribution_method TEXT NOT NULL DEFAULT 'equal', -- equal | donation_share
  min_score_threshold INTEGER NOT NULL DEFAULT 0,
  reset_days INTEGER NOT NULL DEFAULT 7,
  withdraw_fee_percent INTEGER NOT NULL DEFAULT 0
);
INSERT INTO clan_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS clans (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  tag TEXT NOT NULL UNIQUE,
  avatar_url TEXT,
  owner_tg_id BIGINT NOT NULL,
  bank_balance INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT now_text()
);

CREATE TABLE IF NOT EXISTS clan_members (
  tg_id BIGINT PRIMARY KEY,
  clan_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member', -- owner | admin | member
  donated_total INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL DEFAULT now_text(),
  withdrawn_total INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS clan_donations (
  id SERIAL PRIMARY KEY,
  clan_id INTEGER NOT NULL,
  tg_id BIGINT NOT NULL,
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT now_text()
);

CREATE TABLE IF NOT EXISTS clan_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  period_started_at TEXT NOT NULL DEFAULT now_text()
);
INSERT INTO clan_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_clan_members_clan_id ON clan_members (clan_id);
CREATE INDEX IF NOT EXISTS idx_clan_donations_clan_id ON clan_donations (clan_id);
