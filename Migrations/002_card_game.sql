-- =========================================================================
-- Migration 002: card game (cards, user_cards, categories, merge costs,
-- level power caps, config, matchmaking queue, matches, leaderboard,
-- card tasks, daily play limits) — converted from src/game-db.js.
-- =========================================================================

-- Same idea as now_text() but matches SQLite's date('now') (date only, no
-- time-of-day) so play_date comparisons in game-db.js keep working as-is.
CREATE OR REPLACE FUNCTION today_text() RETURNS TEXT AS $$
  SELECT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD');
$$ LANGUAGE SQL STABLE;

CREATE TABLE IF NOT EXISTS game_cards (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  image_url TEXT,
  rarity TEXT NOT NULL DEFAULT 'common', -- common | uncommon | rare | epic | legendary | mythic | god
  base_power INTEGER NOT NULL DEFAULT 10,
  price_toman INTEGER NOT NULL DEFAULT 0,
  max_level INTEGER NOT NULL DEFAULT 10,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT now_text(),
  category_id INTEGER,
  level_images TEXT DEFAULT '[]', -- JSON array with 7 image links, one per level
  edition TEXT DEFAULT 'standard', -- standard | shiny | gold
  max_supply INTEGER, -- empty = unlimited
  instant_level INTEGER, -- if set (e.g. 7), every card created from this template starts at that level (special/custom card)
  fixed_power INTEGER, -- if set, this custom power is used instead of the level-based formula
  min_power INTEGER, -- this card's custom power range (if set, used instead of the level's general range)
  max_power INTEGER -- this card's power cap — should not be exceeded even with boost/sacrifice
);

CREATE TABLE IF NOT EXISTS user_cards (
  id SERIAL PRIMARY KEY,
  tg_id BIGINT NOT NULL,
  card_id INTEGER NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT now_text(),
  bonus_power INTEGER NOT NULL DEFAULT 0, -- comes from the "boost/sacrifice" method, does not change the level
  rolled_power INTEGER -- the actual power randomly picked from that level's range at creation/level-up time
);

CREATE TABLE IF NOT EXISTS card_categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT,
  color TEXT DEFAULT '#8b5cf6',
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT now_text()
);

-- Merge (mutation) cost per level step — fully changeable by the admin
CREATE TABLE IF NOT EXISTS merge_costs (
  from_level INTEGER PRIMARY KEY,
  cost_toman INTEGER NOT NULL
);
INSERT INTO merge_costs (from_level, cost_toman) VALUES
  (1,5000), (2,10000), (3,25000), (4,60000), (5,150000), (6,250000)
ON CONFLICT (from_level) DO NOTHING;

CREATE TABLE IF NOT EXISTS card_level_power (
  level INTEGER PRIMARY KEY,
  min_power INTEGER NOT NULL,
  max_power INTEGER NOT NULL
);
INSERT INTO card_level_power (level, min_power, max_power) VALUES
  (1,8,14), (2,14,22), (3,22,32), (4,32,45), (5,45,60), (6,60,80), (7,80,110)
ON CONFLICT (level) DO NOTHING;

CREATE TABLE IF NOT EXISTS game_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  min_deck_size INTEGER NOT NULL DEFAULT 1,
  max_deck_size INTEGER NOT NULL DEFAULT 5,
  daily_play_limit INTEGER NOT NULL DEFAULT 10,
  extra_play_price_toman INTEGER NOT NULL DEFAULT 5000,
  extra_play_count INTEGER NOT NULL DEFAULT 5,
  leaderboard_reset_days INTEGER NOT NULL DEFAULT 7,
  upgrade_base_cost_toman INTEGER NOT NULL DEFAULT 3000,
  sacrifice_fee_toman INTEGER NOT NULL DEFAULT 1000,
  sacrifice_transfer_percent INTEGER NOT NULL DEFAULT 20
);
INSERT INTO game_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS game_queue (
  tg_id BIGINT PRIMARY KEY,
  deck_json TEXT NOT NULL,
  power INTEGER NOT NULL,
  joined_at TEXT NOT NULL DEFAULT now_text()
);

CREATE TABLE IF NOT EXISTS game_matches (
  id SERIAL PRIMARY KEY,
  player_a BIGINT NOT NULL,
  player_b BIGINT NOT NULL,
  power_a INTEGER NOT NULL,
  power_b INTEGER NOT NULL,
  winner_tg_id BIGINT NOT NULL,
  created_at TEXT NOT NULL DEFAULT now_text()
);

CREATE TABLE IF NOT EXISTS game_play_log (
  id SERIAL PRIMARY KEY,
  tg_id BIGINT NOT NULL,
  play_date TEXT NOT NULL DEFAULT today_text(),
  created_at TEXT NOT NULL DEFAULT now_text()
);

CREATE TABLE IF NOT EXISTS game_extra_plays (
  tg_id BIGINT PRIMARY KEY,
  extra_plays INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS game_scores (
  tg_id BIGINT PRIMARY KEY,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT now_text()
);

CREATE TABLE IF NOT EXISTS leaderboard_prizes (
  id SERIAL PRIMARY KEY,
  rank_from INTEGER NOT NULL,
  rank_to INTEGER NOT NULL,
  reward_toman INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS leaderboard_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  period_started_at TEXT NOT NULL DEFAULT now_text(),
  last_reset_at TEXT
);
INSERT INTO leaderboard_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS card_tasks (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'join_channel',
  channel_username TEXT,
  reward_card_id INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT now_text()
);

CREATE TABLE IF NOT EXISTS card_task_claims (
  tg_id BIGINT NOT NULL,
  task_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT now_text(),
  PRIMARY KEY (tg_id, task_id)
);

-- One-time fixup carried over from game-db.js: any pre-existing card with a
-- max_level other than 7 gets normalized (fixed 7-tier rarity system).
UPDATE game_cards SET max_level = 7 WHERE max_level != 7;

CREATE INDEX IF NOT EXISTS idx_user_cards_tg_id ON user_cards (tg_id);
CREATE INDEX IF NOT EXISTS idx_game_play_log_tg_date ON game_play_log (tg_id, play_date);
CREATE INDEX IF NOT EXISTS idx_game_matches_players ON game_matches (player_a, player_b);
