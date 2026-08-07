-- =========================================================================
-- Migration 004: clan vs clan wars — converted from src/clan-war-db.js.
-- =========================================================================

CREATE TABLE IF NOT EXISTS clan_war_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 1,
  min_entry_toman INTEGER NOT NULL DEFAULT 100000,
  fee_percent INTEGER NOT NULL DEFAULT 10,
  team_size INTEGER NOT NULL DEFAULT 5
);
INSERT INTO clan_war_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS clan_wars (
  id SERIAL PRIMARY KEY,
  clan_a_id INTEGER NOT NULL,
  clan_b_id INTEGER,
  entry_toman INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open | picking | finished | cancelled
  clan_a_picks TEXT DEFAULT '[]',
  clan_b_picks TEXT DEFAULT '[]',
  clan_a_power INTEGER,
  clan_b_power INTEGER,
  winner_clan_id INTEGER,
  pot_toman INTEGER,
  fee_toman INTEGER,
  created_at TEXT NOT NULL DEFAULT now_text(),
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_clan_wars_status ON clan_wars (status);
