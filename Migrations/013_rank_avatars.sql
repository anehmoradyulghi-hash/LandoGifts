-- =========================================================================
-- Migration 013: rank/XP, titles, avatars, daily check-in — converted from
-- src/rank-db.js.
-- =========================================================================

CREATE TABLE IF NOT EXISTS rank_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 1,
  xp_per_level INTEGER NOT NULL DEFAULT 100,
  xp_per_1k_purchase INTEGER NOT NULL DEFAULT 10,
  xp_per_win INTEGER NOT NULL DEFAULT 50,
  xp_per_quest INTEGER NOT NULL DEFAULT 30,
  xp_per_referral INTEGER NOT NULL DEFAULT 100,
  xp_per_checkin INTEGER NOT NULL DEFAULT 5
);
INSERT INTO rank_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS rank_titles (
  level_threshold INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  icon TEXT
);
INSERT INTO rank_titles (level_threshold, title, icon) VALUES
  (1,'Newcomer','🌱'), (10,'Player','⭐'), (25,'Warrior','⚔️'),
  (50,'Hero','🏆'), (75,'Legendary','🔥'), (100,'Game God','👑')
ON CONFLICT (level_threshold) DO NOTHING;

CREATE TABLE IF NOT EXISTS avatars (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  image_url TEXT,
  price_toman INTEGER NOT NULL DEFAULT 0,
  quantity INTEGER,          -- empty = unlimited
  sold_count INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'shop', -- shop | battlepass | event
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT now_text()
);

CREATE TABLE IF NOT EXISTS user_rank (
  tg_id BIGINT PRIMARY KEY,
  xp INTEGER NOT NULL DEFAULT 0,
  equipped_avatar_id INTEGER
);

CREATE TABLE IF NOT EXISTS user_avatars (
  tg_id BIGINT NOT NULL,
  avatar_id INTEGER NOT NULL,
  obtained_at TEXT NOT NULL DEFAULT now_text(),
  PRIMARY KEY (tg_id, avatar_id)
);

CREATE TABLE IF NOT EXISTS daily_checkins (
  tg_id BIGINT NOT NULL,
  checkin_date TEXT NOT NULL DEFAULT today_text(),
  PRIMARY KEY (tg_id, checkin_date)
);

CREATE INDEX IF NOT EXISTS idx_user_rank_xp ON user_rank (xp DESC);
