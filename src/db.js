import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'lando-gifts.db'));
db.pragma('journal_mode = WAL');

/* =========================================================================
 * SCHEMA
 * همه‌چیز دستی طراحی شده: قیمت ارزها رو ادمین از پنل ثبت می‌کنه، هیچ درخواست
 * شبکه‌ای به هیچ صرافی یا API قیمتی زده نمی‌شه. واریز/برداشت هم با تایید
 * دستی ادمین انجام میشه، نه اتوماتیک.
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
  currency_code TEXT NOT NULL DEFAULT 'TOMAN',
  direction TEXT NOT NULL,  -- in | out
  amount REAL NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// چند ارز پیش‌فرض (غیرفعال تا ادمین نرخشون رو دستی ثبت کنه)
const seedCurrency = db.prepare(`INSERT OR IGNORE INTO currencies (code, name, rate_toman, min_deposit, min_withdraw, active) VALUES (?,?,?,?,?,0)`);
seedCurrency.run('USDT', 'تتر', 0, 1, 1);
seedCurrency.run('TON', 'تون‌کوین', 0, 0.1, 0.1);

/* =========================================================================
 * USERS
 * ========================================================================= */
function makeRefCode(tgId) {
  return 'L' + crypto.createHash('md5').update(String(tgId) + Date.now()).digest('hex').slice(0, 6).toUpperCase();
}

export function getUser(tgId) {
  return db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tgId);
}

export function getOrCreateUser(tgUser, startParam) {
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

  db.prepare(`INSERT INTO users (tg_id, username, first_name, ref_code, referred_by) VALUES (?,?,?,?,?)`)
    .run(tgUser.id, tgUser.username || null, tgUser.first_name || null, makeRefCode(tgUser.id), referredBy);
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
    return db.prepare(`SELECT * FROM users WHERE CAST(tg_id AS TEXT) LIKE ? OR username LIKE ? OR first_name LIKE ? ORDER BY created_at DESC LIMIT 100`)
      .all(like, like, like);
  }
  return db.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT 100').all();
}

/* =========================================================================
 * LEDGER + TOMAN BALANCE
 * ========================================================================= */
function logLedger(tgId, currencyCode, direction, amount, reason) {
  db.prepare(`INSERT INTO ledger (tg_id, currency_code, direction, amount, reason) VALUES (?,?,?,?,?)`)
    .run(tgId, currencyCode, direction, amount, reason || null);
}

export function adjustToman(tgId, amount, reason) {
  db.prepare(`UPDATE users SET balance_toman = balance_toman + ? WHERE tg_id = ?`).run(amount, tgId);
  logLedger(tgId, 'TOMAN', amount >= 0 ? 'in' : 'out', Math.abs(amount), reason);
}

export function getLedger(tgId, limit = 50) {
  return db.prepare('SELECT * FROM ledger WHERE tg_id = ? ORDER BY created_at DESC LIMIT ?').all(tgId, limit);
}

export function payReferralBonus(tgId, purchaseAmountToman, percent) {
  const user = getUser(tgId);
  if (!user?.referred_by || !percent) return;
  const bonus = Math.floor((purchaseAmountToman * percent) / 100);
  if (bonus <= 0) return;
  adjustToman(user.referred_by, bonus, `پورسانت رفرال از خرید کاربر ${tgId}`);
}

export function getReferralInfo(tgId) {
  const invited = db.prepare('SELECT tg_id, username, first_name, created_at FROM users WHERE referred_by = ? ORDER BY created_at DESC').all(tgId);
  const totalEarned = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE tg_id = ? AND direction = 'in' AND reason LIKE 'پورسانت%'`).get(tgId).s;
  return { invited, invitedCount: invited.length, totalEarned };
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
export function upsertCurrency({ code, name, rate_toman, min_deposit, min_withdraw, active }) {
  db.prepare(`
    INSERT INTO currencies (code, name, rate_toman, min_deposit, min_withdraw, active, updated_at)
    VALUES (@code, @name, @rate_toman, @min_deposit, @min_withdraw, @active, datetime('now'))
    ON CONFLICT(code) DO UPDATE SET
      name = @name, rate_toman = @rate_toman, min_deposit = @min_deposit,
      min_withdraw = @min_withdraw, active = @active, updated_at = datetime('now')
  `).run({ code, name, rate_toman, min_deposit, min_withdraw, active: active ? 1 : 0 });
}

export function getCurrencyBalance(tgId, code) {
  const row = db.prepare('SELECT amount FROM wallet_balances WHERE tg_id = ? AND currency_code = ?').get(tgId, code);
  return row?.amount || 0;
}
export function adjustCurrencyBalance(tgId, code, amount, reason) {
  db.prepare(`
    INSERT INTO wallet_balances (tg_id, currency_code, amount) VALUES (?,?,?)
    ON CONFLICT(tg_id, currency_code) DO UPDATE SET amount = amount + excluded.amount
  `).run(tgId, code, amount);
  logLedger(tgId, code, amount >= 0 ? 'in' : 'out', Math.abs(amount), reason);
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
  if (approve) adjustToman(row.tg_id, row.amount, 'شارژ کیف‌پول (کارت‌به‌کارت، تاییدشده)');
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
  if (!approve) adjustToman(row.tg_id, row.amount, 'بازگشت وجه برداشت ردشده'); // بلوکه‌شده موقع درخواست برمی‌گرده
  return row;
}
export function listPendingTomanWithdrawals() {
  return db.prepare(`SELECT * FROM toman_withdrawals WHERE status = 'pending' ORDER BY created_at ASC`).all();
}

/* ---- manual currency deposit / withdraw ---- */
export function createCurrencyRequest(tgId, code, kind, amount, opts = {}) {
  const info = db.prepare(`
    INSERT INTO currency_requests (tg_id, currency_code, kind, amount, tx_hash, address) VALUES (?,?,?,?,?,?)
  `).run(tgId, code, kind, amount, opts.txHash || null, opts.address || null);
  return info.lastInsertRowid;
}
export function getCurrencyRequest(id) { return db.prepare('SELECT * FROM currency_requests WHERE id = ?').get(id); }
export function decideCurrencyRequest(id, approve) {
  const row = getCurrencyRequest(id);
  if (!row || row.status !== 'pending') return null;
  db.prepare(`UPDATE currency_requests SET status = ?, decided_at = datetime('now') WHERE id = ?`)
    .run(approve ? 'approved' : 'rejected', id);
  if (row.kind === 'deposit' && approve) {
    adjustCurrencyBalance(row.tg_id, row.currency_code, row.amount, `واریز ${row.currency_code} تاییدشده`);
  }
  if (row.kind === 'withdraw' && !approve) {
    adjustCurrencyBalance(row.tg_id, row.currency_code, row.amount, 'بازگشت برداشت ردشده'); // بلوکه‌شده برمی‌گرده
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
 * GIFT MARKET — بازار امانی گیفت‌های واقعی بین کاربران
 * ========================================================================= */
export function createGiftOffer(sellerTgId, title, imageUrl, priceToman) {
  return db.prepare(`INSERT INTO gift_offers (seller_tg_id, title, image_url, price_toman) VALUES (?,?,?,?)`)
    .run(sellerTgId, title, imageUrl || null, priceToman).lastInsertRowid;
}
export function getGiftOffer(id) { return db.prepare('SELECT * FROM gift_offers WHERE id = ?').get(id); }
export function listMyGiftOffers(tgId) {
  return db.prepare('SELECT * FROM gift_offers WHERE seller_tg_id = ? OR buyer_tg_id = ? ORDER BY created_at DESC').all(tgId, tgId);
}
export function listMarketGiftOffers(excludeTgId) {
  return db.prepare(`SELECT * FROM gift_offers WHERE status = 'active' AND seller_tg_id != ? ORDER BY created_at DESC`).all(excludeTgId);
}
export function cancelGiftOffer(tgId, id) {
  const offer = getGiftOffer(id);
  if (!offer || offer.seller_tg_id !== tgId) throw new Error('این آگهی مال شما نیست');
  if (offer.status !== 'active') throw new Error('این آگهی دیگه قابل لغو نیست');
  db.prepare(`UPDATE gift_offers SET status = 'cancelled' WHERE id = ?`).run(id);
}
export function reserveGiftOffer(buyerTgId, id) {
  const offer = getGiftOffer(id);
  if (!offer || offer.status !== 'active') throw new Error('این آگهی در دسترس نیست');
  if (offer.seller_tg_id === buyerTgId) throw new Error('نمی‌تونی آگهی خودت رو بخری');
  const buyer = getUser(buyerTgId);
  if (buyer.balance_toman < offer.price_toman) throw new Error('موجودی کیف‌پول کافی نیست');

  adjustToman(buyerTgId, -offer.price_toman, `رزرو خرید گیفت «${offer.title}» (امانی)`);
  db.prepare(`UPDATE gift_offers SET status = 'reserved', buyer_tg_id = ?, reserved_at = datetime('now') WHERE id = ?`)
    .run(buyerTgId, id);
  return getGiftOffer(id);
}
export function confirmGiftReceived(buyerTgId, id, feePercent) {
  const offer = getGiftOffer(id);
  if (!offer || offer.status !== 'reserved' || offer.buyer_tg_id !== buyerTgId) throw new Error('این آگهی قابل تایید نیست');
  const fee = Math.floor((offer.price_toman * feePercent) / 100);
  const sellerReceives = offer.price_toman - fee;
  adjustToman(offer.seller_tg_id, sellerReceives, `فروش گیفت «${offer.title}» (امانی، پس از تایید خریدار)`);
  db.prepare(`UPDATE gift_offers SET status = 'completed', completed_at = datetime('now') WHERE id = ?`).run(id);
  return { ...offer, sellerReceives };
}
export function listAllGiftOffersAdmin() {
  return db.prepare('SELECT * FROM gift_offers ORDER BY created_at DESC LIMIT 200').all();
}
// ادمین برای رفع اختلاف: برگردوندن پول به خریدار (مثلا گیفت هیچوقت نرسید)
export function adminRefundGiftOffer(id) {
  const offer = getGiftOffer(id);
  if (!offer || offer.status !== 'reserved') throw new Error('این آگهی رزرو نیست');
  adjustToman(offer.buyer_tg_id, offer.price_toman, `بازگشت وجه توسط پشتیبانی — گیفت «${offer.title}»`);
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
    db.prepare(`UPDATE tasks SET title=?, kind=?, channel_username=?, reward_toman=?, active=? WHERE id=?`)
      .run(t.title, t.kind, t.channel_username || null, t.reward_toman, t.active ? 1 : 0, t.id);
    return t.id;
  }
  return db.prepare(`INSERT INTO tasks (title, kind, channel_username, reward_toman, active) VALUES (?,?,?,?,?)`)
    .run(t.title, t.kind, t.channel_username || null, t.reward_toman, t.active ? 1 : 0).lastInsertRowid;
}
export function deleteTask(id) { db.prepare('DELETE FROM tasks WHERE id = ?').run(id); }
export function hasClaimedTask(tgId, taskId) { return !!db.prepare('SELECT 1 FROM task_claims WHERE tg_id = ? AND task_id = ?').get(tgId, taskId); }
export function claimTask(tgId, task) {
  db.prepare('INSERT INTO task_claims (tg_id, task_id) VALUES (?,?)').run(tgId, task.id);
  if (task.reward_toman > 0) adjustToman(tgId, task.reward_toman, `پاداش انجام تسک: ${task.title}`);
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
 * DASHBOARD STATS
 * ========================================================================= */
export function getStats() {
  const users = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const orders = db.prepare('SELECT COUNT(*) c FROM orders').get().c;
  const totalToman = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE currency_code='TOMAN' AND direction='in'`).get().s;
  const pendingTopups = db.prepare(`SELECT COUNT(*) c FROM toman_topups WHERE status='pending'`).get().c;
  const pendingCurrency = db.prepare(`SELECT COUNT(*) c FROM currency_requests WHERE status='pending'`).get().c;
  const openTickets = db.prepare(`SELECT COUNT(*) c FROM tickets WHERE status='open'`).get().c;
  return { users, orders, totalToman, pendingTopups, pendingCurrency, openTickets };
}

export function getAllUserIds() {
  return db.prepare('SELECT tg_id FROM users').all().map(r => r.tg_id);
}

export default db;
