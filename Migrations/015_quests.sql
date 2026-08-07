-- =========================================================================
-- Migration 015: daily quests — converted from src/quest-db.js.
-- =========================================================================

CREATE TABLE IF NOT EXISTS quest_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  quest_count INTEGER NOT NULL DEFAULT 3
);
INSERT INTO quest_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS quest_templates (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL,           -- win_battles | play_battles | buy_card | upgrade_cards | deposit_toman | donate_clan | checkin | custom
  target_count INTEGER NOT NULL DEFAULT 1,
  reward_type TEXT NOT NULL,    -- toman | xp | card | extra_games
  reward_value TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT now_text()
);

CREATE TABLE IF NOT EXISTS daily_quest_assignments (
  quest_date TEXT NOT NULL,
  template_id INTEGER NOT NULL,
  PRIMARY KEY (quest_date, template_id)
);

CREATE TABLE IF NOT EXISTS user_quest_progress (
  tg_id BIGINT NOT NULL,
  quest_date TEXT NOT NULL,
  template_id INTEGER NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  claimed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tg_id, quest_date, template_id)
);
