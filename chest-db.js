import db from './db.js';
import { adjustToman, getUser } from './db.js';
import { grantCardInstance, getGameCard, rollWeightedCardLevel, normalizeCardLevelWeights } from './game-db.js';
import { grantAvatar, getAvatar } from './rank-db.js';
import { checkAchievements, logPlayerActivity } from './achievements-db.js';

// We add new columns with ALTER (since the database might already exist);
// if they were already added, we ignore the "duplicate column" error — completely safe to run repeatedly
function safeAddColumn(table, columnDef) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}

/* =========================================================================
 * Shop chests (loot boxes) — the admin defines any number of purchasable chest
 * tiers (e.g. Common / Rare / Epic). Each chest has a pool of possible items
 * (toman, a specific game card, a specific avatar, or extra game plays), each
 * with its own probability weight — same weighted-random pattern as the daily
 * wheel of fortune (wheel-db.js), but here the chest is bought with toman
 * from the shop instead of spun for free on a cooldown.
 * ========================================================================= */
db.exec(`
CREATE TABLE IF NOT EXISTS chests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  price_toman INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  rewards_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chest_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chest_id INTEGER NOT NULL,
  label TEXT,
  type TEXT NOT NULL,              -- toman | card | avatar | extra_games
  amount_toman INTEGER DEFAULT 0,
  card_id INTEGER,
  avatar_id INTEGER,
  extra_games_count INTEGER DEFAULT 0,
  probability_percent REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  card_level_weights TEXT,         -- JSON [{level, weight}, ...] — which level a leveled card is granted at (type='card' only). NULL = default (level 1, or the card's instant_level if set)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chest_openings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  chest_id INTEGER NOT NULL,
  item_id INTEGER,
  result_label TEXT,
  opened_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
safeAddColumn('chests', 'rewards_count INTEGER NOT NULL DEFAULT 1');
safeAddColumn('chest_items', 'card_level_weights TEXT');

/* ---------- Admin: chests ---------- */
export function listChests(onlyActive = false) {
  return onlyActive
    ? db.prepare('SELECT * FROM chests WHERE active = 1 ORDER BY sort_order ASC, id ASC').all()
    : db.prepare('SELECT * FROM chests ORDER BY sort_order ASC, id ASC').all();
}
export function getChest(id) { return db.prepare('SELECT * FROM chests WHERE id = ?').get(id); }
export function upsertChest(c) {
  const rewardsCount = Math.max(1, Number(c.rewards_count) || 1);
  if (c.id) {
    db.prepare(`
      UPDATE chests SET title=?, description=?, image_url=?, price_toman=?, sort_order=?, active=?, rewards_count=? WHERE id=?
    `).run(c.title, c.description || null, c.image_url || null, Number(c.price_toman) || 0, Number(c.sort_order) || 0, c.active ? 1 : 0, rewardsCount, c.id);
    return c.id;
  }
  return db.prepare(`
    INSERT INTO chests (title, description, image_url, price_toman, sort_order, active, rewards_count) VALUES (?,?,?,?,?,?,?)
  `).run(c.title, c.description || null, c.image_url || null, Number(c.price_toman) || 0, Number(c.sort_order) || 0, c.active ? 1 : 0, rewardsCount).lastInsertRowid;
}
export function deleteChest(id) {
  db.prepare('DELETE FROM chest_items WHERE chest_id = ?').run(id);
  db.prepare('DELETE FROM chests WHERE id = ?').run(id);
}

// Validates/normalizes the admin's per-level odds for a leveled card reward — shared with the
// battle pass, which supports the same per-level odds on card tier rewards (see game-db.js).

/* ---------- Admin: items inside a chest ---------- */
export function listChestItems(chestId, onlyActive = false) {
  return onlyActive
    ? db.prepare('SELECT * FROM chest_items WHERE chest_id = ? AND active = 1 ORDER BY id ASC').all(chestId)
    : db.prepare('SELECT * FROM chest_items WHERE chest_id = ? ORDER BY id ASC').all(chestId);
}
export function getChestItem(id) { return db.prepare('SELECT * FROM chest_items WHERE id = ?').get(id); }
export function upsertChestItem(i) {
  const levelWeights = i.type === 'card' ? normalizeCardLevelWeights(i.card_level_weights, i.card_id) : null;
  if (i.id) {
    db.prepare(`
      UPDATE chest_items SET label=?, type=?, amount_toman=?, card_id=?, avatar_id=?, extra_games_count=?, probability_percent=?, active=?, card_level_weights=?
      WHERE id=?
    `).run(i.label || null, i.type, i.amount_toman || 0, i.card_id || null, i.avatar_id || null, i.extra_games_count || 0,
      Number(i.probability_percent) || 0, i.active ? 1 : 0, levelWeights, i.id);
    return i.id;
  }
  return db.prepare(`
    INSERT INTO chest_items (chest_id, label, type, amount_toman, card_id, avatar_id, extra_games_count, probability_percent, active, card_level_weights)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(i.chest_id, i.label || null, i.type, i.amount_toman || 0, i.card_id || null, i.avatar_id || null, i.extra_games_count || 0,
    Number(i.probability_percent) || 0, i.active ? 1 : 0, levelWeights).lastInsertRowid;
}
export function deleteChestItem(id) { db.prepare('DELETE FROM chest_items WHERE id = ?').run(id); }

/* ---------- Public ---------- */
// Attaches a human-readable display label to each item (falls back to a generated one when the
// admin didn't set a custom label), so the frontend can show the prize pool / odds without having
// to separately look up card or avatar names itself.
function describeItem(item, grantedLevel = null) {
  let display = item.label;
  let image = null;
  if (item.type === 'card') {
    const c = getGameCard(item.card_id);
    image = c?.image_url || null;
    if (!display) display = c?.name || 'Card';
    if (grantedLevel) display += ` (Level ${grantedLevel})`;
  }
  else if (item.type === 'avatar') { const a = getAvatar(item.avatar_id); image = a?.image_url || null; if (!display) display = a?.name || 'Avatar'; }
  else if (!display && item.type === 'toman') display = `${Number(item.amount_toman).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Toman`;
  else if (!display && item.type === 'extra_games') display = `${item.extra_games_count} extra game(s)`;
  return { ...item, display, image };
}
export function listChestsForClient() {
  return listChests(true).map(c => ({
    ...c,
    items: listChestItems(c.id, true).map(it => describeItem(it)),
  }));
}
export function getChestHistory(tgId, limit = 20) {
  return db.prepare(`
    SELECT co.*, c.title AS chest_title FROM chest_openings co
    JOIN chests c ON c.id = co.chest_id
    WHERE co.tg_id = ? ORDER BY co.opened_at DESC LIMIT ?
  `).all(tgId, limit);
}

// Buying + opening a chest happens atomically: pay -> weighted pick (repeated `rewards_count` times,
// each draw independent, with replacement) -> grant each reward -> log each. If the chosen item
// pointed at a card/avatar that was deleted in the meantime, it's excluded from the draw pool (same
// defensive filtering the daily wheel does) rather than crashing the purchase.
export function buyAndOpenChest(tgId, chestId) {
  const chest = getChest(chestId);
  if (!chest || !chest.active) throw new Error('This chest is not available');
  const user = getUser(tgId);
  if (!user || user.balance_toman < chest.price_toman) throw new Error('Insufficient wallet balance');

  const items = listChestItems(chestId, true).filter(it => {
    if (it.type === 'card') return !!getGameCard(it.card_id);
    if (it.type === 'avatar') return !!getAvatar(it.avatar_id);
    return true;
  });
  if (!items.length) throw new Error('This chest has no prizes configured yet');
  const totalWeight = items.reduce((s, it) => s + it.probability_percent, 0);
  if (totalWeight <= 0) throw new Error('This chest\'s prize odds are not configured yet');

  const rewardsCount = Math.max(1, chest.rewards_count || 1);
  const wonList = [];

  const tx = db.transaction(() => {
    if (chest.price_toman > 0) adjustToman(tgId, -chest.price_toman, `Chest purchase «${chest.title}»`);

    for (let n = 0; n < rewardsCount; n++) {
      let roll = Math.random() * totalWeight;
      let chosen = items[items.length - 1];
      for (const it of items) {
        if (roll < it.probability_percent) { chosen = it; break; }
        roll -= it.probability_percent;
      }

      let grantedLevel = null;
      if (chosen.type === 'toman' && chosen.amount_toman > 0) {
        adjustToman(tgId, chosen.amount_toman, `Chest prize: ${chosen.label || 'Toman'}`);
      } else if (chosen.type === 'card' && chosen.card_id) {
        grantedLevel = rollWeightedCardLevel(chosen.card_level_weights);
        grantCardInstance(tgId, chosen.card_id, grantedLevel);
      } else if (chosen.type === 'avatar' && chosen.avatar_id) {
        grantAvatar(tgId, chosen.avatar_id);
      } else if (chosen.type === 'extra_games' && chosen.extra_games_count > 0) {
        db.prepare(`
          INSERT INTO game_extra_plays (tg_id, extra_plays) VALUES (?, ?)
          ON CONFLICT(tg_id) DO UPDATE SET extra_plays = extra_plays + excluded.extra_plays
        `).run(tgId, chosen.extra_games_count);
      }
      const described = describeItem(chosen, grantedLevel);
      db.prepare('INSERT INTO chest_openings (tg_id, chest_id, item_id, result_label) VALUES (?,?,?,?)')
        .run(tgId, chestId, chosen.id, described.display);
      wonList.push(described);
    }
  });
  tx();

  const buyer = getUser(tgId);
  const displayName = buyer?.username || buyer?.first_name;
  const opensCount = db.prepare('SELECT COUNT(*) c FROM chest_openings WHERE tg_id = ?').get(tgId).c;
  checkAchievements(tgId, 'chests_opened', opensCount, displayName);
  // A card/avatar win from a chest is exactly the kind of moment worth broadcasting to the whole app
  wonList.filter(w => w.type === 'card' || w.type === 'avatar').forEach(w => {
    logPlayerActivity(displayName, `opened "${chest.title}" and got ${w.display} 🎉`, '📦');
  });

  // `won` stays as the first prize for backward compatibility with anything expecting a single
  // result; `wonAll` carries every prize from this opening (always length 1 for single-reward chests).
  return { won: wonList[0], wonAll: wonList, items: items.map(it => describeItem(it)) };
}
