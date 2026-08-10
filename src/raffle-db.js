import db from './db.js';
import { adjustToman, getUser, hasClaimedTask, getTask } from './db.js';
import crypto from 'crypto';

/* =========================================================================
 * Big wheel (raffle) — completely separate from the daily wheel of fortune.
 * The user registers (may require completing a specific task), can buy extra
 * tickets increase their chance, and when the admin clicks "End raffle",
 * the specified number of winners are drawn with weighting (based on ticket count).
 * Prizes are deposited manually by the admin, this just shows the winners' IDs.
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
`);

function sha256Hex(str) { return crypto.createHash('sha256').update(str).digest('hex'); }
// Strips the hidden server_seed from a raffle before it's sent to a player — only revealed once the
// raffle is finished (the hash, which is safe to show from the start, is always kept).
function sanitizeRaffleForClient(raffle) {
  if (!raffle) return raffle;
  if (raffle.status === 'finished') return raffle;
  const { server_seed, ...rest } = raffle;
  return rest;
}

export function listRafflesAdmin() { return db.prepare('SELECT * FROM raffles ORDER BY id DESC').all(); }
export function getRaffle(id) { return db.prepare('SELECT * FROM raffles WHERE id = ?').get(id); }
export function listOpenRaffles() { return db.prepare(`SELECT * FROM raffles WHERE status = 'open' ORDER BY id DESC`).all(); }
// Public log of finished raffles + their winners — for the "recent winners" list in the mini app.
export function listRecentRaffleWinners(limit = 10) {
  const raffles = db.prepare(`SELECT * FROM raffles WHERE status = 'finished' ORDER BY finished_at DESC LIMIT ?`).all(limit);
  return raffles.map(r => ({
    id: r.id, title: r.title, prize_description: r.prize_description, finished_at: r.finished_at,
    server_seed: r.server_seed, server_seed_hash: r.server_seed_hash,
    winners: db.prepare(`
      SELECT re.tg_id, u.first_name, u.username FROM raffle_entries re JOIN users u ON u.tg_id = re.tg_id
      WHERE re.raffle_id = ? AND re.is_winner = 1
    `).all(r.id),
  }));
}

export function createRaffle(r) {
  const serverSeed = crypto.randomBytes(16).toString('hex');
  return db.prepare(`
    INSERT INTO raffles (title, prize_description, capacity, winners_count, required_task_id, ticket_price_toman, max_tickets_per_user, server_seed, server_seed_hash)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(r.title, r.prize_description || null, Number(r.capacity) || 100, Number(r.winners_count) || 10,
    r.required_task_id ? Number(r.required_task_id) : null, Number(r.ticket_price_toman) || 0, Number(r.max_tickets_per_user) || 1,
    serverSeed, sha256Hex(serverSeed)
  ).lastInsertRowid;
}
export function updateRaffle(id, r) {
  const raffle = getRaffle(id);
  if (!raffle) throw new Error('Raffle not found');
  if (raffle.status !== 'open') throw new Error('This raffle is no longer open');
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
  return { raffle: sanitizeRaffleForClient(raffle), entriesCount, myEntry, taskDone, requiredTask };
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

// Buying extra tickets to increase your chance (up to the cap max_tickets_per_user)
export function buyRaffleTicket(tgId, raffleId) {
  const raffle = getRaffle(raffleId);
  if (!raffle || raffle.status !== 'open') throw new Error('This raffle is not open yet');
  if (!raffle.ticket_price_toman) throw new Error('Ticket purchase is not enabled for this raffle');
  const entry = getEntry(raffleId, tgId);
  if (!entry) throw new Error('You must first register for the raffle');
  if (entry.tickets >= raffle.max_tickets_per_user) throw new Error('You have reached the maximum allowed ticket count');
  const user = getUser(tgId);
  if (!user || user.balance_toman < raffle.ticket_price_toman) throw new Error('Insufficient wallet balance');
  const tx = db.transaction(() => {
    adjustToman(tgId, -raffle.ticket_price_toman, `Ticket purchase for raffle «${raffle.title}»`);
    db.prepare('UPDATE raffle_entries SET tickets = tickets + 1 WHERE raffle_id = ? AND tg_id = ?').run(raffleId, tgId);
  });
  tx();
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

// The admin clicks the "End raffle" button — winners are chosen with weighting (based on ticket
// count), deterministically from the raffle's pre-committed server_seed (see the provably-fair note
// at the top of this file).
export function finishRaffle(raffleId) {
  const raffle = getRaffle(raffleId);
  if (!raffle) throw new Error('Raffle not found');
  if (raffle.status !== 'open') throw new Error('This raffle has already ended');
  const entries = listRaffleEntries(raffleId);
  const random = raffle.server_seed ? seededRandomFactory(`${raffle.server_seed}:${raffleId}`) : Math.random;
  const winnerIds = drawWeightedWinners(entries, raffle.winners_count, random);
  const tx = db.transaction(() => {
    for (const tgId of winnerIds) {
      db.prepare('UPDATE raffle_entries SET is_winner = 1 WHERE raffle_id = ? AND tg_id = ?').run(raffleId, tgId);
    }
    db.prepare(`UPDATE raffles SET status = 'finished', finished_at = datetime('now') WHERE id = ?`).run(raffleId);
  });
  tx();
  return listRaffleEntries(raffleId).filter(e => e.is_winner);
}
