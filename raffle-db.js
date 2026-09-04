import db, { round2 } from './db.js';
import { adjustToman, getUser, hasClaimedTask, getTask } from './db.js';
import crypto from 'crypto';

/* =========================================================================
 * Big wheel (raffle / giveaway) — completely separate from the daily wheel of
 * fortune. A giveaway can hold several distinct gift prizes (each with its own
 * title/image/number — perfect for pasting real Telegram NFT gifts via the
 * NFT-lookup feature). The user registers (may require completing a specific
 * task), can buy any number of extra tickets up to a cap to increase their
 * chance, and either the admin ends it manually or it auto-ends at its
 * deadline — winners are drawn with weighting (based on ticket count) and
 * assigned to prizes in order (1st winner drawn gets the 1st prize, etc).
 *
 * Provably fair: a random server_seed is generated the moment a raffle is created, and only its
 * SHA-256 hash is shown to players (server_seed_hash) — a public commitment made before anyone
 * knows who will enter or how many tickets they'll have. The real server_seed stays hidden until
 * the raffle finishes, at which point the draw itself is deterministically derived from that seed
 * (not Math.random()) and the seed is revealed — so anyone can independently recompute the same
 * shuffle from the entries + revealed seed and confirm the winners weren't picked after the fact.
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
  finished_at TEXT,
  server_seed TEXT,       -- kept hidden from players until the raffle finishes
  server_seed_hash TEXT   -- sha256(server_seed) — shown to players immediately (the "commitment")
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

-- One row per distinct prize in the giveaway (e.g. three different NFT gifts) — winners are
-- assigned to these in draw order once the raffle finishes.
CREATE TABLE IF NOT EXISTS raffle_prizes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raffle_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  image_url TEXT,
  gift_number TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  winner_tg_id INTEGER
);
`);
function safeAddColumn(table, columnDef) {
  const col = columnDef.split(' ')[0];
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
}
// A deadline the giveaway auto-ends at — added after raffles already shipped without one, so
// existing installs need this migration to pick it up (admin-set countdown, like the reference design).
safeAddColumn('raffles', 'ends_at TEXT');
// Two mutually exclusive ways for a user to earn extra tickets beyond their free base ticket — the
// admin picks one per raffle: 'toman' (buy tickets, existing ticket_price_toman/qty flow) or
// 'referral' (1 ticket per successful invite, up to tickets_per_referral each — no LNDC spent).
safeAddColumn('raffles', "ticket_method TEXT NOT NULL DEFAULT 'toman'");
safeAddColumn('raffles', 'tickets_per_referral INTEGER NOT NULL DEFAULT 1');

function sha256Hex(str) { return crypto.createHash('sha256').update(str).digest('hex'); }
// Strips the hidden server_seed from a raffle before it's sent to a player — only revealed once the
// raffle is finished (the hash, which is safe to show from the start, is always kept).
function sanitizeRaffleForClient(raffle) {
  if (!raffle) return raffle;
  if (raffle.status === 'finished') return raffle;
  const { server_seed, ...rest } = raffle;
  return rest;
}
// "Alex Johnson" -> "Al***on" style masking for public leaderboards/winner lists
function maskName(name) {
  const s = String(name || '').trim();
  if (s.length <= 4) return s ? s[0] + '***' : 'Player';
  return s.slice(0, 2) + '***' + s.slice(-2);
}

export function listRafflesAdmin() { return db.prepare('SELECT * FROM raffles ORDER BY id DESC').all(); }
export function getRaffle(id) { return db.prepare('SELECT * FROM raffles WHERE id = ?').get(id); }
export function listOpenRaffles() { return db.prepare(`SELECT * FROM raffles WHERE status = 'open' ORDER BY id DESC`).all(); }
export function listFinishedRaffles(limit = 50) {
  return db.prepare(`SELECT * FROM raffles WHERE status IN ('finished','cancelled') ORDER BY finished_at DESC LIMIT ?`).all(limit);
}

/* ---------- Prizes ---------- */
export function listRafflePrizes(raffleId) {
  return db.prepare('SELECT * FROM raffle_prizes WHERE raffle_id = ? ORDER BY sort_order ASC, id ASC').all(raffleId);
}
export function upsertRafflePrize(p) {
  if (p.id) {
    db.prepare('UPDATE raffle_prizes SET title=?, image_url=?, gift_number=?, sort_order=? WHERE id=?')
      .run(p.title, p.image_url || null, p.gift_number || null, Number(p.sort_order) || 0, p.id);
    return p.id;
  }
  return db.prepare('INSERT INTO raffle_prizes (raffle_id, title, image_url, gift_number, sort_order) VALUES (?,?,?,?,?)')
    .run(p.raffle_id, p.title, p.image_url || null, p.gift_number || null, Number(p.sort_order) || 0).lastInsertRowid;
}
export function deleteRafflePrize(id) { db.prepare('DELETE FROM raffle_prizes WHERE id = ?').run(id); }

// Public log of finished raffles + their winners — for the "recent winners" list in the mini app.
export function listRecentRaffleWinners(limit = 10) {
  const raffles = db.prepare(`SELECT * FROM raffles WHERE status = 'finished' ORDER BY finished_at DESC LIMIT ?`).all(limit);
  return raffles.map(r => ({
    id: r.id, title: r.title, prize_description: r.prize_description, finished_at: r.finished_at,
    server_seed: r.server_seed, server_seed_hash: r.server_seed_hash,
    prizes: listRafflePrizes(r.id),
    winners: db.prepare(`
      SELECT re.tg_id, u.first_name, u.username FROM raffle_entries re JOIN users u ON u.tg_id = re.tg_id
      WHERE re.raffle_id = ? AND re.is_winner = 1
    `).all(r.id).map(w => ({ ...w, masked: maskName(w.username || w.first_name) })),
  }));
}

export function createRaffle(r) {
  const serverSeed = crypto.randomBytes(16).toString('hex');
  return db.prepare(`
    INSERT INTO raffles (title, prize_description, capacity, winners_count, required_task_id, ticket_price_toman, max_tickets_per_user, ends_at, server_seed, server_seed_hash, ticket_method, tickets_per_referral)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(r.title, r.prize_description || null, Number(r.capacity) || 100, Number(r.winners_count) || 10,
    r.required_task_id ? Number(r.required_task_id) : null, Number(r.ticket_price_toman) || 0, Number(r.max_tickets_per_user) || 1,
    r.ends_at || null, serverSeed, sha256Hex(serverSeed),
    r.ticket_method === 'referral' ? 'referral' : 'toman', Math.max(1, Number(r.tickets_per_referral) || 1)
  ).lastInsertRowid;
}
export function updateRaffle(id, r) {
  const raffle = getRaffle(id);
  if (!raffle) throw new Error('Raffle not found');
  if (raffle.status !== 'open') throw new Error('This raffle is no longer open');
  db.prepare(`
    UPDATE raffles SET title=?, prize_description=?, capacity=?, winners_count=?, required_task_id=?, ticket_price_toman=?, max_tickets_per_user=?, ends_at=?, ticket_method=?, tickets_per_referral=?
    WHERE id=?
  `).run(r.title, r.prize_description || null, Number(r.capacity) || 100, Number(r.winners_count) || 10,
    r.required_task_id ? Number(r.required_task_id) : null, Number(r.ticket_price_toman) || 0, Number(r.max_tickets_per_user) || 1, r.ends_at || null,
    r.ticket_method === 'referral' ? 'referral' : 'toman', Math.max(1, Number(r.tickets_per_referral) || 1), id);
}
export function deleteRaffle(id) {
  db.prepare('DELETE FROM raffle_entries WHERE raffle_id = ?').run(id);
  db.prepare('DELETE FROM raffle_prizes WHERE raffle_id = ?').run(id);
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
// Ranked, masked list of the biggest ticket-holders — the "Top Entries" board
export function getRaffleTopEntries(raffleId, limit = 100) {
  const rows = db.prepare(`
    SELECT re.tg_id, re.tickets, u.first_name, u.username FROM raffle_entries re JOIN users u ON u.tg_id = re.tg_id
    WHERE re.raffle_id = ? ORDER BY re.tickets DESC, re.created_at ASC LIMIT ?
  `).all(raffleId, limit);
  return rows.map((r, i) => ({ rank: i + 1, tickets: r.tickets, masked: maskName(r.username || r.first_name) }));
}
export function getRaffleTicketPool(raffleId) {
  return db.prepare('SELECT COALESCE(SUM(tickets),0) s FROM raffle_entries WHERE raffle_id = ?').get(raffleId).s;
}
export function getRaffleStatusForUser(raffleId, tgId) {
  const raffle = getRaffle(raffleId);
  if (!raffle) return null;
  const entriesCount = db.prepare('SELECT COUNT(*) c FROM raffle_entries WHERE raffle_id = ?').get(raffleId).c;
  const myEntry = getEntry(raffleId, tgId);
  const taskDone = raffle.required_task_id ? hasClaimedTask(tgId, raffle.required_task_id) : true;
  const requiredTask = raffle.required_task_id ? getTask(raffle.required_task_id) : null;
  // Only computed when relevant, so the status payload stays cheap for 'toman'-method raffles
  let referralTickets = null;
  if (raffle.ticket_method === 'referral') {
    const referredCount = db.prepare('SELECT COUNT(*) c FROM users WHERE referred_by = ?').get(tgId).c;
    const earned = Math.min(raffle.max_tickets_per_user, 1 + referredCount * raffle.tickets_per_referral);
    referralTickets = { referredCount, earned, claimable: myEntry ? Math.max(0, earned - myEntry.tickets) : 0 };
  }
  return {
    raffle: sanitizeRaffleForClient(raffle), entriesCount, myEntry, taskDone, requiredTask, referralTickets,
    prizes: listRafflePrizes(raffleId), ticketPool: getRaffleTicketPool(raffleId),
  };
}

// Initial registration (free, only if the required task is done and there's capacity) — always gives 1 base ticket
export function registerForRaffle(tgId, raffleId) {
  const raffle = getRaffle(raffleId);
  if (!raffle || raffle.status !== 'open') throw new Error('This raffle is not open yet');
  if (getEntry(raffleId, tgId)) throw new Error('You have already registered for this raffle');
  const entriesCount = db.prepare('SELECT COUNT(*) c FROM raffle_entries WHERE raffle_id = ?').get(raffleId).c;
  if (entriesCount >= raffle.capacity) throw new Error('This raffle is at full capacity');
  if (raffle.required_task_id && !hasClaimedTask(tgId, raffle.required_task_id)) {
    throw new Error('You must first complete the required task to enter');
  }
  db.prepare('INSERT INTO raffle_entries (raffle_id, tg_id, tickets) VALUES (?,?,1)').run(raffleId, tgId);
}

// Buying extra tickets (any quantity at once) to increase your chance, up to the cap max_tickets_per_user
// — only available when the admin has set this raffle's ticket method to 'toman'.
export function buyRaffleTickets(tgId, raffleId, qty = 1) {
  const raffle = getRaffle(raffleId);
  if (!raffle || raffle.status !== 'open') throw new Error('This raffle is not open yet');
  if (raffle.ticket_method !== 'toman' || !raffle.ticket_price_toman) throw new Error('Ticket purchase is not enabled for this raffle');
  const entry = getEntry(raffleId, tgId);
  if (!entry) throw new Error('You must first register for the raffle');
  qty = Math.max(1, Math.floor(Number(qty) || 1));
  if (entry.tickets + qty > raffle.max_tickets_per_user) {
    throw new Error(`You can hold at most ${raffle.max_tickets_per_user} ticket(s) for this raffle`);
  }
  const totalCost = round2(raffle.ticket_price_toman * qty);
  const user = getUser(tgId);
  if (!user || user.balance_toman < totalCost) throw new Error('Insufficient wallet balance');
  const tx = db.transaction(() => {
    adjustToman(tgId, -totalCost, `${qty} ticket(s) for raffle «${raffle.title}»`);
    db.prepare('UPDATE raffle_entries SET tickets = tickets + ? WHERE raffle_id = ? AND tg_id = ?').run(qty, raffleId, tgId);
  });
  tx();
}
// Kept for backward compatibility with any old caller expecting a single-ticket purchase
export function buyRaffleTicket(tgId, raffleId) { return buyRaffleTickets(tgId, raffleId, 1); }

// Converts a user's successful referrals into raffle tickets — only available when the admin has set
// this raffle's ticket method to 'referral'. Recomputes from scratch every call (rather than tracking
// a running counter) so it always reflects the user's current total referral count, including
// referrals that happened after they registered for the raffle; only the newly-earned delta is
// granted, and it's capped at max_tickets_per_user same as the LNDC-purchase method.
export function claimReferralTickets(tgId, raffleId) {
  const raffle = getRaffle(raffleId);
  if (!raffle || raffle.status !== 'open') throw new Error('This raffle is not open yet');
  if (raffle.ticket_method !== 'referral') throw new Error('Referral tickets are not enabled for this raffle');
  const entry = getEntry(raffleId, tgId);
  if (!entry) throw new Error('You must first register for the raffle');
  const referredCount = db.prepare('SELECT COUNT(*) c FROM users WHERE referred_by = ?').get(tgId).c;
  const earned = Math.min(raffle.max_tickets_per_user, 1 + referredCount * raffle.tickets_per_referral);
  const delta = earned - entry.tickets;
  if (delta <= 0) throw new Error('No new referral tickets to claim yet — invite more friends!');
  db.prepare('UPDATE raffle_entries SET tickets = tickets + ? WHERE raffle_id = ? AND tg_id = ?').run(delta, raffleId, tgId);
  return { granted: delta, totalTickets: earned, referredCount };
}

// Deterministic PRNG seeded from a hex string — the same seed always produces the exact same
// sequence, which is what makes a draw independently re-computable/verifiable once the seed is
// revealed. Re-hashes the seed with an incrementing counter each call for a fresh value each time.
function seededRandomFactory(seedHex) {
  const base = crypto.createHash('sha256').update(seedHex).digest();
  let counter = 0;
  return function random() {
    const buf = crypto.createHash('sha256').update(Buffer.concat([base, Buffer.from(String(counter++))])).digest();
    return buf.readUInt32BE(0) / 0xFFFFFFFF;
  };
}
function drawWeightedWinners(entries, winnersCount, random) {
  const rand = random || Math.random;
  const pool = [];
  entries.forEach(e => { for (let i = 0; i < e.tickets; i++) pool.push(e.tg_id); });
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
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

// The admin clicks "End raffle" (or the deadline passes) — winners are chosen with weighting
// (based on ticket count), deterministically from the raffle's pre-committed server_seed (see the
// provably-fair note at the top of this file), then assigned to prizes in draw order — the 1st
// winner drawn gets the 1st prize (by sort_order), and so on.
export function finishRaffle(raffleId) {
  const raffle = getRaffle(raffleId);
  if (!raffle) throw new Error('Raffle not found');
  if (raffle.status !== 'open') throw new Error('This raffle has already ended');
  const entries = listRaffleEntries(raffleId);
  const random = raffle.server_seed ? seededRandomFactory(`${raffle.server_seed}:${raffleId}`) : Math.random;
  const winnerIds = drawWeightedWinners(entries, raffle.winners_count, random);
  const prizes = listRafflePrizes(raffleId);
  const tx = db.transaction(() => {
    for (const tgId of winnerIds) {
      db.prepare('UPDATE raffle_entries SET is_winner = 1 WHERE raffle_id = ? AND tg_id = ?').run(raffleId, tgId);
    }
    winnerIds.forEach((tgId, i) => {
      if (prizes[i]) db.prepare('UPDATE raffle_prizes SET winner_tg_id = ? WHERE id = ?').run(tgId, prizes[i].id);
    });
    db.prepare(`UPDATE raffles SET status = 'finished', finished_at = datetime('now') WHERE id = ?`).run(raffleId);
  });
  tx();
  return listRaffleEntries(raffleId).filter(e => e.is_winner);
}

// Called periodically (see server.js) — auto-ends any open raffle whose deadline has passed
export function checkAutoFinishRaffles() {
  const due = db.prepare(`SELECT id FROM raffles WHERE status = 'open' AND ends_at IS NOT NULL AND ends_at <= datetime('now')`).all();
  const results = [];
  for (const { id } of due) {
    try { results.push({ id, raffle: getRaffle(id), winners: finishRaffle(id) }); }
    catch (e) { console.error('[raffle auto-finish]', id, e.message); }
  }
  return results;
}
