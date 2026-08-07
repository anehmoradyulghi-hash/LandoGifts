import db from './db.js';
import { adjustToman, getUser } from './db.js';

export async function getClanConfig() { return await db.prepare('SELECT * FROM clan_config WHERE id = 1').get(); }
export async function setClanConfig(c) {
  await db.prepare(`
    UPDATE clan_config SET enabled=?, creation_cost_toman=?, max_members=?, score_per_1k_purchase=?, score_per_win=?,
      score_per_1k_donation=?, reward_toman=?, winners_count=?, distribution_method=?, min_score_threshold=?, reset_days=?, withdraw_fee_percent=?
    WHERE id = 1
  `).run(c.enabled ? 1 : 0, c.creation_cost_toman, c.max_members, c.score_per_1k_purchase, c.score_per_win,
    c.score_per_1k_donation, c.reward_toman, c.winners_count, c.distribution_method, c.min_score_threshold, c.reset_days, c.withdraw_fee_percent || 0);
}

export async function getMyClan(tgId) {
  const member = await db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(tgId);
  if (!member) return null;
  const clan = await db.prepare('SELECT * FROM clans WHERE id = ?').get(member.clan_id);
  return clan ? { ...clan, myRole: member.role, myDonatedTotal: member.donated_total, myWithdrawnTotal: member.withdrawn_total, myWithdrawableRemaining: clan.bank_balance } : null;
}
export async function getClanById(id) { return await db.prepare('SELECT * FROM clans WHERE id = ?').get(id); }
export async function getClanMembers(clanId) {
  return await db.prepare(`
    SELECT cm.*, u.first_name, u.username FROM clan_members cm JOIN users u ON u.tg_id = cm.tg_id
    WHERE cm.clan_id = ? ORDER BY cm.donated_total DESC
  `).all(clanId);
}
export async function searchClans(query) {
  const like = `%${query || ''}%`;
  return await db.prepare('SELECT * FROM clans WHERE name LIKE ? OR tag LIKE ? ORDER BY score DESC LIMIT 30').all(like, like);
}
export async function getClanLeaderboard(limit = 10) {
  return await db.prepare('SELECT * FROM clans ORDER BY score DESC LIMIT ?').all(limit);
}
export async function getClanRank(clanId) {
  const row = await db.prepare(`
    SELECT COUNT(*) + 1 AS rank FROM clans
    WHERE score > (SELECT COALESCE(score,0) FROM clans WHERE id = ?)
  `).get(clanId);
  return row.rank;
}

export async function createClan(tgId, name, tag, avatarUrl) {
  const cfg = await getClanConfig();
  if (!cfg.enabled) throw new Error('The clan system is currently disabled');
  if (await getMyClan(tgId)) throw new Error('You are already a member of a clan');
  if (!name || !tag) throw new Error('Clan name and tag are required');
  const exists = await db.prepare('SELECT 1 FROM clans WHERE tag = ?').get(tag);
  if (exists) throw new Error('This tag is already in use');
  const user = await getUser(tgId);
  if (!user || user.balance_toman < cfg.creation_cost_toman) throw new Error(`${cfg.creation_cost_toman.toLocaleString()} LNDC is required to create a clan`);

  let clanId;
  const tx = db.transaction(async () => {
    await adjustToman(tgId, -cfg.creation_cost_toman, `Create clan «${name}»`);
    clanId = (await db.prepare('INSERT INTO clans (name, tag, avatar_url, owner_tg_id) VALUES (?,?,?,?)').run(name, tag, avatarUrl || null, tgId)).lastInsertRowid;
    await db.prepare(`INSERT INTO clan_members (tg_id, clan_id, role) VALUES (?,?,'owner')`).run(tgId, clanId);
  });
  await tx();
  return clanId;
}

export async function joinClan(tgId, clanId) {
  const cfg = await getClanConfig();
  if (!cfg.enabled) throw new Error('The clan system is currently disabled');
  if (await getMyClan(tgId)) throw new Error('You are already a member of a clan');
  const clan = await getClanById(clanId);
  if (!clan) throw new Error('Clan not found');
  const memberCount = (await db.prepare('SELECT COUNT(*) c FROM clan_members WHERE clan_id = ?').get(clanId)).c;
  if (memberCount >= cfg.max_members) throw new Error('This clan is full');
  await db.prepare(`INSERT INTO clan_members (tg_id, clan_id, role) VALUES (?,?,'member')`).run(tgId, clanId);
}

// If the leader leaves, the clan is fully disbanded; a regular member just leaves
export async function leaveClan(tgId) {
  const member = await db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(tgId);
  if (!member) throw new Error('You are not in any clan');
  if (member.role === 'owner') {
    const tx = db.transaction(async () => {
      await db.prepare('DELETE FROM clan_members WHERE clan_id = ?').run(member.clan_id);
      await db.prepare('DELETE FROM clans WHERE id = ?').run(member.clan_id);
    });
    await tx();
    return { disbanded: true };
  }
  await db.prepare('DELETE FROM clan_members WHERE tg_id = ?').run(tgId);
  return { disbanded: false };
}

export async function kickMember(ownerTgId, targetTgId) {
  const owner = await db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(ownerTgId);
  if (!owner || owner.role !== 'owner') throw new Error('Only the clan leader can kick');
  const target = await db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(targetTgId);
  if (!target || target.clan_id !== owner.clan_id) throw new Error('This user is not in your clan');
  if (target.role === 'owner') throw new Error('You cannot kick yourself');
  await db.prepare('DELETE FROM clan_members WHERE tg_id = ?').run(targetTgId);
}
export async function setMemberRole(ownerTgId, targetTgId, role) {
  const owner = await db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(ownerTgId);
  if (!owner || owner.role !== 'owner') throw new Error('Only the clan leader can assign roles');
  const target = await db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(targetTgId);
  if (!target || target.clan_id !== owner.clan_id) throw new Error('This user is not in your clan');
  await db.prepare(`UPDATE clan_members SET role = ? WHERE tg_id = ?`).run(role === 'admin' ? 'admin' : 'member', targetTgId);
}

export async function donateToClan(tgId, amount) {
  const member = await db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(tgId);
  if (!member) throw new Error('You are not in any clan');
  if (!amount || amount <= 0) throw new Error('Invalid amount');
  const user = await getUser(tgId);
  if (!user || user.balance_toman < amount) throw new Error('Insufficient balance');
  const cfg = await getClanConfig();
  const scoreGain = Math.floor(amount / 1000) * cfg.score_per_1k_donation;

  const tx = db.transaction(async () => {
    await adjustToman(tgId, -amount, 'Donation to clan bank');
    await db.prepare('UPDATE clans SET bank_balance = bank_balance + ?, score = score + ? WHERE id = ?').run(amount, scoreGain, member.clan_id);
    await db.prepare('UPDATE clan_members SET donated_total = donated_total + ? WHERE tg_id = ?').run(amount, tgId);
    await db.prepare('INSERT INTO clan_donations (clan_id, tg_id, amount) VALUES (?,?,?)').run(member.clan_id, tgId, amount);
  });
  await tx();
}

// The clan leader can withdraw from the clan bank (funds members donated) to their own wallet
export async function withdrawFromClanBank(ownerTgId, amount) {
  const owner = await db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(ownerTgId);
  if (!owner || owner.role !== 'owner') throw new Error('Only the clan leader can withdraw from the clan bank');
  if (!amount || amount <= 0) throw new Error('Invalid amount');
  const clan = await getClanById(owner.clan_id);
  if (!clan || clan.bank_balance < amount) throw new Error('Insufficient clan bank balance');
  const cfg = await getClanConfig();
  const fee = Math.round(amount * (cfg.withdraw_fee_percent || 0) / 100);
  const net = amount - fee;
  const tx = db.transaction(async () => {
    await db.prepare('UPDATE clans SET bank_balance = bank_balance - ? WHERE id = ?').run(amount, clan.id);
    await db.prepare('UPDATE clan_members SET withdrawn_total = withdrawn_total + ? WHERE tg_id = ?').run(amount, ownerTgId);
    await adjustToman(ownerTgId, net, `Withdrawal from clan bank «${clan.name}»${fee > 0 ? ` (${fee.toLocaleString()} LNDC fee deducted)` : ''}`);
  });
  await tx();
  return { net, fee };
}
// The clan leader can gift directly from the clan bank to a member
export async function giftFromClanBank(ownerTgId, targetTgId, amount) {
  const owner = await db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(ownerTgId);
  if (!owner || owner.role !== 'owner') throw new Error('Only the clan leader can gift from the clan bank');
  if (!amount || amount <= 0) throw new Error('Invalid amount');
  const target = await db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(targetTgId);
  if (!target || target.clan_id !== owner.clan_id) throw new Error('This user is not in your clan');
  const clan = await getClanById(owner.clan_id);
  if (!clan || clan.bank_balance < amount) throw new Error('Insufficient clan bank balance');
  const cfg = await getClanConfig();
  const fee = Math.round(amount * (cfg.withdraw_fee_percent || 0) / 100);
  const net = amount - fee;
  const tx = db.transaction(async () => {
    await db.prepare('UPDATE clans SET bank_balance = bank_balance - ? WHERE id = ?').run(amount, clan.id);
    await db.prepare('UPDATE clan_members SET withdrawn_total = withdrawn_total + ? WHERE tg_id = ?').run(amount, ownerTgId);
    await adjustToman(targetTgId, net, `Gift from clan bank «${clan.name}»${fee > 0 ? ` (${fee.toLocaleString()} LNDC fee deducted)` : ''}`);
  });
  await tx();
  return { net, fee };
}

// Hooks called from other parts of the app (shop purchases, game wins)
export async function addClanPurchaseScore(tgId, amountToman) {
  const member = await db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(tgId);
  if (!member) return;
  const cfg = await getClanConfig();
  const scoreGain = Math.floor(amountToman / 1000) * cfg.score_per_1k_purchase;
  if (scoreGain > 0) await db.prepare('UPDATE clans SET score = score + ? WHERE id = ?').run(scoreGain, member.clan_id);
}
export async function addClanWinScore(tgId) {
  const member = await db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(tgId);
  if (!member) return;
  const cfg = await getClanConfig();
  if (cfg.score_per_win > 0) await db.prepare('UPDATE clans SET score = score + ? WHERE id = ?').run(cfg.score_per_win, member.clan_id);
}

export async function getClanState() { return await db.prepare('SELECT * FROM clan_state WHERE id = 1').get(); }

// Distributes prizes to the top clans and resets scores (the bank remains untouched)
export async function resetClanSeason(notifyFn) {
  const cfg = await getClanConfig();
  const top = await db.prepare('SELECT * FROM clans WHERE score >= ? ORDER BY score DESC LIMIT ?').all(cfg.min_score_threshold, cfg.winners_count);
  for (const clan of top) {
    const members = await getClanMembers(clan.id);
    if (!members.length || cfg.reward_toman <= 0) continue;
    if (cfg.distribution_method === 'donation_share') {
      const totalDonated = members.reduce((s, m) => s + m.donated_total, 0);
      for (const m of members) {
        const share = totalDonated > 0 ? Math.floor((cfg.reward_toman * m.donated_total) / totalDonated) : Math.floor(cfg.reward_toman / members.length);
        if (share > 0) { await adjustToman(m.tg_id, share, `Clan prize "${clan.name}" (based on donation share)`); if (notifyFn) notifyFn(m.tg_id, clan, share); }
      }
    } else {
      const share = Math.floor(cfg.reward_toman / members.length);
      for (const m of members) {
        if (share > 0) { await adjustToman(m.tg_id, share, `Clan prize «${clan.name}»`); if (notifyFn) notifyFn(m.tg_id, clan, share); }
      }
    }
  }
  await db.prepare('UPDATE clans SET score = 0').run();
  await db.prepare(`UPDATE clan_state SET period_started_at = now_text() WHERE id = 1`).run();
}
export async function checkAutoResetClanSeason(notifyFn) {
  const cfg = await getClanConfig();
  if (!cfg.enabled) return;
  const state = await getClanState();
  const startedAt = new Date(state.period_started_at.replace(' ', 'T') + 'Z').getTime();
  if (Date.now() >= startedAt + cfg.reset_days * 24 * 60 * 60 * 1000) await resetClanSeason(notifyFn);
}

/* ---------- Admin operations on any clan ---------- */
export async function adminDeleteClan(clanId) {
  const clan = await getClanById(clanId);
  if (!clan) throw new Error('Clan not found');
  const tx = db.transaction(async () => {
    await db.prepare('DELETE FROM clan_members WHERE clan_id = ?').run(clanId);
    await db.prepare('DELETE FROM clan_donations WHERE clan_id = ?').run(clanId);
    await db.prepare('DELETE FROM clans WHERE id = ?').run(clanId);
  });
  await tx();
}
// The admin can manually increase/decrease any clan's bank balance without limit (no fee)
export async function adminAdjustClanBank(clanId, amount) {
  const clan = await getClanById(clanId);
  if (!clan) throw new Error('Clan not found');
  if (clan.bank_balance + amount < 0) throw new Error('The clan bank balance cannot go negative');
  await db.prepare('UPDATE clans SET bank_balance = bank_balance + ? WHERE id = ?').run(amount, clanId);
}
export async function listAllClansAdmin() {
  return await db.prepare('SELECT * FROM clans ORDER BY score DESC').all();
}
