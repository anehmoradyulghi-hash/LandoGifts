import db from './db.js';
import { adjustToman, getUser } from './db.js';
import { checkAchievements, logPlayerActivity } from './achievements-db.js';

/* =========================================================================
 * Gift packs (shop) — a purchasable pack whose prize pool is a set of real NFT
 * gifts (same kind of item traded on the gift marketplace: title, image, link,
 * serial number), each with its own win chance. Unlike chests (toman/card/
 * avatar/extra-plays, granted instantly and automatically), a real NFT gift
 * can't be handed over programmatically — winning one creates a pending
 * delivery record the admin fulfills manually, the same way every other
 * real-money/real-item flow in this bot works (top-ups, withdrawals, the gift
 * marketplace consignment flow).
 * ========================================================================= */
db.exec(`
CREATE TABLE IF NOT EXISTS gift_packs (
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

CREATE TABLE IF NOT EXISTS gift_pack_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gift_pack_id INTEGER NOT NULL,
  gift_title TEXT NOT NULL,
  gift_image_url TEXT,
  gift_link TEXT,
  gift_serial_number TEXT,
  probability_percent REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS gift_pack_openings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  gift_pack_id INTEGER NOT NULL,
  item_id INTEGER,
  gift_title TEXT NOT NULL,
  gift_image_url TEXT,
  gift_link TEXT,
  gift_serial_number TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | delivered
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT
);
`);

/* ---------- Admin: packs ---------- */
export function listGiftPacks(onlyActive = false) {
  return onlyActive
    ? db.prepare('SELECT * FROM gift_packs WHERE active = 1 ORDER BY sort_order ASC, id ASC').all()
    : db.prepare('SELECT * FROM gift_packs ORDER BY sort_order ASC, id ASC').all();
}
export function getGiftPack(id) { return db.prepare('SELECT * FROM gift_packs WHERE id = ?').get(id); }
export function upsertGiftPack(p) {
  const rewardsCount = Math.max(1, Number(p.rewards_count) || 1);
  if (p.id) {
    db.prepare(`
      UPDATE gift_packs SET title=?, description=?, image_url=?, price_toman=?, sort_order=?, active=?, rewards_count=? WHERE id=?
    `).run(p.title, p.description || null, p.image_url || null, Number(p.price_toman) || 0, Number(p.sort_order) || 0, p.active ? 1 : 0, rewardsCount, p.id);
    return p.id;
  }
  return db.prepare(`
    INSERT INTO gift_packs (title, description, image_url, price_toman, sort_order, active, rewards_count) VALUES (?,?,?,?,?,?,?)
  `).run(p.title, p.description || null, p.image_url || null, Number(p.price_toman) || 0, Number(p.sort_order) || 0, p.active ? 1 : 0, rewardsCount).lastInsertRowid;
}
export function deleteGiftPack(id) {
  db.prepare('DELETE FROM gift_pack_items WHERE gift_pack_id = ?').run(id);
  db.prepare('DELETE FROM gift_packs WHERE id = ?').run(id);
}

/* ---------- Admin: gifts inside a pack ---------- */
export function listGiftPackItems(packId, onlyActive = false) {
  return onlyActive
    ? db.prepare('SELECT * FROM gift_pack_items WHERE gift_pack_id = ? AND active = 1 ORDER BY id ASC').all(packId)
    : db.prepare('SELECT * FROM gift_pack_items WHERE gift_pack_id = ? ORDER BY id ASC').all(packId);
}
export function getGiftPackItem(id) { return db.prepare('SELECT * FROM gift_pack_items WHERE id = ?').get(id); }
export function upsertGiftPackItem(i) {
  if (i.id) {
    db.prepare(`
      UPDATE gift_pack_items SET gift_title=?, gift_image_url=?, gift_link=?, gift_serial_number=?, probability_percent=?, active=?
      WHERE id=?
    `).run(i.gift_title, i.gift_image_url || null, i.gift_link || null, i.gift_serial_number || null, Number(i.probability_percent) || 0, i.active ? 1 : 0, i.id);
    return i.id;
  }
  return db.prepare(`
    INSERT INTO gift_pack_items (gift_pack_id, gift_title, gift_image_url, gift_link, gift_serial_number, probability_percent, active)
    VALUES (?,?,?,?,?,?,?)
  `).run(i.gift_pack_id, i.gift_title, i.gift_image_url || null, i.gift_link || null, i.gift_serial_number || null, Number(i.probability_percent) || 0, i.active ? 1 : 0).lastInsertRowid;
}
export function deleteGiftPackItem(id) { db.prepare('DELETE FROM gift_pack_items WHERE id = ?').run(id); }

/* ---------- Public ---------- */
export function listGiftPacksForClient() {
  return listGiftPacks(true).map(p => ({
    ...p,
    items: listGiftPackItems(p.id, true).map(i => ({
      id: i.id, label: i.gift_title, image: i.gift_image_url, probability_percent: i.probability_percent,
    })),
  }));
}
export function getGiftPackHistory(tgId, limit = 20) {
  return db.prepare(`
    SELECT go.*, gp.title AS pack_title FROM gift_pack_openings go
    JOIN gift_packs gp ON gp.id = go.gift_pack_id
    WHERE go.tg_id = ? ORDER BY go.opened_at DESC LIMIT ?
  `).all(tgId, limit);
}

// Buying + opening a gift pack happens atomically: pay -> weighted pick(s) -> record a pending
// delivery for each win (an admin manually sends the real Telegram NFT gift afterward, then marks it
// delivered) -> notify. `notifyAdminsFn(tgId, wins)` is optional (server.js passes a Telegram
// notifier); kept as a parameter rather than importing telegram.js directly here, matching the
// pattern already used by resetClanSeason's notifyFn.
export function buyAndOpenGiftPack(tgId, packId) {
  const pack = getGiftPack(packId);
  if (!pack || !pack.active) throw new Error('This gift pack is not available');
  const user = getUser(tgId);
  if (!user || user.balance_toman < pack.price_toman) throw new Error('Insufficient wallet balance');

  const items = listGiftPackItems(packId, true);
  if (!items.length) throw new Error('This gift pack has no prizes configured yet');
  const totalWeight = items.reduce((s, it) => s + it.probability_percent, 0);
  if (totalWeight <= 0) throw new Error('This gift pack\'s odds are not configured yet');

  const rewardsCount = Math.max(1, pack.rewards_count || 1);
  const wonList = [];

  const tx = db.transaction(() => {
    if (pack.price_toman > 0) adjustToman(tgId, -pack.price_toman, `Gift pack purchase «${pack.title}»`);
    for (let n = 0; n < rewardsCount; n++) {
      let roll = Math.random() * totalWeight;
      let chosen = items[items.length - 1];
      for (const it of items) {
        if (roll < it.probability_percent) { chosen = it; break; }
        roll -= it.probability_percent;
      }
      const info = db.prepare(`
        INSERT INTO gift_pack_openings (tg_id, gift_pack_id, item_id, gift_title, gift_image_url, gift_link, gift_serial_number)
        VALUES (?,?,?,?,?,?,?)
      `).run(tgId, packId, chosen.id, chosen.gift_title, chosen.gift_image_url || null, chosen.gift_link || null, chosen.gift_serial_number || null);
      wonList.push({ openingId: info.lastInsertRowid, title: chosen.gift_title, image: chosen.gift_image_url, link: chosen.gift_link, serial: chosen.gift_serial_number });
    }
  });
  tx();

  const buyer = getUser(tgId);
  const displayName = buyer?.username || buyer?.first_name;
  wonList.forEach(w => logPlayerActivity(displayName, `opened "${pack.title}" and won a gift 🎁`, '🎁'));

  return { won: wonList[0], wonAll: wonList, items };
}

/* ---------- Admin: manual delivery fulfillment ---------- */
export function listPendingGiftPackDeliveries() {
  return db.prepare(`SELECT * FROM gift_pack_openings WHERE status = 'pending' ORDER BY opened_at ASC`).all();
}
export function markGiftPackDelivered(id) {
  db.prepare(`UPDATE gift_pack_openings SET status='delivered', delivered_at=datetime('now') WHERE id=?`).run(id);
}
export function getGiftPackOpening(id) { return db.prepare('SELECT * FROM gift_pack_openings WHERE id = ?').get(id); }

// Draws one weighted gift from a pack WITHOUT charging LNDC (used by the battle pass, where the pack
// is granted as a free/premium tier reward rather than purchased directly) and queues the same
// pending-delivery record an admin fulfills manually. `sourceLabel` just makes the activity-feed /
// order-note text reflect where the win came from (e.g. "Battle pass tier 12 reward").
export function drawFromGiftPackForReward(tgId, packId, sourceLabel) {
  const pack = getGiftPack(packId);
  if (!pack || !pack.active) throw new Error('The configured gift pack is not available');
  const items = listGiftPackItems(packId, true);
  if (!items.length) throw new Error('The configured gift pack has no prizes');
  const totalWeight = items.reduce((s, it) => s + it.probability_percent, 0);
  if (totalWeight <= 0) throw new Error('The configured gift pack\'s odds are not set up');

  let roll = Math.random() * totalWeight;
  let chosen = items[items.length - 1];
  for (const it of items) {
    if (roll < it.probability_percent) { chosen = it; break; }
    roll -= it.probability_percent;
  }
  const info = db.prepare(`
    INSERT INTO gift_pack_openings (tg_id, gift_pack_id, item_id, gift_title, gift_image_url, gift_link, gift_serial_number)
    VALUES (?,?,?,?,?,?,?)
  `).run(tgId, packId, chosen.id, chosen.gift_title, chosen.gift_image_url || null, chosen.gift_link || null, chosen.gift_serial_number || null);
  const buyer = getUser(tgId);
  logPlayerActivity(buyer?.username || buyer?.first_name, `won a gift from ${sourceLabel || pack.title} 🎁`, '🎁');
  return { openingId: info.lastInsertRowid, title: chosen.gift_title, image: chosen.gift_image_url, link: chosen.gift_link, serial: chosen.gift_serial_number };
}
