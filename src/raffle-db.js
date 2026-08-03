import db from './db.js';
import { adjustToman, getUser, hasClaimedTask, getTask } from './db.js';

/* =========================================================================
 * گردونهٔ بزرگ (قرعه‌کشی) — کاملا جدا از چرخ شانس روزانه.
 * کاربر ثبت‌نام می‌کنه (شاید نیازمند انجام یه تسک مشخص باشه)، می‌تونه با خرید
 * بلیط شانسش رو بیشتر کنه، و وقتی ادمین «اتمام قرعه» رو می‌زنه، به تعداد
 * برنده‌های تعیین‌شده به‌صورت وزن‌دار (بر اساس تعداد بلیط) قرعه‌کشی می‌شه.
 * جایزه‌ها واریز دستی توسط ادمینه، اینجا فقط آیدی برنده‌ها نشون داده می‌شه.
 * ========================================================================= */
db.exec(`
CREATE TABLE IF NOT EXISTS raffles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  prize_description TEXT,
  capacity INTEGER NOT NULL DEFAULT 100,
  winners_count INTEGER NOT NULL DEFAULT 10,
  required_task_id INTEGER,
  ticket_price_toman INTEGER NOT NULL DEFAULT 0,
  max_tickets_per_user INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open', -- open | finished | cancelled
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS raffle_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raffle_id INTEGER NOT NULL,
  tg_id INTEGER NOT NULL,
  tickets INTEGER NOT NULL DEFAULT 1,
  is_winner INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(raffle_id, tg_id)
);
`);

export function listRafflesAdmin() { return db.prepare('SELECT * FROM raffles ORDER BY id DESC').all(); }
export function getRaffle(id) { return db.prepare('SELECT * FROM raffles WHERE id = ?').get(id); }
export function listOpenRaffles() { return db.prepare(`SELECT * FROM raffles WHERE status = 'open' ORDER BY id DESC`).all(); }

export function createRaffle(r) {
  return db.prepare(`
    INSERT INTO raffles (title, prize_description, capacity, winners_count, required_task_id, ticket_price_toman, max_tickets_per_user)
    VALUES (?,?,?,?,?,?,?)
  `).run(r.title, r.prize_description || null, Number(r.capacity) || 100, Number(r.winners_count) || 10,
    r.required_task_id ? Number(r.required_task_id) : null, Number(r.ticket_price_toman) || 0, Number(r.max_tickets_per_user) || 1
  ).lastInsertRowid;
}
export function updateRaffle(id, r) {
  const raffle = getRaffle(id);
  if (!raffle) throw new Error('گردونه پیدا نشد');
  if (raffle.status !== 'open') throw new Error('این گردونه دیگه باز نیست');
  db.prepare(`
    UPDATE raffles SET title=?, prize_description=?, capacity=?, winners_count=?, required_task_id=?, ticket_price_toman=?, max_tickets_per_user=?
    WHERE id=?
  `).run(r.title, r.prize_description || null, Number(r.capacity) || 100, Number(r.winners_count) || 10,
    r.required_task_id ? Number(r.required_task_id) : null, Number(r.ticket_price_toman) || 0, Number(r.max_tickets_per_user) || 1, id);
}
export function deleteRaffle(id) {
  db.prepare('DELETE FROM raffle_entries WHERE raffle_id = ?').run(id);
  db.prepare('DELETE FROM raffles WHERE id = ?').run(id);
}
export function cancelRaffle(id) {
  db.prepare(`UPDATE raffles SET status = 'cancelled' WHERE id = ?`).run(id);
}

function getEntry(raffleId, tgId) {
  return db.prepare('SELECT * FROM raffle_entries WHERE raffle_id = ? AND tg_id = ?').get(raffleId, tgId);
}
export function listRaffleEntries(raffleId) {
  return db.prepare(`
    SELECT re.*, u.first_name, u.username FROM raffle_entries re JOIN users u ON u.tg_id = re.tg_id
    WHERE re.raffle_id = ? ORDER BY re.created_at ASC
  `).all(raffleId);
}
export function getRaffleStatusForUser(raffleId, tgId) {
  const raffle = getRaffle(raffleId);
  if (!raffle) return null;
  const entriesCount = db.prepare('SELECT COUNT(*) c FROM raffle_entries WHERE raffle_id = ?').get(raffleId).c;
  const myEntry = getEntry(raffleId, tgId);
  const taskDone = raffle.required_task_id ? hasClaimedTask(tgId, raffle.required_task_id) : true;
  const requiredTask = raffle.required_task_id ? getTask(raffle.required_task_id) : null;
  return { raffle, entriesCount, myEntry, taskDone, requiredTask };
}

// ثبت‌نام اولیه (رایگان، فقط اگه تسک لازم انجام شده باشه و ظرفیت خالی باشه) — همیشه ۱ بلیط پایه می‌ده
export function registerForRaffle(tgId, raffleId) {
  const raffle = getRaffle(raffleId);
  if (!raffle || raffle.status !== 'open') throw new Error('این گردونه فعلا باز نیست');
  if (getEntry(raffleId, tgId)) throw new Error('قبلا تو این گردونه ثبت‌نام کردی');
  const entriesCount = db.prepare('SELECT COUNT(*) c FROM raffle_entries WHERE raffle_id = ?').get(raffleId).c;
  if (entriesCount >= raffle.capacity) throw new Error('ظرفیت این گردونه تکمیل شده');
  if (raffle.required_task_id && !hasClaimedTask(tgId, raffle.required_task_id)) {
    throw new Error('اول باید تسک لازم برای ورود رو انجام بدی');
  }
  db.prepare('INSERT INTO raffle_entries (raffle_id, tg_id, tickets) VALUES (?,?,1)').run(raffleId, tgId);
}

// خرید بلیط اضافه برای افزایش شانس (تا سقف max_tickets_per_user)
export function buyRaffleTicket(tgId, raffleId) {
  const raffle = getRaffle(raffleId);
  if (!raffle || raffle.status !== 'open') throw new Error('این گردونه فعلا باز نیست');
  if (!raffle.ticket_price_toman) throw new Error('خرید بلیط برای این گردونه فعال نیست');
  const entry = getEntry(raffleId, tgId);
  if (!entry) throw new Error('اول باید تو گردونه ثبت‌نام کنی');
  if (entry.tickets >= raffle.max_tickets_per_user) throw new Error('به سقف تعداد بلیط مجاز رسیدی');
  const user = getUser(tgId);
  if (!user || user.balance_toman < raffle.ticket_price_toman) throw new Error('موجودی کیف‌پول کافی نیست');
  const tx = db.transaction(() => {
    adjustToman(tgId, -raffle.ticket_price_toman, `خرید بلیط گردونهٔ «${raffle.title}»`);
    db.prepare('UPDATE raffle_entries SET tickets = tickets + 1 WHERE raffle_id = ? AND tg_id = ?').run(raffleId, tgId);
  });
  tx();
}

function drawWeightedWinners(entries, winnersCount) {
  const pool = [];
  entries.forEach(e => { for (let i = 0; i < e.tickets; i++) pool.push(e.tg_id); });
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const winners = [];
  const seen = new Set();
  for (const tgId of pool) {
    if (winners.length >= winnersCount) break;
    if (!seen.has(tgId)) { seen.add(tgId); winners.push(tgId); }
  }
  return winners;
}

// ادمین دکمهٔ «اتمام قرعه» رو می‌زنه — برنده‌ها وزن‌دار (بر اساس تعداد بلیط) انتخاب می‌شن
export function finishRaffle(raffleId) {
  const raffle = getRaffle(raffleId);
  if (!raffle) throw new Error('گردونه پیدا نشد');
  if (raffle.status !== 'open') throw new Error('این گردونه قبلا تموم شده');
  const entries = listRaffleEntries(raffleId);
  const winnerIds = drawWeightedWinners(entries, raffle.winners_count);
  const tx = db.transaction(() => {
    for (const tgId of winnerIds) {
      db.prepare('UPDATE raffle_entries SET is_winner = 1 WHERE raffle_id = ? AND tg_id = ?').run(raffleId, tgId);
    }
    db.prepare(`UPDATE raffles SET status = 'finished', finished_at = datetime('now') WHERE id = ?`).run(raffleId);
  });
  tx();
  return listRaffleEntries(raffleId).filter(e => e.is_winner);
}
