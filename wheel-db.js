import db from './db.js';
import { adjustToman } from './db.js';
import { grantCardInstance } from './game-db.js';

/* =========================================================================
 * Daily wheel of fortune — completely free, once per cooldown period (default 24 hours).
 * No purchase is required to spin by default; it can just be set as a condition that at least one purchase happened before.
 * ========================================================================= */
db.exec(`
CREATE TABLE IF NOT EXISTS wheel_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  cooldown_hours INTEGER NOT NULL DEFAULT 24,
  require_purchase INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO wheel_config (id) VALUES (1);

CREATE TABLE IF NOT EXISTS wheel_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  type TEXT NOT NULL,             -- toman | card | extra_games
  amount_toman INTEGER DEFAULT 0,
  card_id INTEGER,
  extra_games_count INTEGER DEFAULT 0,
  probability_percent REAL NOT NULL DEFAULT 0,
  color TEXT DEFAULT '#8b5cf6',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wheel_spins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  slot_id INTEGER,
  result_label TEXT,
  spun_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export function getWheelConfig() { return db.prepare('SELECT * FROM wheel_config WHERE id = 1').get(); }
export function setWheelConfig({ enabled, cooldown_hours, require_purchase }) {
  db.prepare(`UPDATE wheel_config SET enabled=?, cooldown_hours=?, require_purchase=? WHERE id=1`)
    .run(enabled ? 1 : 0, Number(cooldown_hours) || 24, require_purchase ? 1 : 0);
}

export function listWheelSlots(onlyActive = false) {
  return onlyActive
    ? db.prepare('SELECT * FROM wheel_slots WHERE active = 1 ORDER BY id ASC').all()
    : db.prepare('SELECT * FROM wheel_slots ORDER BY id ASC').all();
}
export function upsertWheelSlot(s) {
  if (s.id) {
    db.prepare(`
      UPDATE wheel_slots SET label=?, type=?, amount_toman=?, card_id=?, extra_games_count=?, probability_percent=?, color=?, active=?
      WHERE id=?
    `).run(s.label, s.type, s.amount_toman || 0, s.card_id || null, s.extra_games_count || 0, s.probability_percent, s.color || '#8b5cf6', s.active ? 1 : 0, s.id);
    return s.id;
  }
  return db.prepare(`
    INSERT INTO wheel_slots (label, type, amount_toman, card_id, extra_games_count, probability_percent, color, active)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(s.label, s.type, s.amount_toman || 0, s.card_id || null, s.extra_games_count || 0, s.probability_percent, s.color || '#8b5cf6', s.active ? 1 : 0).lastInsertRowid;
}
export function deleteWheelSlot(id) { db.prepare('DELETE FROM wheel_slots WHERE id = ?').run(id); }

export function getLastSpin(tgId) {
  return db.prepare('SELECT * FROM wheel_spins WHERE tg_id = ? ORDER BY spun_at DESC LIMIT 1').get(tgId);
}
export function getWheelStatus(tgId) {
  const cfg = getWheelConfig();
  if (!cfg.enabled) return { enabled: false };
  const last = getLastSpin(tgId);
  let nextSpinAt = null;
  if (last) {
    const lastMs = new Date(last.spun_at.replace(' ', 'T') + 'Z').getTime();
    nextSpinAt = lastMs + cfg.cooldown_hours * 60 * 60 * 1000;
  }
  const canSpin = !nextSpinAt || Date.now() >= nextSpinAt;

  let purchaseOk = true;
  if (cfg.require_purchase) {
    const orderCount = db.prepare('SELECT COUNT(*) c FROM orders WHERE tg_id = ?').get(tgId).c;
    purchaseOk = orderCount > 0;
  }
  return { enabled: true, canSpin: canSpin && purchaseOk, nextSpinAt, requirePurchaseNotMet: cfg.require_purchase && !purchaseOk };
}

// Spinning the wheel: picks a random weighted slot and applies the prize immediately
export function spinWheel(tgId) {
  const status = getWheelStatus(tgId);
  if (!status.enabled) throw new Error('The wheel is off right now');
  if (status.requirePurchaseNotMet) throw new Error('You need to make a purchase before you can spin');
  if (!status.canSpin) throw new Error('Not time for your next spin yet');

  const slots = listWheelSlots(true).filter(s => s.type !== 'card' || db.prepare('SELECT 1 FROM game_cards WHERE id = ?').get(s.card_id));
  if (!slots.length) throw new Error('No prize defined');
  const totalWeight = slots.reduce((s, x) => s + x.probability_percent, 0);
  if (totalWeight <= 0) throw new Error('Prize probabilities are not configured');

  let roll = Math.random() * totalWeight;
  let chosen = slots[slots.length - 1];
  for (const s of slots) {
    if (roll < s.probability_percent) { chosen = s; break; }
    roll -= s.probability_percent;
  }

  const tx = db.transaction(() => {
    if (chosen.type === 'toman' && chosen.amount_toman > 0) {
      adjustToman(tgId, chosen.amount_toman, `Wheel of fortune prize: ${chosen.label}`);
    } else if (chosen.type === 'card' && chosen.card_id) {
      grantCardInstance(tgId, chosen.card_id);
    } else if (chosen.type === 'extra_games' && chosen.extra_games_count > 0) {
      db.prepare(`
        INSERT INTO game_extra_plays (tg_id, extra_plays) VALUES (?, ?)
        ON CONFLICT(tg_id) DO UPDATE SET extra_plays = extra_plays + excluded.extra_plays
      `).run(tgId, chosen.extra_games_count);
    }
    db.prepare('INSERT INTO wheel_spins (tg_id, slot_id, result_label) VALUES (?,?,?)').run(tgId, chosen.id, chosen.label);
  });
  tx();

  return { slot: chosen, slots };
}

export function getWheelHistory(tgId, limit = 10) {
  return db.prepare('SELECT * FROM wheel_spins WHERE tg_id = ? ORDER BY spun_at DESC LIMIT ?').all(tgId, limit);
}
