-- =========================================================================
-- Migration 011: seasonal (limited-time) game cards — converted from
-- src/seasonal-db.js.
-- =========================================================================

CREATE TABLE IF NOT EXISTS seasons (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  theme TEXT,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT now_text()
);

ALTER TABLE game_cards ADD COLUMN IF NOT EXISTS season_id INTEGER; -- empty = a permanent card, not seasonal
