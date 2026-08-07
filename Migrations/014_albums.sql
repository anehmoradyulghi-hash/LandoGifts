-- =========================================================================
-- Migration 014: card collection albums — converted from src/album-db.js.
-- =========================================================================

CREATE TABLE IF NOT EXISTS albums (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  reward_type TEXT NOT NULL DEFAULT 'toman', -- toman | avatar | card
  reward_value TEXT,
  is_seasonal INTEGER NOT NULL DEFAULT 0,
  starts_at TEXT,
  ends_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT now_text()
);

CREATE TABLE IF NOT EXISTS album_requirements (
  album_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  PRIMARY KEY (album_id, category_id)
);

CREATE TABLE IF NOT EXISTS user_album_claims (
  tg_id BIGINT NOT NULL,
  album_id INTEGER NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT now_text(),
  PRIMARY KEY (tg_id, album_id)
);
