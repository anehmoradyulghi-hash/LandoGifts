import db from './db.js';
import { adjustToman, getUser, hasClaimedTask, getTask } from './db.js';

/* =========================================================================
 * Big wheel (raffle) — completely separate from the daily wheel of fortune.
 * The user registers (may require completing a specific task), can buy extra
 * tickets increase their chance, and when the admin clicks "End raffle",
 * the specified number of winners are drawn with weighting (based on ticket count).
 * Prizes are deposited manually by the admin, this just shows the winners' IDs.
 * Table creation lives in migrations/007_raffles.sql now.
 * ========================================================================= */

export async function listRafflesAdmin() { return await db.prepare('SELECT * FROM raffles ORDER BY id DESC').all(); }
export async function getRaffle(id) { return await db.prepare('SELECT * FROM raffles WHERE id = ?').get(id); }
export async function listOpenRaffles() { return await db.prepare(`SELECT * FROM raffles WHERE status = 'open' ORDER BY id DESC`).all(); }

export async function createRaffle(r) {
  return (await db.prepare(`
    INSERT INTO raffles (title, prize_description, capacity, winners_count, required_task_id, ticket_price_toman, max_tickets_per_user)
    VALUES (?,?,?,?,?,?,?)
  `).run(r.title, r.prize_description || null, Number(r.capacity) || 100, Number(r.winners_count) || 10,
    r.required_task_id ? Number(r.required_task_id) : null, Number(r.ticket_price_toman) || 0, Number(r.max_tickets_per_user) || 1
  )).lastInsertRowid;
}
export async function updateRaffle(id, r) {
  const raffle = await getRaffle(id);
  if (!raffle) throw new Error('Raffle not found');
  if (raffle.status !== 'open') throw new Error('This raffle is no longer open');
  await db.prepare(`
    UPDATE raffles SET title=?, prize_description=?, capacity=?, winners_count=?, required_task_id=?, ticket_price_toman=?, max_tickets_per_user=?
    WHERE id=?
  `).run(r.title, r.prize_description || null, Number(r.capacity) || 100, Number(r.winners_count) || 10,
    r.required_task_id ? Number(r.required_task_id) : null, Number(r.ticket_price_toman) || 0, Number(r.max_tickets_per_user) || 1, id);
}
export async function deleteRaffle(id) {
  await db.prepare('DELETE FROM raffle_entries WHERE raffle_id = ?').run(id);
  await db.prepare('DELETE FROM raffles WHERE id = ?').run(id);
}
export async function cancelRaffle(id) {
  await db.prepare(`UPDATE raffles SET status = 'cancelled' WHERE id = ?`).run(id);
}

async function getEntry(raffleId, tgId) {
  return await db.prepare('SELECT * FROM raffle_entries WHERE raffle_id = ? AND tg_id = ?').get(raffleId, tgId);
}
export async function listRaffleEntries(raffleId) {
  return await db.prepare(`
    SELECT re.*, u.first_name, u.username FROM raffle_entries re JOIN users u ON u.tg_id = re.tg_id
    WHERE re.raffle_id = ? ORDER BY re.created_at ASC
  `).all(raffleId);
}
export async function getRaffleStatusForUser(raffleId, tgId) {
  const raffle = await getRaffle(raffleId);
  if (!raffle) return null;
  const entriesCount = (await db.prepare('SELECT COUNT(*) c FROM raffle_entries WHERE raffle_id = ?').get(raffleId)).c;
  const myEntry = await getEntry(raffleId, tgId);
  const taskDone = raffle.required_task_id ? await hasClaimedTask(tgId, raffle.required_task_id) : true;
  const requiredTask = raffle.required_task_id ? await getTask(raffle.required_task_id) : null;
  return { raffle, entriesCount, myEntry, taskDone, requiredTask };
}

// Initial registration (free, only if the required task is done and there's capacity) — always gives 1 base ticket
export async function registerForRaffle(tgId, raffleId) {
  const raffle = await getRaffle(raffleId);
  if (!raffle || raffle.status !== 'open') throw new Error('This raffle is not open yet');
  if (await getEntry(raffleId, tgId)) throw new Error('You have already registered for this raffle');
  const entriesCount = (await db.prepare('SELECT COUNT(*) c FROM raffle_entries WHERE raffle_id = ?').get(raffleId)).c;
  if (entriesCount >= raffle.capacity) throw new Error('This raffle is at full capacity');
  if (raffle.required_task_id && !await hasClaimedTask(tgId, raffle.required_task_id)) {
    throw new Error('You must first complete the required task to enter');
  }
  await db.prepare('INSERT INTO raffle_entries (raffle_id, tg_id, tickets) VALUES (?,?,1)').run(raffleId, tgId);
}

// Buying extra tickets to increase your chance (up to the cap max_tickets_per_user)
export async function buyRaffleTicket(tgId, raffleId) {
  const raffle = await getRaffle(raffleId);
  if (!raffle || raffle.status !== 'open') throw new Error('This raffle is not open yet');
  if (!raffle.ticket_price_toman) throw new Error('Ticket purchase is not enabled for this raffle');
  const entry = await getEntry(raffleId, tgId);
  if (!entry) throw new Error('You must first register for the raffle');
  if (entry.tickets >= raffle.max_tickets_per_user) throw new Error('You have reached the maximum allowed ticket count');
  const user = await getUser(tgId);
  if (!user || user.balance_toman < raffle.ticket_price_toman) throw new Error('Insufficient wallet balance');
  const tx = db.transaction(async () => {
    await adjustToman(tgId, -raffle.ticket_price_toman, `Ticket purchase for raffle «${raffle.title}»`);
    await db.prepare('UPDATE raffle_entries SET tickets = tickets + 1 WHERE raffle_id = ? AND tg_id = ?').run(raffleId, tgId);
  });
  await tx();
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

// The admin clicks the "End raffle" button — winners are chosen with weighting (based on ticket count)
export async function finishRaffle(raffleId) {
  const raffle = await getRaffle(raffleId);
  if (!raffle) throw new Error('Raffle not found');
  if (raffle.status !== 'open') throw new Error('This raffle has already ended');
  const entries = await listRaffleEntries(raffleId);
  const winnerIds = drawWeightedWinners(entries, raffle.winners_count);
  const tx = db.transaction(async () => {
    for (const tgId of winnerIds) {
      await db.prepare('UPDATE raffle_entries SET is_winner = 1 WHERE raffle_id = ? AND tg_id = ?').run(raffleId, tgId);
    }
    await db.prepare(`UPDATE raffles SET status = 'finished', finished_at = now_text() WHERE id = ?`).run(raffleId);
  });
  await tx();
  return (await listRaffleEntries(raffleId)).filter(e => e.is_winner);
}
