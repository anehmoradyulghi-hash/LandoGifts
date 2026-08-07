import db from './db.js';
import { getMyClan, getClanById, getClanMembers, addClanWinScore } from './clan-db.js';
import { getUserCard, getUserCards } from './game-db.js';

/* =========================================================================
 * Clan vs clan war — entry fee from the clan bank (donated funds), each side sends 5 members
 * sends them with their cards, total power is compared, the winner takes the full amount minus
 * minus a fee. Fully server-side, no external calls needed.
 * Table creation lives in migrations/004_clan_wars.sql now.
 * ========================================================================= */

export async function getClanWarConfig() { return await db.prepare('SELECT * FROM clan_war_config WHERE id = 1').get(); }
export async function setClanWarConfig(c) {
  await db.prepare(`
    UPDATE clan_war_config SET enabled=?, min_entry_toman=?, fee_percent=?, team_size=? WHERE id = 1
  `).run(c.enabled ? 1 : 0, Number(c.min_entry_toman) || 100000, Number(c.fee_percent) || 10, Number(c.team_size) || 5);
}

async function requireLeader(tgId) {
  const clan = await getMyClan(tgId);
  if (!clan) throw new Error('You are not a member of any clan');
  if (clan.myRole !== 'owner' && clan.myRole !== 'admin') throw new Error('Only the clan leader or manager can do this');
  return clan;
}

async function decorateWar(w) {
  const clanA = await getClanById(w.clan_a_id);
  const clanB = w.clan_b_id ? await getClanById(w.clan_b_id) : null;
  return {
    ...w,
    clanAPicks: JSON.parse(w.clan_a_picks || '[]'),
    clanBPicks: JSON.parse(w.clan_b_picks || '[]'),
    clanAName: clanA ? `${clanA.name} #${clanA.tag}` : '—',
    clanBName: clanB ? `${clanB.name} #${clanB.tag}` : null,
  };
}

export async function getClanWar(id) {
  const w = await db.prepare('SELECT * FROM clan_wars WHERE id = ?').get(id);
  return w ? await decorateWar(w) : null;
}
// Open wars waiting for an opponent (does not show my own clan)
export async function listOpenClanWars(excludeClanId) {
  const rows = await db.prepare(`SELECT * FROM clan_wars WHERE status = 'open' AND clan_a_id != ? ORDER BY id DESC LIMIT 30`)
    .all(excludeClanId || 0);
  return Promise.all(rows.map(decorateWar));
}
// My clan's active war (whether waiting for an opponent or setting the deck)
export async function getMyActiveClanWar(clanId) {
  const w = await db.prepare(`
    SELECT * FROM clan_wars WHERE (clan_a_id = ? OR clan_b_id = ?) AND status IN ('open','picking')
    ORDER BY id DESC LIMIT 1
  `).get(clanId, clanId);
  return w ? await decorateWar(w) : null;
}
export async function getClanWarHistory(clanId, limit = 20) {
  const rows = await db.prepare(`
    SELECT * FROM clan_wars WHERE (clan_a_id = ? OR clan_b_id = ?) AND status IN ('finished','cancelled')
    ORDER BY id DESC LIMIT ?
  `).all(clanId, clanId, limit);
  return Promise.all(rows.map(decorateWar));
}

export async function getMemberCardsForLeader(leaderTgId, memberTgId) {
  const clan = await requireLeader(leaderTgId);
  const isMember = await getClanMembers(clan.id).some(m => m.tg_id === Number(memberTgId));
  if (!isMember) throw new Error('This person is not a member of your clan');
  return await getUserCards(Number(memberTgId));
}

export async function createClanWar(leaderTgId, entryToman) {
  const cfg = await getClanWarConfig();
  if (!cfg.enabled) throw new Error('Clan wars are currently disabled');
  const clan = await requireLeader(leaderTgId);
  const entry = Number(entryToman);
  if (!entry || entry < cfg.min_entry_toman) throw new Error(`Minimum entry is ${cfg.min_entry_toman.toLocaleString()} LNDC`);
  if (await getMyActiveClanWar(clan.id)) throw new Error('Your clan already has an open war right now');
  if (clan.bank_balance < entry) throw new Error('Insufficient clan bank balance (donated funds)');

  return db.transaction(async () => {
    await db.prepare('UPDATE clans SET bank_balance = bank_balance - ? WHERE id = ?').run(entry, clan.id);
    return (await db.prepare('INSERT INTO clan_wars (clan_a_id, entry_toman) VALUES (?,?)').run(clan.id, entry)).lastInsertRowid;
  })();
}

export async function cancelClanWar(warId, leaderTgId) {
  const clan = await requireLeader(leaderTgId);
  const war = await db.prepare('SELECT * FROM clan_wars WHERE id = ?').get(warId);
  if (!war) throw new Error('War not found');
  if (war.clan_a_id !== clan.id && war.clan_b_id !== clan.id) throw new Error('This war does not belong to your clan');
  if (war.status !== 'open' && war.status !== 'picking') throw new Error('This war has already ended and can no longer be cancelled');
  await db.transaction(async () => {
    // Each clan's entry fee returns to its own bank — not only the clan that created the war
    await db.prepare('UPDATE clans SET bank_balance = bank_balance + ? WHERE id = ?').run(war.entry_toman, war.clan_a_id);
    if (war.clan_b_id) await db.prepare('UPDATE clans SET bank_balance = bank_balance + ? WHERE id = ?').run(war.entry_toman, war.clan_b_id);
    await db.prepare(`UPDATE clan_wars SET status = 'cancelled' WHERE id = ?`).run(warId);
  })();
}

export async function joinClanWar(warId, leaderTgId) {
  const clan = await requireLeader(leaderTgId);
  const war = await db.prepare('SELECT * FROM clan_wars WHERE id = ?').get(warId);
  if (!war) throw new Error('War not found');
  if (war.status !== 'open') throw new Error('This war is not waiting for an opponent');
  if (war.clan_a_id === clan.id) throw new Error('You cannot fight your own clan');
  if (await getMyActiveClanWar(clan.id)) throw new Error('Your clan already has an open war right now');
  if (clan.bank_balance < war.entry_toman) throw new Error('Insufficient clan bank balance (donated funds)');

  await db.transaction(async () => {
    await db.prepare('UPDATE clans SET bank_balance = bank_balance - ? WHERE id = ?').run(war.entry_toman, clan.id);
    await db.prepare(`UPDATE clan_wars SET clan_b_id = ?, status = 'picking' WHERE id = ?`).run(clan.id, warId);
  })();
  return await getClanWar(warId);
}

async function validatePicks(clanId, cfg, picks) {
  if (!Array.isArray(picks) || picks.length !== cfg.team_size) throw new Error(`You must select exactly ${cfg.team_size} members with their cards`);
  const memberIds = new Set((await getClanMembers(clanId)).map(m => m.tg_id));
  const seen = new Set();
  let totalPower = 0;
  for (const p of picks) {
    const tgId = Number(p.tgId);
    if (!memberIds.has(tgId)) throw new Error('One of the selected members is not part of this clan');
    if (seen.has(tgId)) throw new Error('You cannot select the same person twice');
    seen.add(tgId);
    const cardIds = Array.isArray(p.cardIds) ? [...new Set(p.cardIds.map(Number))] : [];
    if (!cardIds.length) throw new Error('Each member must have at least one card');
    for (const cid of cardIds) {
      const card = await getUserCard(tgId, cid);
      if (!card) throw new Error('One of the selected cards is not valid');
      totalPower += card.power;
    }
  }
  return { picks: picks.map(p => ({ tgId: Number(p.tgId), cardIds: [...new Set(p.cardIds.map(Number))] })), totalPower };
}

// Each side's leader/manager sets 5 members and their cards; once both sides have set theirs, the war resolves automatically
export async function submitWarPicks(warId, leaderTgId, picks) {
  const cfg = await getClanWarConfig();
  const clan = await requireLeader(leaderTgId);
  const war = await db.prepare('SELECT * FROM clan_wars WHERE id = ?').get(warId);
  if (!war) throw new Error('War not found');
  if (war.status !== 'picking') throw new Error('This war is not in the deck-setting stage right now');
  if (war.clan_a_id !== clan.id && war.clan_b_id !== clan.id) throw new Error('This war does not belong to your clan');

  const side = war.clan_a_id === clan.id ? 'a' : 'b';
  if (side === 'a' && war.clan_a_power != null) throw new Error('Your clan has already set its deck');
  if (side === 'b' && war.clan_b_power != null) throw new Error('Your clan has already set its deck');

  const { picks: cleanPicks, totalPower } = await validatePicks(clan.id, cfg, picks);

  return db.transaction(async () => {
    if (side === 'a') {
      await db.prepare('UPDATE clan_wars SET clan_a_picks = ?, clan_a_power = ? WHERE id = ?').run(JSON.stringify(cleanPicks), totalPower, warId);
    } else {
      await db.prepare('UPDATE clan_wars SET clan_b_picks = ?, clan_b_power = ? WHERE id = ?').run(JSON.stringify(cleanPicks), totalPower, warId);
    }
    const fresh = await db.prepare('SELECT * FROM clan_wars WHERE id = ?').get(warId);
    if (fresh.clan_a_power != null && fresh.clan_b_power != null) {
      await resolveClanWar(fresh);
    }
    return await getClanWar(warId);
  })();
}

async function resolveClanWar(war) {
  const cfg = await getClanWarConfig();
  // A bit of random chance (up to 15%) so the match is not purely mathematical — the same formula as 1v1 battles
  const rollA = war.clan_a_power * (1 + Math.random() * 0.15);
  const rollB = war.clan_b_power * (1 + Math.random() * 0.15);
  const winnerClanId = rollA >= rollB ? war.clan_a_id : war.clan_b_id;
  const pot = war.entry_toman * 2;
  const fee = Math.round(pot * cfg.fee_percent / 100);
  const payout = pot - fee;

  await db.prepare('UPDATE clans SET bank_balance = bank_balance + ? WHERE id = ?').run(payout, winnerClanId);
  await db.prepare(`
    UPDATE clan_wars SET status = 'finished', winner_clan_id = ?, pot_toman = ?, fee_toman = ?, finished_at = now_text()
    WHERE id = ?
  `).run(winnerClanId, pot, fee, war.id);

  const winnerOwner = await db.prepare(`SELECT tg_id FROM clan_members WHERE clan_id = ? AND role = 'owner'`).get(winnerClanId);
  if (winnerOwner) await addClanWinScore(winnerOwner.tg_id);
}
