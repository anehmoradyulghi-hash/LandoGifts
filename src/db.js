import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'lando-gifts.db'));
db.pragma('journal_mode = WAL');
// Tuned for concurrent access under real traffic (many simultaneous readers, one writer at a time):
db.pragma('synchronous = NORMAL');   // safe with WAL — full fsync on every write is overkill and much slower
db.pragma('busy_timeout = 5000');    // if a write is briefly locked by another, wait & retry instead of throwing "database is locked"
db.pragma('cache_size = -20000');    // ~20MB page cache in memory instead of SQLite's small default
db.pragma('temp_store = MEMORY');    // scratch space (sorts, temp tables) in RAM instead of disk
db.pragma('mmap_size = 268435456');  // memory-map the db file (256MB) so reads skip a syscall round trip

// Every currency amount in the bot (LNDC and every other wallet currency) is rounded to 2 decimal
// places instead of being truncated to a whole number. Used everywhere money is credited, debited,
// converted, or displayed, so fees/percentages/rates don't silently get floored to 0 or lose cents.
export function round2(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 0;
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

/* =========================================================================
 * SCHEMA
 * Everything is designed to be manual: the admin sets currency prices from the panel, no request
 * No network calls are made to any exchange or pricing API. Deposit/withdrawal also require approval
 * done manually by the admin, not automatic.
 * ========================================================================= */
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  tg_id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  balance_toman INTEGER NOT NULL DEFAULT 0,
  ref_code TEXT UNIQUE,
  referred_by INTEGER,
  is_banned INTEGER NOT NULL DEFAULT 0,
  ban_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS currencies (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  rate_toman REAL NOT NULL DEFAULT 0,
  min_deposit REAL NOT NULL DEFAULT 0,
  min_withdraw REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wallet_balances (
  tg_id INTEGER NOT NULL,
  currency_code TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (tg_id, currency_code)
);

CREATE TABLE IF NOT EXISTS toman_topups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  tracking_code TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS toman_withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  card_number TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS currency_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  currency_code TEXT NOT NULL,
  kind TEXT NOT NULL,          -- 'deposit' | 'withdraw'
  amount REAL NOT NULL,
  tx_hash TEXT,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  price_toman INTEGER NOT NULL,
  category_id INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  total_toman INTEGER NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'paid',   -- paid | delivered | cancelled
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS gift_offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_tg_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  image_url TEXT,
  price_toman INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active | reserved | completed | cancelled
  buyer_tg_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reserved_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'join_channel', -- join_channel | custom
  channel_username TEXT,
  reward_toman INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_claims (
  tg_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tg_id, task_id)
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  sender TEXT NOT NULL,   -- user | admin
  body TEXT,
  image_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  currency_code TEXT NOT NULL DEFAULT 'LNDC',
  direction TEXT NOT NULL,  -- in | out
  amount REAL NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Simple key/value settings the admin changes from the panel (e.g. the deposit card number)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

function safeAddColumn(table, columnDef) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}
safeAddColumn('gift_offers', 'serial_number TEXT'); // The gift's real serial/model number (optional)
safeAddColumn('gift_offers', 'link TEXT'); // Optional link to the gift itself
safeAddColumn('tasks', 'description TEXT'); // Free-text instructions shown to the user for custom tasks
safeAddColumn('tasks', 'link TEXT'); // Optional "open" button link for custom tasks (e.g. an Instagram page, a video)
safeAddColumn('currencies', 'deposit_address TEXT'); // The deposit address/account number the user should send to, per currency

db.exec(`
CREATE TABLE IF NOT EXISTS star_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  stars_amount INTEGER NOT NULL,
  rate_toman REAL NOT NULL,
  toman_credited INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | paid
  telegram_charge_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);
`);
export function createStarPaymentRequest(tgId, starsAmount, rateToman) {
  const tomanCredited = round2(starsAmount * rateToman);
  return db.prepare('INSERT INTO star_payments (tg_id, stars_amount, rate_toman, toman_credited) VALUES (?,?,?,?)')
    .run(tgId, starsAmount, rateToman, tomanCredited).lastInsertRowid;
}
export function getStarPayment(id) { return db.prepare('SELECT * FROM star_payments WHERE id = ?').get(id); }
// tops up instantly — as soon as Telegram sends payment confirmation
export function completeStarPayment(id, telegramChargeId) {
  const sp = getStarPayment(id);
  if (!sp || sp.status === 'paid') return null; // Safe against duplicate messages from Telegram
  const tx = db.transaction(() => {
    db.prepare(`UPDATE star_payments SET status='paid', telegram_charge_id=?, paid_at=datetime('now') WHERE id=?`).run(telegramChargeId, id);
    adjustToman(sp.tg_id, sp.toman_credited, `Account top-up with Telegram Stars (${sp.stars_amount}⭐)`);
  });
  tx();
  return sp;
}

db.exec(`
CREATE TABLE IF NOT EXISTS gift_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
safeAddColumn('gift_categories', 'image_url TEXT');
export function listGiftCategories(onlyActive = false) {
  return onlyActive
    ? db.prepare('SELECT * FROM gift_categories WHERE active = 1 ORDER BY name ASC').all()
    : db.prepare('SELECT * FROM gift_categories ORDER BY id DESC').all();
}
export function upsertGiftCategory(c) {
  if (c.id) {
    db.prepare('UPDATE gift_categories SET name=?, image_url=?, active=? WHERE id=?')
      .run(c.name, c.image_url || null, c.active ? 1 : 0, c.id);
    return c.id;
  }
  return db.prepare('INSERT INTO gift_categories (name, image_url, active) VALUES (?,?,?)')
    .run(c.name, c.image_url || null, c.active === false ? 0 : 1).lastInsertRowid;
}
export function deleteGiftCategory(id) { db.prepare('DELETE FROM gift_categories WHERE id = ?').run(id); }

/* =========================================================================
 * GIFT WATCHLIST — a user asks to be notified the moment a gift of a given
 * type appears in the market at or below a price they set.
 * ========================================================================= */
db.exec(`
CREATE TABLE IF NOT EXISTS gift_watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  max_price INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tg_id, title)
);
`);
export function listMyWatches(tgId) {
  return db.prepare('SELECT * FROM gift_watchlist WHERE tg_id = ? ORDER BY created_at DESC').all(tgId);
}
export function addWatch(tgId, title, maxPrice) {
  if (!title || !String(title).trim()) throw new Error('Gift type is required');
  const price = Number(maxPrice);
  if (!price || price <= 0) throw new Error('Enter a valid maximum price');
  db.prepare(`
    INSERT INTO gift_watchlist (tg_id, title, max_price) VALUES (?,?,?)
    ON CONFLICT(tg_id, title) DO UPDATE SET max_price = excluded.max_price
  `).run(tgId, title.trim(), price);
}
export function removeWatch(tgId, id) {
  db.prepare('DELETE FROM gift_watchlist WHERE id = ? AND tg_id = ?').run(id, tgId);
}
// Called right after a listing goes live (admin approval) — returns everyone whose watch matches,
// so the caller (which has access to the Telegram send function) can notify them.
export function findWatchersForOffer(offer) {
  return db.prepare(`
    SELECT * FROM gift_watchlist WHERE title = ? AND max_price >= ? AND tg_id != ?
  `).all(offer.title, offer.price_toman, offer.seller_tg_id);
}
// Used by the gift-market "post a listing" flow: the category is now derived automatically from
// the fetched NFT gift name instead of the seller picking one — this finds an existing category
// with that exact name, or silently creates it (using the fetched image as its default artwork) so
// the market's category filter keeps working without the admin having to pre-register every gift.
export function getOrCreateGiftCategoryFromName(name, imageUrl) {
  const existing = db.prepare('SELECT * FROM gift_categories WHERE name = ?').get(name);
  if (existing) return existing;
  const id = db.prepare('INSERT INTO gift_categories (name, image_url, active) VALUES (?,?,1)').run(name, imageUrl || null).lastInsertRowid;
  return db.prepare('SELECT * FROM gift_categories WHERE id = ?').get(id);
}

// A few default currencies (inactive until the admin manually sets their rate)
const seedCurrency = db.prepare(`INSERT OR IGNORE INTO currencies (code, name, rate_toman, min_deposit, min_withdraw, active) VALUES (?,?,?,?,?,0)`);
seedCurrency.run('USDT', 'USDT', 0, 1, 1);
seedCurrency.run('TON', 'TON Coin', 0, 0.1, 0.1);

/* =========================================================================
 * USERS
 * ========================================================================= */
function makeRefCode() {
  // We retry a few times to make sure the referral code isn't a duplicate (very unlikely but not zero)
  for (let i = 0; i < 5; i++) {
    const code = 'L' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const exists = db.prepare('SELECT 1 FROM users WHERE ref_code = ?').get(code);
    if (!exists) return code;
  }
  return 'L' + crypto.randomBytes(8).toString('hex').toUpperCase(); // fallback, collisions are practically impossible
}

export function getUser(tgId) {
  return db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tgId);
}

export function getOrCreateUser(tgUser, startParam) {
  if (!tgUser?.id) throw new Error('Invalid Telegram user data');
  let user = getUser(tgUser.id);
  if (user) {
    db.prepare(`UPDATE users SET username = ?, first_name = ?, last_seen_at = datetime('now') WHERE tg_id = ?`)
      .run(tgUser.username || null, tgUser.first_name || null, tgUser.id);
    return getUser(tgUser.id);
  }

  let referredBy = null;
  if (startParam && startParam.startsWith('ref_')) {
    const refCode = startParam.slice(4);
    const referrer = db.prepare('SELECT tg_id FROM users WHERE ref_code = ?').get(refCode);
    if (referrer && referrer.tg_id !== tgUser.id) referredBy = referrer.tg_id;
  }

  try {
    db.prepare(`INSERT INTO users (tg_id, username, first_name, ref_code, referred_by) VALUES (?,?,?,?,?)`)
      .run(tgUser.id, tgUser.username || null, tgUser.first_name || null, makeRefCode(), referredBy);
  } catch (e) {
    // If two simultaneous requests come from the same new user (very unlikely but possible), return the existing record instead of crashing
    const existing = getUser(tgUser.id);
    if (existing) return existing;
    throw e;
  }
  if (referredBy) payReferralSignupBonus(referredBy, tgUser.id);
  return getUser(tgUser.id);
}

export function isBanned(tgId) {
  const u = getUser(tgId);
  return { banned: !!u?.is_banned, reason: u?.ban_reason || null };
}
export function banUser(tgId, reason) {
  db.prepare(`UPDATE users SET is_banned = 1, ban_reason = ? WHERE tg_id = ?`).run(reason || null, tgId);
}
export function unbanUser(tgId) {
  db.prepare(`UPDATE users SET is_banned = 0, ban_reason = NULL WHERE tg_id = ?`).run(tgId);
}

export function listUsers(search) {
  if (search) {
    const like = `%${search}%`;
    return db.prepare(`
      SELECT u.*, COALESCE(us.purchased_premium, 0) AS has_battlepass FROM users u
      LEFT JOIN user_season us ON us.tg_id = u.tg_id
      WHERE CAST(u.tg_id AS TEXT) LIKE ? OR u.username LIKE ? OR u.first_name LIKE ?
      ORDER BY u.created_at DESC LIMIT 100
    `).all(like, like, like);
  }
  return db.prepare(`
    SELECT u.*, COALESCE(us.purchased_premium, 0) AS has_battlepass FROM users u
    LEFT JOIN user_season us ON us.tg_id = u.tg_id
    ORDER BY u.created_at DESC LIMIT 100
  `).all();
}

/* =========================================================================
 * LEDGER + LNDC BALANCE
 * ========================================================================= */
function logLedger(tgId, currencyCode, direction, amount, reason) {
  db.prepare(`INSERT INTO ledger (tg_id, currency_code, direction, amount, reason) VALUES (?,?,?,?,?)`)
    .run(tgId, currencyCode, direction, amount, reason || null);
}

export function adjustToman(tgId, amount, reason) {
  const amt = round2(amount);
  db.prepare(`UPDATE users SET balance_toman = balance_toman + ? WHERE tg_id = ?`).run(amt, tgId);
  logLedger(tgId, 'LNDC', amt >= 0 ? 'in' : 'out', Math.abs(amt), reason);
}

export function getLedger(tgId, limit = 15, offset = 0) {
  const rows = db.prepare('SELECT * FROM ledger WHERE tg_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(tgId, limit, offset);
  const total = db.prepare('SELECT COUNT(*) c FROM ledger WHERE tg_id = ?').get(tgId).c;
  return { rows, total, hasMore: offset + rows.length < total };
}

export function payReferralBonus(tgId, purchaseAmountToman, percent) {
  const user = getUser(tgId);
  if (!user?.referred_by || !percent) return;
  const bonus = round2((purchaseAmountToman * percent) / 100);
  if (bonus <= 0) return;
  creditReferralEarnings(user.referred_by, bonus, `Referral commission from user purchase ${tgId}`, tgId);
}

/* =========================================================================
 * Conditional referral withdrawal — the INVITED person (not the inviter) is
 * who has to complete the battle requirement. Every referral-derived payment
 * (signup bonus, purchase commission) is tied to exactly one invited user —
 * whoever's action generated it. If a requirement applies to that invited
 * user and they haven't met it yet, the earning is held in a per-referral
 * ledger instead of landing in the inviter's spendable balance; the moment
 * that specific invited user's battle count reaches the target, everything
 * held because of them (and only them) is released to the inviter
 * automatically. A global switch (set once) is the everyday control; a
 * per-invited-user override exists for edge cases. Reuses the existing
 * battle tables (game_matches, war_attacks) — no parallel battle-logging
 * system. Off by default: referral earnings land directly in the inviter's
 * spendable balance immediately, exactly like before this feature existed.
 * ========================================================================= */
db.exec(`
CREATE TABLE IF NOT EXISTS referral_condition_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  battle_type TEXT NOT NULL DEFAULT 'tower_war', -- tower_war | card_game
  required_battles INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO referral_condition_config (id) VALUES (1);

-- Per-invited-user override — the rare case an admin wants a different rule (or an exemption) for
-- one specific invited person, regardless of the global switch above. Keyed by the INVITED user.
CREATE TABLE IF NOT EXISTS referral_withdrawal_requirements (
  tg_id INTEGER PRIMARY KEY,
  battle_type TEXT NOT NULL DEFAULT 'tower_war',
  required_battles INTEGER NOT NULL DEFAULT 1,
  unlocked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  unlocked_at TEXT
);

-- Each row is one held referral payment, tied to which invited user's battle progress releases it
-- (and to which inviter it's owed to). A pooled per-user number can't represent "earned because of
-- invitee A, still waiting on A" separately from "earned because of invitee B, still waiting on B" —
-- this ledger keeps that straight so unlocking one invitee never releases money tied to another.
CREATE TABLE IF NOT EXISTS referral_locked_earnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_tg_id INTEGER NOT NULL,
  referred_tg_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export function getReferralConditionGlobalConfig() {
  return db.prepare('SELECT * FROM referral_condition_config WHERE id = 1').get();
}
export function setReferralConditionGlobalConfig(enabled, battleType, requiredBattles) {
  db.prepare('UPDATE referral_condition_config SET enabled=?, battle_type=?, required_battles=? WHERE id = 1')
    .run(enabled ? 1 : 0, battleType === 'card_game' ? 'card_game' : 'tower_war', Math.max(1, Number(requiredBattles) || 1));
  // Turning the global rule off releases everything currently held — there's no condition left to
  // gate it. Turning it on/changing it does NOT retroactively re-lock anything already spendable.
  if (!enabled) {
    db.prepare('SELECT DISTINCT referred_tg_id FROM referral_locked_earnings').all()
      .forEach(r => releaseEarningsForReferredUser(r.referred_tg_id));
  }
}

// Resolves the effective requirement gating a given INVITED user's referral earnings: their own
// override if one exists, otherwise the global rule (if enabled), otherwise no requirement at all.
function resolveEffectiveRequirement(referredTgId) {
  const override = db.prepare('SELECT * FROM referral_withdrawal_requirements WHERE tg_id = ?').get(referredTgId);
  if (override) return { battleType: override.battle_type, requiredBattles: override.required_battles, isOverride: true, overrideUnlocked: !!override.unlocked };
  const global = getReferralConditionGlobalConfig();
  if (global.enabled) return { battleType: global.battle_type, requiredBattles: global.required_battles, isOverride: false };
  return null;
}

// Every referral-derived payment (signup bonus, purchase commission) is caused by exactly one
// invited user's action — referredTgId. Whether it's held or paid out immediately depends on THAT
// person's battle progress, never the inviter's own.
function creditReferralEarnings(referrerTgId, amount, reason, referredTgId) {
  const effective = resolveEffectiveRequirement(referredTgId);
  const alreadyMet = effective && (effective.isOverride ? effective.overrideUnlocked : countUserBattles(referredTgId, effective.battleType) >= effective.requiredBattles);
  if (!effective || alreadyMet) {
    adjustToman(referrerTgId, amount, reason);
    return;
  }
  const amt = round2(amount);
  db.prepare('INSERT INTO referral_locked_earnings (referrer_tg_id, referred_tg_id, amount, reason) VALUES (?,?,?,?)')
    .run(referrerTgId, referredTgId, amt, reason);
  logLedger(referrerTgId, 'LNDC', 'in', amt, `${reason} (held — waiting on the invited user's battle requirement)`);
  checkAndUnlockReferralBalance(referredTgId); // in case they already met the requirement before this payout
}

// Counts real battles the user took part in (either side), for whichever battle type the requirement
// specifies — the exact same match/attack rows already used for history, matches, and stats
// elsewhere, so nothing new is logged just for this.
function countUserBattles(tgId, battleType) {
  if (battleType === 'card_game') {
    return db.prepare('SELECT COUNT(*) c FROM game_matches WHERE player_a = ? OR player_b = ?').get(tgId, tgId).c;
  }
  return db.prepare('SELECT COUNT(*) c FROM war_attacks WHERE attacker_tg_id = ? OR defender_tg_id = ?').get(tgId, tgId).c;
}

function sumLockedForReferredUser(referredTgId) {
  return db.prepare('SELECT COALESCE(SUM(amount),0) s FROM referral_locked_earnings WHERE referred_tg_id = ?').get(referredTgId).s;
}

// Status as seen from the INVITED user's own side — "you personally need to do this," matching the
// requirement to whoever the app is actually asking to act.
export function getReferralWithdrawalRequirement(referredTgId) {
  const effective = resolveEffectiveRequirement(referredTgId);
  if (!effective) return null;
  const completed = Math.min(effective.requiredBattles, countUserBattles(referredTgId, effective.battleType));
  const unlocked = effective.isOverride ? effective.overrideUnlocked : completed >= effective.requiredBattles;
  const lockedBalance = sumLockedForReferredUser(referredTgId); // held on their inviter's behalf, because of them
  return {
    battleType: effective.battleType, requiredBattles: effective.requiredBattles,
    completedBattles: completed, unlocked, lockedBalance, isOverride: effective.isOverride,
  };
}

// Status as seen from the REFERRER's own side — they may have several invited users, each gating
// their own slice of held earnings, so this returns one entry per invited user with money pending.
export function getReferrerLockedSummary(referrerTgId) {
  const rows = db.prepare(`
    SELECT rle.referred_tg_id, SUM(rle.amount) AS locked, u.first_name, u.username
    FROM referral_locked_earnings rle JOIN users u ON u.tg_id = rle.referred_tg_id
    WHERE rle.referrer_tg_id = ? GROUP BY rle.referred_tg_id
  `).all(referrerTgId);
  return rows.map(r => {
    const effective = resolveEffectiveRequirement(r.referred_tg_id);
    const completed = effective ? Math.min(effective.requiredBattles, countUserBattles(r.referred_tg_id, effective.battleType)) : 0;
    return {
      referredTgId: r.referred_tg_id, referredName: r.first_name || (r.username ? '@' + r.username : `User ${r.referred_tg_id}`),
      lockedAmount: r.locked,
      battleType: effective?.battleType || null, requiredBattles: effective?.requiredBattles || null, completedBattles: completed,
    };
  });
}

export function listReferralWithdrawalRequirementsAdmin() {
  const rows = db.prepare(`
    SELECT r.*, u.first_name, u.username
    FROM referral_withdrawal_requirements r JOIN users u ON u.tg_id = r.tg_id
    ORDER BY r.unlocked ASC, r.created_at DESC
  `).all();
  return rows.map(r => ({
    ...r,
    completedBattles: Math.min(r.required_battles, countUserBattles(r.tg_id, r.battle_type)),
    lockedForThisUser: sumLockedForReferredUser(r.tg_id),
  }));
}
// Setting/changing a per-invited-user override always (re)locks — an admin explicitly choosing a
// condition is expected to gate whatever is currently held because of this person and whatever gets
// earned because of them next, until met again. This OVERRIDES the global rule for this one invited
// user (in either direction — stricter or looser).
export function setReferralWithdrawalRequirement(referredTgId, battleType, requiredBattles) {
  const type = battleType === 'card_game' ? 'card_game' : 'tower_war';
  const required = Math.max(1, Number(requiredBattles) || 1);
  db.prepare(`
    INSERT INTO referral_withdrawal_requirements (tg_id, battle_type, required_battles, unlocked, unlocked_at)
    VALUES (?, ?, ?, 0, NULL)
    ON CONFLICT(tg_id) DO UPDATE SET battle_type=excluded.battle_type, required_battles=excluded.required_battles, unlocked=0, unlocked_at=NULL
  `).run(referredTgId, type, required);
  checkAndUnlockReferralBalance(referredTgId); // covers the case where they already meet the new requirement
}
// Removing the override falls the invited user back to whatever the global rule says (if any) rather
// than necessarily releasing held earnings outright.
export function deleteReferralWithdrawalRequirement(referredTgId) {
  const req = db.prepare('SELECT * FROM referral_withdrawal_requirements WHERE tg_id = ?').get(referredTgId);
  if (!req) return;
  db.prepare('DELETE FROM referral_withdrawal_requirements WHERE tg_id = ?').run(referredTgId);
  checkAndUnlockReferralBalance(referredTgId);
}
// Pays out every locked earning that was waiting on this specific invited user, to whichever
// inviter(s) it was held for (normally just one — a user has a single referrer).
function releaseEarningsForReferredUser(referredTgId) {
  const rows = db.prepare('SELECT * FROM referral_locked_earnings WHERE referred_tg_id = ?').all(referredTgId);
  if (!rows.length) return;
  const byReferrer = new Map();
  rows.forEach(r => byReferrer.set(r.referrer_tg_id, (byReferrer.get(r.referrer_tg_id) || 0) + r.amount));
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM referral_locked_earnings WHERE referred_tg_id = ?').run(referredTgId);
    for (const [referrerTgId, amount] of byReferrer) {
      adjustToman(referrerTgId, round2(amount), 'Referral earnings unlocked (invited user completed the battle requirement)');
    }
  });
  tx();
}
// Called after every relevant battle (Tower War attack, card battle) by ANY user — cheap (a couple
// of indexed queries), and a no-op for the vast majority who have no locked earnings sitting on
// their name at all (global rule off and no personal override, or nobody invited them via this app).
export function checkAndUnlockReferralBalance(referredTgId) {
  const effective = resolveEffectiveRequirement(referredTgId);
  if (!effective) { releaseEarningsForReferredUser(referredTgId); return; } // nothing gates them (anymore) — release whatever was held
  const completed = countUserBattles(referredTgId, effective.battleType);
  if (completed < effective.requiredBattles) return;
  if (effective.isOverride) {
    db.prepare(`UPDATE referral_withdrawal_requirements SET unlocked = 1, unlocked_at = datetime('now') WHERE tg_id = ?`).run(referredTgId);
  }
  releaseEarningsForReferredUser(referredTgId);
}

// Referral settings — fully changeable from the admin panel (no longer just .env)
export function getReferralSettings() {
  return {
    percent: Number(getSetting('referral_percent', process.env.REFERRAL_PERCENT || '5')),
    // "Type" of the flat invite reward: a currency amount, or a specific game card
    signupBonusType: getSetting('referral_signup_bonus_type', 'currency'),
    signupBonus: Number(getSetting('referral_signup_bonus', '0')),
    signupBonusCurrency: getSetting('referral_signup_bonus_currency', 'LNDC'),
    signupBonusCardId: getSetting('referral_signup_bonus_card_id', '') || null,
  };
}
export function setReferralSettings({ percent, signupBonusType, signupBonus, signupBonusCurrency, signupBonusCardId }) {
  setSetting('referral_percent', String(Number(percent) || 0));
  setSetting('referral_signup_bonus_type', signupBonusType === 'card' ? 'card' : 'currency');
  setSetting('referral_signup_bonus', String(Number(signupBonus) || 0));
  setSetting('referral_signup_bonus_currency', (signupBonusCurrency || 'LNDC').toUpperCase());
  setSetting('referral_signup_bonus_card_id', signupBonusCardId ? String(Number(signupBonusCardId)) : '');
}
// One-time flat referral reward — given to the inviter the moment a new user opens the app via the invite link.
// Whatever the admin picked in the panel: a currency amount (LNDC by default, or any other active currency),
// or a specific game card gifted straight into the inviter's collection.
export function payReferralSignupBonus(referrerTgId, newUserTgId) {
  const { signupBonusType: type, signupBonus: bonus, signupBonusCurrency: currency, signupBonusCardId: cardId } = getReferralSettings();
  const reason = `New member invite reward (${newUserTgId})`;
  if (type === 'card') {
    if (!cardId) return;
    grantReferralCardReward(referrerTgId, Number(cardId));
    return;
  }
  if (!bonus || bonus <= 0) return;
  if (!currency || currency === 'LNDC') creditReferralEarnings(referrerTgId, bonus, reason, newUserTgId);
  else adjustCurrencyBalance(referrerTgId, currency, bonus, reason);
}
// Grants one copy of a game card as the referral reward. Mirrors game-db.js's grantCardInstance logic
// exactly (this card's level general power, or its own fixed_power if it's an instant-level special
// card) via the shared `db` connection, kept local to this file to avoid a circular import between
// db.js and game-db.js. Card power is determined only by the general Power-per-level system — no
// per-card override exists anywhere in the system anymore.
function grantReferralCardReward(tgId, cardId) {
  const card = db.prepare('SELECT * FROM game_cards WHERE id = ?').get(cardId);
  if (!card) return;
  const level = card.instant_level || 1;
  let power = card.fixed_power;
  if (power == null) {
    const range = db.prepare('SELECT * FROM card_level_power WHERE level = ?').get(level);
    power = range ? range.min_power : card.base_power;
  }
  db.prepare('INSERT INTO user_cards (tg_id, card_id, level, rolled_power) VALUES (?,?,?,?)').run(tgId, cardId, level, power);
}

export function getReferralInfo(tgId) {
  const invited = db.prepare('SELECT tg_id, username, first_name, created_at FROM users WHERE referred_by = ? ORDER BY created_at DESC').all(tgId);
  const totalEarned = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE tg_id = ? AND direction = 'in' AND reason LIKE 'Commission%'`).get(tgId).s;
  // lockedSummary: this user's OWN pending earnings, one entry per invited person still gating a
  // slice of it. myOwnRequirement: only relevant if this user was themselves invited by someone else
  // (whether THEIR battle activity is what some other inviter's payout is waiting on) — shown mainly
  // so a referred user understands why they personally might see a "go battle" prompt.
  return {
    invited, invitedCount: invited.length, totalEarned,
    lockedSummary: getReferrerLockedSummary(tgId),
    myOwnRequirement: getReferralWithdrawalRequirement(tgId),
  };
}
// Referral leaderboard "season" — a reset here only changes which invites COUNT toward the
// competitive ranking; it never touches referred_by relationships, commission totals, or LNDC
// balances (those stay exactly as getReferralInfo already reports them, lifetime).
db.exec(`
CREATE TABLE IF NOT EXISTS referral_leaderboard_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  period_started_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO referral_leaderboard_state (id) VALUES (1);
`);
function getReferralLeaderboardPeriodStart() {
  return db.prepare('SELECT period_started_at FROM referral_leaderboard_state WHERE id = 1').get().period_started_at;
}
// Resets the referral leaderboard's ranking to zero for everyone by moving the "counts from" line
// up to now — a person's own lifetime invited count, commission earnings, and LNDC balance are
// completely unaffected; only which invites are recent enough to count toward the leaderboard rank.
export function resetReferralLeaderboard() {
  db.prepare(`UPDATE referral_leaderboard_state SET period_started_at = datetime('now') WHERE id = 1`).run();
}
// Ranks every user who has invited at least one other person, by how many people they've invited
// (ties broken by whoever reached that count first — lower tg_id has no special meaning, it's just
// a stable, deterministic tiebreaker rather than an arbitrary re-sort on every request). Only counts
// invites since the leaderboard's last reset — see resetReferralLeaderboard() above.
export function getReferralLeaderboard(limit = 50) {
  const since = getReferralLeaderboardPeriodStart();
  return db.prepare(`
    SELECT u.tg_id, u.username, u.first_name,
      (SELECT COUNT(*) FROM users r WHERE r.referred_by = u.tg_id AND r.created_at >= ?) AS invited_count
    FROM users u
    WHERE (SELECT COUNT(*) FROM users r WHERE r.referred_by = u.tg_id AND r.created_at >= ?) > 0
    ORDER BY invited_count DESC, u.tg_id ASC
    LIMIT ?
  `).all(since, since, limit);
}
// This user's own position on that same leaderboard, even if they're not in the top `limit` shown
// to everyone — computed as "how many other inviters have strictly more invites than me, plus one".
export function getMyReferralRank(tgId) {
  const since = getReferralLeaderboardPeriodStart();
  const invitedCount = db.prepare('SELECT COUNT(*) c FROM users WHERE referred_by = ? AND created_at >= ?').get(tgId, since).c;
  if (invitedCount === 0) return { rank: null, invitedCount: 0 };
  const higher = db.prepare(`
    SELECT COUNT(*) c FROM (
      SELECT referred_by FROM users WHERE referred_by IS NOT NULL AND created_at >= ? GROUP BY referred_by HAVING COUNT(*) > ?
    )
  `).get(since, invitedCount).c;
  return { rank: higher + 1, invitedCount };
}

/* =========================================================================
 * CURRENCIES (manual — admin sets everything)
 * ========================================================================= */
export function listCurrencies(onlyActive = false) {
  return onlyActive
    ? db.prepare('SELECT * FROM currencies WHERE active = 1').all()
    : db.prepare('SELECT * FROM currencies').all();
}
export function getCurrency(code) {
  return db.prepare('SELECT * FROM currencies WHERE code = ?').get(code);
}
export function upsertCurrency({ code, name, rate_toman, min_deposit, min_withdraw, active, deposit_address }) {
  // 2-decimal precision everywhere — including the admin-set rate and deposit/withdraw limits —
  // instead of forcing every currency setting to a whole number.
  const rate = round2(rate_toman);
  const minDep = round2(min_deposit);
  const minWd = round2(min_withdraw);
  db.prepare(`
    INSERT INTO currencies (code, name, rate_toman, min_deposit, min_withdraw, active, deposit_address, updated_at)
    VALUES (@code, @name, @rate_toman, @min_deposit, @min_withdraw, @active, @deposit_address, datetime('now'))
    ON CONFLICT(code) DO UPDATE SET
      name = @name, rate_toman = @rate_toman, min_deposit = @min_deposit,
      min_withdraw = @min_withdraw, active = @active, deposit_address = @deposit_address, updated_at = datetime('now')
  `).run({ code, name, rate_toman: rate, min_deposit: minDep, min_withdraw: minWd, active: active ? 1 : 0, deposit_address: deposit_address || null });
}
// LNDC (Lando Coin) is the bot's built-in main currency — it isn't a row in this table at all
// (it lives on users.balance_toman), so it can never be reached/deleted through this function.
export function deleteCurrency(code) {
  const up = String(code || '').toUpperCase();
  if (up === 'LNDC') throw new Error('Lando Coin is the main currency and cannot be deleted');
  db.prepare('DELETE FROM currencies WHERE code = ?').run(up);
  db.prepare('DELETE FROM wallet_balances WHERE currency_code = ?').run(up);
}

export function getCurrencyBalance(tgId, code) {
  const row = db.prepare('SELECT amount FROM wallet_balances WHERE tg_id = ? AND currency_code = ?').get(tgId, code);
  return row?.amount || 0;
}
// Wallet amounts support 2 decimal places (the bot's standard currency precision) instead of being
// forced to whole numbers, so fees/conversions/partial amounts aren't silently rounded away.
export function adjustCurrencyBalance(tgId, code, amount, reason) {
  const amt = round2(amount);
  db.prepare(`
    INSERT INTO wallet_balances (tg_id, currency_code, amount) VALUES (?,?,?)
    ON CONFLICT(tg_id, currency_code) DO UPDATE SET amount = amount + excluded.amount
  `).run(tgId, code, amt);
  logLedger(tgId, code, amt >= 0 ? 'in' : 'out', Math.abs(amt), reason);
}
export function getWalletBalances(tgId) {
  const rows = db.prepare('SELECT currency_code, amount FROM wallet_balances WHERE tg_id = ?').all(tgId);
  const map = {};
  rows.forEach(r => { map[r.currency_code] = r.amount; });
  return map;
}

/* ---- manual toman top-up (card-to-card) ---- */
export function createTomanTopup(tgId, amount, trackingCode) {
  const info = db.prepare(`INSERT INTO toman_topups (tg_id, amount, tracking_code) VALUES (?,?,?)`).run(tgId, amount, trackingCode);
  return info.lastInsertRowid;
}
export function getTomanTopup(id) { return db.prepare('SELECT * FROM toman_topups WHERE id = ?').get(id); }
export function decideTomanTopup(id, approve) {
  const row = getTomanTopup(id);
  if (!row || row.status !== 'pending') return null;
  db.prepare(`UPDATE toman_topups SET status = ?, decided_at = datetime('now') WHERE id = ?`)
    .run(approve ? 'approved' : 'rejected', id);
  if (approve) adjustToman(row.tg_id, row.amount, 'Wallet top-up (card-to-card, approved)');
  return row;
}
export function listPendingTomanTopups() {
  return db.prepare(`SELECT * FROM toman_topups WHERE status = 'pending' ORDER BY created_at ASC`).all();
}

/* ---- manual toman withdraw ---- */
export function createTomanWithdrawal(tgId, amount, cardNumber) {
  const info = db.prepare(`INSERT INTO toman_withdrawals (tg_id, amount, card_number) VALUES (?,?,?)`).run(tgId, amount, cardNumber);
  return info.lastInsertRowid;
}
export function getTomanWithdrawal(id) { return db.prepare('SELECT * FROM toman_withdrawals WHERE id = ?').get(id); }
export function decideTomanWithdrawal(id, approve) {
  const row = getTomanWithdrawal(id);
  if (!row || row.status !== 'pending') return null;
  db.prepare(`UPDATE toman_withdrawals SET status = ?, decided_at = datetime('now') WHERE id = ?`)
    .run(approve ? 'approved' : 'rejected', id);
  if (!approve) adjustToman(row.tg_id, row.amount, 'Refund for rejected withdrawal'); // the blocked amount is returned on request
  return row;
}
export function listPendingTomanWithdrawals() {
  return db.prepare(`SELECT * FROM toman_withdrawals WHERE status = 'pending' ORDER BY created_at ASC`).all();
}

/* ---- manual currency deposit / withdraw ---- */
export function createCurrencyRequest(tgId, code, kind, amount, opts = {}) {
  const amt = round2(amount); // 2-decimal precision, same as the rest of the wallet
  const info = db.prepare(`
    INSERT INTO currency_requests (tg_id, currency_code, kind, amount, tx_hash, address) VALUES (?,?,?,?,?,?)
  `).run(tgId, code, kind, amt, opts.txHash || null, opts.address || null);
  return info.lastInsertRowid;
}
export function getCurrencyRequest(id) { return db.prepare('SELECT * FROM currency_requests WHERE id = ?').get(id); }
export function decideCurrencyRequest(id, approve) {
  const row = getCurrencyRequest(id);
  if (!row || row.status !== 'pending') return null;
  db.prepare(`UPDATE currency_requests SET status = ?, decided_at = datetime('now') WHERE id = ?`)
    .run(approve ? 'approved' : 'rejected', id);
  if (row.kind === 'deposit' && approve) {
    adjustCurrencyBalance(row.tg_id, row.currency_code, row.amount, `${row.currency_code} deposit approved`);
  }
  if (row.kind === 'withdraw' && !approve) {
    adjustCurrencyBalance(row.tg_id, row.currency_code, row.amount, 'Refund of rejected withdrawal'); // the blocked amount is returned
  }
  return row;
}
export function listPendingCurrencyRequests() {
  return db.prepare(`SELECT * FROM currency_requests WHERE status = 'pending' ORDER BY created_at ASC`).all();
}

/* =========================================================================
 * PRODUCTS / CATEGORIES / ORDERS
 * ========================================================================= */
export function listCategories() { return db.prepare('SELECT * FROM categories ORDER BY id').all(); }
export function addCategory(title) { return db.prepare('INSERT INTO categories (title) VALUES (?)').run(title).lastInsertRowid; }
export function deleteCategory(id) { db.prepare('DELETE FROM categories WHERE id = ?').run(id); }

export function listProducts(onlyActive = true) {
  return onlyActive
    ? db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY id DESC').all()
    : db.prepare('SELECT * FROM products ORDER BY id DESC').all();
}
export function getProduct(id) { return db.prepare('SELECT * FROM products WHERE id = ?').get(id); }
export function upsertProduct(p) {
  if (p.id) {
    db.prepare(`UPDATE products SET title=?, description=?, image_url=?, price_toman=?, category_id=?, active=? WHERE id=?`)
      .run(p.title, p.description || null, p.image_url || null, p.price_toman, p.category_id || null, p.active ? 1 : 0, p.id);
    return p.id;
  }
  return db.prepare(`INSERT INTO products (title, description, image_url, price_toman, category_id, active) VALUES (?,?,?,?,?,?)`)
    .run(p.title, p.description || null, p.image_url || null, p.price_toman, p.category_id || null, p.active ? 1 : 0).lastInsertRowid;
}
export function deleteProduct(id) { db.prepare('DELETE FROM products WHERE id = ?').run(id); }

export function createOrder(tgId, productId, qty, totalToman, note) {
  return db.prepare(`INSERT INTO orders (tg_id, product_id, qty, total_toman, note) VALUES (?,?,?,?,?)`)
    .run(tgId, productId, qty, totalToman, note || null).lastInsertRowid;
}
export function listOrdersForUser(tgId) {
  return db.prepare('SELECT o.*, p.title AS product_title FROM orders o JOIN products p ON p.id = o.product_id WHERE o.tg_id = ? ORDER BY o.created_at DESC').all(tgId);
}
export function listAllOrders() {
  return db.prepare('SELECT o.*, p.title AS product_title FROM orders o JOIN products p ON p.id = o.product_id ORDER BY o.created_at DESC LIMIT 200').all();
}
export function setOrderStatus(id, status) { db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id); }

/* =========================================================================
 * GIFT MARKET — Consignment market for real gifts between users
 * ========================================================================= */
export function createGiftOffer(sellerTgId, title, imageUrl, priceToman, serialNumber, link) {
  if (!serialNumber || !String(serialNumber).trim()) throw new Error('Serial/model number is required');
  if (!link || !String(link).trim()) throw new Error('Gift link is required');
  if (!title || !String(title).trim()) throw new Error('Gift title is required');
  // The gift type/category is derived automatically from the fetched NFT name — first time a given
  // gift type is listed it's auto-registered as a category (using the fetched artwork as its default
  // image); the admin can still block a specific type later by deactivating its category.
  const category = getOrCreateGiftCategoryFromName(title, imageUrl);
  if (!category.active) throw new Error('This gift type is not currently accepted for listing');
  // New listings must first be approved by the admin before showing up in the market
  return db.prepare(`INSERT INTO gift_offers (seller_tg_id, title, image_url, price_toman, serial_number, link, status) VALUES (?,?,?,?,?,?,'pending')`)
    .run(sellerTgId, title, imageUrl || null, priceToman, serialNumber || null, link || null).lastInsertRowid;
}
// COALESCE falls back to the gift's category artwork whenever a specific listing's own image_url is
// empty (e.g. an older listing from before the image-required flow, or a one-off manual entry) —
// so a gift is never shown with no image at all as long as its category has one. Also surfaces the
// seller's existing display name (was already stored as seller_tg_id, just never joined to a
// name before) purely so the UI can show "who's selling this" — no new data captured.
export function getGiftOffer(id) {
  return db.prepare(`
    SELECT go.*, COALESCE(go.image_url, gc.image_url) AS image_url, u.first_name AS seller_first_name, u.username AS seller_username
    FROM gift_offers go LEFT JOIN gift_categories gc ON gc.name = go.title LEFT JOIN users u ON u.tg_id = go.seller_tg_id
    WHERE go.id = ?
  `).get(id);
}
export function listMyGiftOffers(tgId) {
  return db.prepare(`
    SELECT go.*, COALESCE(go.image_url, gc.image_url) AS image_url, u.first_name AS seller_first_name, u.username AS seller_username
    FROM gift_offers go LEFT JOIN gift_categories gc ON gc.name = go.title LEFT JOIN users u ON u.tg_id = go.seller_tg_id
    WHERE go.seller_tg_id = ? OR go.buyer_tg_id = ? ORDER BY go.created_at DESC
  `).all(tgId, tgId);
}
export function listMarketGiftOffers(excludeTgId) {
  return db.prepare(`
    SELECT go.*, COALESCE(go.image_url, gc.image_url) AS image_url, u.first_name AS seller_first_name, u.username AS seller_username
    FROM gift_offers go LEFT JOIN gift_categories gc ON gc.name = go.title LEFT JOIN users u ON u.tg_id = go.seller_tg_id
    WHERE go.status = 'active' AND go.seller_tg_id != ? ORDER BY go.created_at DESC
  `).all(excludeTgId);
}
export function cancelGiftOffer(tgId, id) {
  const offer = getGiftOffer(id);
  if (!offer || offer.seller_tg_id !== tgId) throw new Error('This listing does not belong to you');
  if (offer.status !== 'active' && offer.status !== 'pending') throw new Error('This listing can no longer be cancelled');
  db.prepare(`UPDATE gift_offers SET status = 'cancelled' WHERE id = ?`).run(id);
}
// Listing edited by seller — needs re-approval after editing
export function updateGiftOffer(tgId, id, { title, image_url, price_toman, serial_number, link }) {
  if (!serial_number || !String(serial_number).trim()) throw new Error('Serial/model number is required');
  if (!link || !String(link).trim()) throw new Error('Gift link is required');
  if (!title || !String(title).trim()) throw new Error('Gift title is required');
  const offer = getGiftOffer(id);
  if (!offer || offer.seller_tg_id !== tgId) throw new Error('This listing does not belong to you');
  if (offer.status !== 'active' && offer.status !== 'pending') throw new Error('This listing cannot be edited in its current state');
  const category = getOrCreateGiftCategoryFromName(title, image_url);
  if (!category.active) throw new Error('This gift type is not currently accepted for listing');
  db.prepare(`
    UPDATE gift_offers SET title=?, image_url=?, price_toman=?, serial_number=?, link=?, status='pending' WHERE id=?
  `).run(title, image_url || null, price_toman, serial_number || null, link || null, id);
}
export function reserveGiftOffer(buyerTgId, id) {
  const offer = getGiftOffer(id);
  if (!offer || offer.status !== 'active') throw new Error('This listing is not available');
  if (offer.seller_tg_id === buyerTgId) throw new Error('You cannot buy your own listing');
  const buyer = getUser(buyerTgId);
  if (buyer.balance_toman < offer.price_toman) throw new Error('Insufficient wallet balance');

  adjustToman(buyerTgId, -offer.price_toman, `Reserved purchase of gift "${offer.title}" (consignment)`);
  db.prepare(`UPDATE gift_offers SET status = 'reserved', buyer_tg_id = ?, reserved_at = datetime('now') WHERE id = ?`)
    .run(buyerTgId, id);
  return getGiftOffer(id);
}
export function confirmGiftReceived(buyerTgId, id, feePercent) {
  const offer = getGiftOffer(id);
  if (!offer || offer.status !== 'reserved' || offer.buyer_tg_id !== buyerTgId) throw new Error('This listing cannot be approved');
  const fee = round2((offer.price_toman * feePercent) / 100);
  const sellerReceives = round2(offer.price_toman - fee);
  adjustToman(offer.seller_tg_id, sellerReceives, `Sale of gift "${offer.title}" (consignment, after buyer confirmation)`);
  db.prepare(`UPDATE gift_offers SET status = 'completed', completed_at = datetime('now') WHERE id = ?`).run(id);
  return { ...offer, sellerReceives };
}
export function getCompletedSalesCount(sellerTgId) {
  return db.prepare(`SELECT COUNT(*) c FROM gift_offers WHERE seller_tg_id = ? AND status = 'completed'`).get(sellerTgId).c;
}
export function listAllGiftOffersAdmin() {
  return db.prepare('SELECT * FROM gift_offers ORDER BY created_at DESC LIMIT 200').all();
}
export function listPendingGiftOffers() {
  return db.prepare(`SELECT * FROM gift_offers WHERE status = 'pending' ORDER BY created_at ASC`).all();
}
export function approveGiftOffer(id) {
  const offer = getGiftOffer(id);
  if (!offer || offer.status !== 'pending') throw new Error('This listing is not pending approval');
  db.prepare(`UPDATE gift_offers SET status = 'active' WHERE id = ?`).run(id);
}
export function rejectGiftOffer(id) {
  const offer = getGiftOffer(id);
  if (!offer || offer.status !== 'pending') throw new Error('This listing is not pending approval');
  db.prepare(`UPDATE gift_offers SET status = 'cancelled' WHERE id = ?`).run(id);
}
// Listing fully removed by admin (in any state) — if it was reserved, the money is refunded to the buyer
export function adminDeleteGiftOffer(id) {
  const offer = getGiftOffer(id);
  if (!offer) throw new Error('Listing not found');
  if (offer.status === 'reserved') {
    adjustToman(offer.buyer_tg_id, offer.price_toman, `Listing removed by admin — refund «${offer.title}»`);
  }
  db.prepare('DELETE FROM gift_offers WHERE id = ?').run(id);
}
// For admin dispute resolution: refunding the buyer (e.g. the gift never arrived)
export function adminRefundGiftOffer(id) {
  const offer = getGiftOffer(id);
  if (!offer || offer.status !== 'reserved') throw new Error('This listing is not reserved');
  adjustToman(offer.buyer_tg_id, offer.price_toman, `Refund by support — gift «${offer.title}»`);
  db.prepare(`UPDATE gift_offers SET status = 'cancelled' WHERE id = ?`).run(id);
}

/* =========================================================================
 * TASKS
 * ========================================================================= */
export function listActiveTasks() { return db.prepare('SELECT * FROM tasks WHERE active = 1 ORDER BY id DESC').all(); }
export function listAllTasksAdmin() { return db.prepare('SELECT * FROM tasks ORDER BY id DESC').all(); }
export function getTask(id) { return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id); }
export function upsertTask(t) {
  if (t.id) {
    db.prepare(`UPDATE tasks SET title=?, kind=?, channel_username=?, description=?, link=?, reward_toman=?, active=? WHERE id=?`)
      .run(t.title, t.kind, t.channel_username || null, t.description || null, t.link || null, t.reward_toman, t.active ? 1 : 0, t.id);
    return t.id;
  }
  return db.prepare(`INSERT INTO tasks (title, kind, channel_username, description, link, reward_toman, active) VALUES (?,?,?,?,?,?,?)`)
    .run(t.title, t.kind, t.channel_username || null, t.description || null, t.link || null, t.reward_toman, t.active ? 1 : 0).lastInsertRowid;
}
export function deleteTask(id) { db.prepare('DELETE FROM tasks WHERE id = ?').run(id); }
export function hasClaimedTask(tgId, taskId) { return !!db.prepare('SELECT 1 FROM task_claims WHERE tg_id = ? AND task_id = ?').get(tgId, taskId); }
export function claimTask(tgId, task) {
  db.prepare('INSERT INTO task_claims (tg_id, task_id) VALUES (?,?)').run(tgId, task.id);
  if (task.reward_toman > 0) adjustToman(tgId, task.reward_toman, `Task completion reward: ${task.title}`);
}

/* =========================================================================
 * SUPPORT TICKETS
 * ========================================================================= */
export function getOrCreateOpenTicket(tgId) {
  let ticket = db.prepare(`SELECT * FROM tickets WHERE tg_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1`).get(tgId);
  if (!ticket) {
    const id = db.prepare('INSERT INTO tickets (tg_id) VALUES (?)').run(tgId).lastInsertRowid;
    ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
  }
  return ticket;
}
export function addTicketMessage(ticketId, sender, body, imageUrl) {
  db.prepare('INSERT INTO ticket_messages (ticket_id, sender, body, image_url) VALUES (?,?,?,?)').run(ticketId, sender, body || null, imageUrl || null);
}
export function listTicketMessages(ticketId) {
  return db.prepare('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC').all(ticketId);
}
export function listMyTickets(tgId) { return db.prepare('SELECT * FROM tickets WHERE tg_id = ? ORDER BY created_at DESC').all(tgId); }
export function listAllTicketsAdmin() {
  return db.prepare(`
    SELECT t.*, u.first_name, u.username,
      (SELECT body FROM ticket_messages m WHERE m.ticket_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_message
    FROM tickets t JOIN users u ON u.tg_id = t.tg_id
    ORDER BY t.created_at DESC LIMIT 100
  `).all();
}
export function getTicket(id) { return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id); }
export function closeTicket(id) { db.prepare(`UPDATE tickets SET status = 'closed' WHERE id = ?`).run(id); }

/* =========================================================================
 * SETTINGS — Simple values the admin changes from the panel (e.g. the deposit card number)
 * ========================================================================= */
export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
export function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}
export function getSwapFeePercent() {
  return Number(getSetting('swap_fee_percent', process.env.SWAP_FEE_PERCENT || '1'));
}
export function setSwapFeePercent(percent) {
  setSetting('swap_fee_percent', String(Math.max(0, Number(percent) || 0)));
}
export function getGiftMarketMinPrice() {
  return Number(getSetting('gift_market_min_price', '5000'));
}
export function setGiftMarketMinPrice(price) {
  setSetting('gift_market_min_price', String(Math.max(0, Number(price) || 0)));
}

// Custom design images for the mini app's main sections — purely visual branding, set from the admin
// panel. Each key is optional; when empty, that section falls back to its default icon/gradient look.
// UI_IMAGE_KEYS covers hub shortcut cards (small tile background), full section banners, and a few
// other Game Hub cards/teasers that logically support artwork.
const UI_IMAGE_KEYS = [
  'hub_shop', 'hub_wallet', 'hub_market', 'hub_cardgame', 'hub_battlepass', 'hub_clan', 'hub_war', 'hub_plinko', // hub shortcut tiles
  'hub_head_rewards', 'hub_head_market', 'hub_head_shop', 'hub_head_game', 'hub_head_leaderboard', 'hub_head_wallet', // banner photo behind each hub page's header bar
  'banner_clan', 'banner_battlepass', 'banner_events', 'banner_wheel', // full-width banners at the top of a section's own page
  'card_missions', 'card_leaderboard', // Game Hub quick-access card artwork
  'loading_screen', // shown centered above the boot progress bar while the app first loads
  'war_map', // Tower War interactive map background — tiled/stretched behind the towers
];
export function getUiImages() {
  const out = {};
  for (const key of UI_IMAGE_KEYS) out[key] = getSetting('ui_image_' + key, '');
  return out;
}
export function setUiImages(images) {
  for (const key of UI_IMAGE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(images || {}, key)) setSetting('ui_image_' + key, images[key] || '');
  }
}

export function getPaymentSettings() {
  return {
    cardNumber: getSetting('card_number', process.env.ADMIN_CARD_NUMBER || ''),
    cardOwner: getSetting('card_owner', process.env.ADMIN_CARD_OWNER || ''),
  };
}
export function setPaymentSettings({ cardNumber, cardOwner }) {
  setSetting('card_number', cardNumber || '');
  setSetting('card_owner', cardOwner || '');
}

// Enable/disable deposit and withdrawal of the bot's default/main currency (Lando Coin / LNDC).
// LNDC itself always stays the main currency — this only toggles whether users can top up or
// cash out, independently of each other. Defaults to both enabled.
export function getLndcWalletSettings() {
  return {
    depositEnabled: getSetting('lndc_deposit_enabled', '1') === '1',
    withdrawEnabled: getSetting('lndc_withdraw_enabled', '1') === '1',
  };
}
export function setLndcWalletSettings({ depositEnabled, withdrawEnabled }) {
  setSetting('lndc_deposit_enabled', depositEnabled ? '1' : '0');
  setSetting('lndc_withdraw_enabled', withdrawEnabled ? '1' : '0');
}

// The Telegram ID/username the user's support button links directly to (instead of an internal ticket)
export function getSupportContact() {
  return getSetting('support_username', process.env.SUPPORT_USERNAME || '');
}
export function setSupportContact(username) {
  setSetting('support_username', (username || '').replace(/^@/, ''));
}

// Info page text (guide/FAQ/rules) — editable from the admin panel
export function getInfoPage(key) { return getSetting('info_' + key, ''); }
export function setInfoPage(key, content) { setSetting('info_' + key, content || ''); }

const DEFAULT_WELCOME = 'Welcome to <b>Lando Gifts</b> 🎁\nUse the button below to open the shop:';
const DEFAULT_JOIN_PROMPT = 'To use the bot, first join our channel:';
// Cached in memory since /start reads this on every single invocation — a plain object with a
// version counter invalidated by setMessageSettings, so we don't hit SQLite twice per /start for
// text that changes maybe once a year.
let messageSettingsCache = null;
export function getMessageSettings() {
  if (messageSettingsCache) return messageSettingsCache;
  messageSettingsCache = {
    welcomeMessage: getSetting('welcome_message', DEFAULT_WELCOME),
    joinPromptMessage: getSetting('join_prompt_message', DEFAULT_JOIN_PROMPT),
  };
  return messageSettingsCache;
}
export function setMessageSettings({ welcomeMessage, joinPromptMessage }) {
  setSetting('welcome_message', welcomeMessage || DEFAULT_WELCOME);
  setSetting('join_prompt_message', joinPromptMessage || DEFAULT_JOIN_PROMPT);
  messageSettingsCache = null;
}

// Zarinpal integration has been fully removed. Drop its table so no leftover payment records or
// settings remain in the database.
try { db.exec('DROP TABLE IF EXISTS zarinpal_payments'); } catch (e) {}

/* =========================================================================
 * DASHBOARD STATS
 * ========================================================================= */
export function getStats() {
  const users = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const orders = db.prepare('SELECT COUNT(*) c FROM orders').get().c;
  const totalToman = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE currency_code='LNDC' AND direction='in'`).get().s;
  const pendingTopups = db.prepare(`SELECT COUNT(*) c FROM toman_topups WHERE status='pending'`).get().c;
  const pendingCurrency = db.prepare(`SELECT COUNT(*) c FROM currency_requests WHERE status='pending'`).get().c;
  const openTickets = db.prepare(`SELECT COUNT(*) c FROM tickets WHERE status='open'`).get().c;
  return { users, orders, totalToman, pendingTopups, pendingCurrency, openTickets };
}

export function getAllUserIds() {
  return db.prepare('SELECT tg_id FROM users').all().map(r => r.tg_id);
}

/* =========================================================================
 * Comeback notifications — if a user hasn't opened the mini app in a while, send them a Telegram
 * message (optionally with a small LNDC reward) to bring them back. A background scheduler in
 * server.js calls findUsersDueForComebackReminder() periodically and sends to whoever qualifies.
 * ========================================================================= */
safeAddColumn('users', 'last_comeback_reminder_at TEXT'); // when we last sent this user a comeback reminder — prevents repeat spam
// Referral earnings held back from the spendable balance until a per-user battle requirement (set
// from the admin panel) is met — see the referral withdrawal requirement functions below. Money
// here is NOT part of balance_toman and can't be touched by any withdraw/spend endpoint until it's
// released into balance_toman by checkAndUnlockReferralBalance.
safeAddColumn('users', 'referral_locked_toman REAL NOT NULL DEFAULT 0'); // legacy column, no longer written to — locked referral amounts are now tracked per invited user in referral_locked_earnings (see below) so unlocking one invitee never releases money tied to a different one
db.exec(`
CREATE TABLE IF NOT EXISTS comeback_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  inactive_days INTEGER NOT NULL DEFAULT 3,   -- how many days of no activity before we consider them "gone"
  reward_toman INTEGER NOT NULL DEFAULT 0,    -- 0 = no reward, just the message
  message TEXT NOT NULL DEFAULT 'We miss you! Come back and claim a little gift 🎁',
  cooldown_days INTEGER NOT NULL DEFAULT 14   -- don't remind the same user again within this many days
);
INSERT OR IGNORE INTO comeback_config (id) VALUES (1);
`);
export function getComebackConfig() { return db.prepare('SELECT * FROM comeback_config WHERE id = 1').get(); }
export function setComebackConfig(c) {
  db.prepare(`UPDATE comeback_config SET enabled=?, inactive_days=?, reward_toman=?, message=?, cooldown_days=? WHERE id = 1`)
    .run(c.enabled ? 1 : 0, Math.max(1, Number(c.inactive_days) || 3), Math.max(0, Number(c.reward_toman) || 0), c.message || '', Math.max(1, Number(c.cooldown_days) || 14));
}
// Users who've been inactive long enough and either never got a reminder, or their last one was
// far enough in the past (cooldown) — this is the only place this table is queried, kept here next
// to the column/config it depends on rather than duplicated at each call site.
export function findUsersDueForComebackReminder() {
  const cfg = getComebackConfig();
  if (!cfg.enabled) return [];
  return db.prepare(`
    SELECT tg_id FROM users
    WHERE is_banned = 0
      AND last_seen_at < datetime('now', ?)
      AND (last_comeback_reminder_at IS NULL OR last_comeback_reminder_at < datetime('now', ?))
  `).all(`-${cfg.inactive_days} days`, `-${cfg.cooldown_days} days`).map(r => r.tg_id);
}
export function markComebackReminderSent(tgId) {
  db.prepare(`UPDATE users SET last_comeback_reminder_at = datetime('now') WHERE tg_id = ?`).run(tgId);
}

export default db;
