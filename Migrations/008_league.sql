-- =========================================================================
-- Migration 008: weekly league (Bronze/Silver/Gold) — converted from
-- src/league-db.js.
-- =========================================================================

CREATE TABLE IF NOT EXISTS league_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 1,
  promote_count INTEGER NOT NULL DEFAULT 5,
  relegate_count INTEGER NOT NULL DEFAULT 5,
  reset_days INTEGER NOT NULL DEFAULT 7
);
INSERT INTO league_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS league_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  period_started_at TEXT NOT NULL DEFAULT now_text()
);
INSERT INTO league_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS user_league (
  tg_id BIGINT PRIMARY KEY,
  league TEXT NOT NULL DEFAULT 'bronze', -- bronze | silver | gold
  weekly_wins INTEGER NOT NULL DEFAULT 0,
  weekly_losses INTEGER NOT NULL DEFAULT 0
);
