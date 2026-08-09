import db from './db.js';
import { adjustToman, getUser } from './db.js';
import { getRankConfig } from './rank-db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS clan_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  creation_cost_toman INTEGER NOT NULL DEFAULT 50000,
  max_members INTEGER NOT NULL DEFAULT 20,
  score_per_1k_purchase INTEGER NOT NULL DEFAULT 10,
  score_per_win INTEGER NOT NULL DEFAULT 5,
  score_per_1k_donation INTEGER NOT NULL DEFAULT 20,
  reward_toman INTEGER NOT NULL DEFAULT 0,
  winners_count INTEGER NOT NULL DEFAULT 1,     -- 1 or 3
  distribution_method TEXT NOT NULL DEFAULT 'equal', -- equal | donation_share
  min_score_threshold INTEGER NOT NULL DEFAULT 0,
  reset_days INTEGER NOT NULL DEFAULT 7
);
INSERT OR IGNORE INTO clan_config (id) VALUES (1);

CREATE TABLE IF NOT EXISTS clans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  tag TEXT NOT NULL UNIQUE,
  avatar_url TEXT,
  owner_tg_id INTEGER NOT NULL,
  bank_balance INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  join_policy TEXT NOT NULL DEFAULT 'open', -- open | closed | request
  min_level INTEGER NOT NULL DEFAULT 0      -- minimum account level required to join (0 = no restriction)
);

-- Pending join requests when a clan's join_policy is 'request' — the leader/officers approve or reject.
CREATE TABLE IF NOT EXISTS clan_join_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clan_id INTEGER NOT NULL,
  tg_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | rejected | cancelled
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS clan_members (
  tg_id INTEGER PRIMARY KEY,
  clan_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member', -- owner | admin | member
  donated_total INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clan_donations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clan_id INTEGER NOT NULL,
  tg_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clan_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  period_started_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO clan_state (id) VALUES (1);
`);

function safeAddColumn(table, columnDef) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}
// how much of their own donated share they've withdrawn/gifted so far — so they cannot withdraw more than their own contribution
safeAddColumn('clan_members', 'withdrawn_total INTEGER NOT NULL DEFAULT 0');
safeAddColumn('clan_config', 'withdraw_fee_percent INTEGER NOT NULL DEFAULT 0');

export function getClanConfig() { return db.prepare('SELECT * FROM clan_config WHERE id = 1').get(); }
export function setClanConfig(c) {
  db.prepare(`
    UPDATE clan_config SET enabled=?, creation_cost_toman=?, max_members=?, score_per_1k_purchase=?, score_per_win=?,
      score_per_1k_donation=?, reward_toman=?, winners_count=?, distribution_method=?, min_score_threshold=?, reset_days=?, withdraw_fee_percent=?
    WHERE id = 1
  `).run(c.enabled ? 1 : 0, c.creation_cost_toman, c.max_members, c.score_per_1k_purchase, c.score_per_win,
    c.score_per_1k_donation, c.reward_toman, c.winners_count, c.distribution_method, c.min_score_threshold, c.reset_days, c.withdraw_fee_percent || 0);
}

export function getMyClan(tgId) {
  const member = db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(tgId);
  if (!member) return null;
  const clan = db.prepare('SELECT * FROM clans WHERE id = ?').get(member.clan_id);
  return clan ? { ...clan, myRole: member.role, myDonatedTotal: member.donated_total, myWithdrawnTotal: member.withdrawn_total, myWithdrawableRemaining: clan.bank_balance } : null;
}
export function getClanById(id) { return db.prepare('SELECT * FROM clans WHERE id = ?').get(id); }
export function getClanMembers(clanId) {
  return db.prepare(`
    SELECT cm.*, u.first_name, u.username FROM clan_members cm JOIN users u ON u.tg_id = cm.tg_id
    WHERE cm.clan_id = ? ORDER BY cm.donated_total DESC
  `).all(clanId);
}
export function searchClans(query) {
  const like = `%${query || ''}%`;
  return db.prepare('SELECT * FROM clans WHERE name LIKE ? OR tag LIKE ? ORDER BY score DESC LIMIT 30').all(like, like);
}
export function getClanLeaderboard(limit = 10) {
  return db.prepare('SELECT * FROM clans ORDER BY score DESC LIMIT ?').all(limit);
}
export function getClanRank(clanId) {
  const row = db.prepare(`
    SELECT COUNT(*) + 1 AS rank FROM clans
    WHERE score > (SELECT COALESCE(score,0) FROM clans WHERE id = ?)
  `).get(clanId);
  return row.rank;
}

export function createClan(tgId, name, tag, avatarUrl) {
  const cfg = getClanConfig();
  if (!cfg.enabled) throw new Error('The clan system is currently disabled');
  if (getMyClan(tgId)) throw new Error('You are already a member of a clan');
  if (!name || !tag) throw new Error('Clan name and tag are required');
  const exists = db.prepare('SELECT 1 FROM clans WHERE tag = ?').get(tag);
  if (exists) throw new Error('This tag is already in use');
  const user = getUser(tgId);
  if (!user || user.balance_toman < cfg.creation_cost_toman) throw new Error(`${cfg.creation_cost_toman.toLocaleString()} LNDC is required to create a clan`);

  let clanId;
  const tx = db.transaction(() => {
    adjustToman(tgId, -cfg.creation_cost_toman, `Create clan «${name}»`);
    clanId = db.prepare('INSERT INTO clans (name, tag, avatar_url, owner_tg_id) VALUES (?,?,?,?)').run(name, tag, avatarUrl || null, tgId).lastInsertRowid;
    db.prepare(`INSERT INTO clan_members (tg_id, clan_id, role) VALUES (?,?,'owner')`).run(tgId, clanId);
  });
  tx();
  return clanId;
}

function getUserLevel(tgId) {
  const xpPerLevel = getRankConfig().xp_per_level || 1000;
  const row = db.prepare('SELECT xp FROM user_rank WHERE tg_id = ?').get(tgId);
  return Math.max(1, Math.floor((row?.xp || 0) / xpPerLevel) + 1);
}
function requireOwner(tgId, clanId) {
  const member = db.prepare('SELECT * FROM clan_members WHERE tg_id = ? AND clan_id = ?').get(tgId, clanId);
  if (!member || member.role !== 'owner') throw new Error('Only the clan leader can do this');
}

export function joinClan(tgId, clanId) {
  const cfg = getClanConfig();
  if (!cfg.enabled) throw new Error('The clan system is currently disabled');
  if (getMyClan(tgId)) throw new Error('You are already a member of a clan');
  const clan = getClanById(clanId);
  if (!clan) throw new Error('Clan not found');
  if (clan.join_policy === 'closed') throw new Error('This clan is not accepting new members right now');
  if (clan.min_level > 0 && getUserLevel(tgId) < clan.min_level) throw new Error(`This clan requires at least level ${clan.min_level} to join`);
  const memberCount = db.prepare('SELECT COUNT(*) c FROM clan_members WHERE clan_id = ?').get(clanId).c;
  if (memberCount >= cfg.max_members) throw new Error('This clan is full');
  if (clan.join_policy === 'request') {
    const existing = db.prepare(`SELECT 1 FROM clan_join_requests WHERE clan_id = ? AND tg_id = ? AND status = 'pending'`).get(clanId, tgId);
    if (existing) throw new Error('You already have a pending request for this clan');
    db.prepare('INSERT INTO clan_join_requests (clan_id, tg_id) VALUES (?,?)').run(clanId, tgId);
    return { requested: true };
  }
  db.prepare(`INSERT INTO clan_members (tg_id, clan_id, role) VALUES (?,?,'member')`).run(tgId, clanId);
  return { requested: false };
}

// Leader-only: how open the clan is to new members, and an optional minimum account level.
export function setClanJoinSettings(tgId, clanId, { joinPolicy, minLevel }) {
  requireOwner(tgId, clanId);
  const policy = ['open', 'closed', 'request'].includes(joinPolicy) ? joinPolicy : 'open';
  db.prepare('UPDATE clans SET join_policy = ?, min_level = ? WHERE id = ?').run(policy, Math.max(0, Number(minLevel) || 0), clanId);
}
export function listClanJoinRequests(tgId, clanId) {
  requireOwner(tgId, clanId);
  return db.prepare(`
    SELECT r.id, r.tg_id, r.created_at, u.first_name, u.username FROM clan_join_requests r
    JOIN users u ON u.tg_id = r.tg_id
    WHERE r.clan_id = ? AND r.status = 'pending' ORDER BY r.id ASC
  `).all(clanId);
}
export function respondClanJoinRequest(tgId, clanId, requestId, accept) {
  requireOwner(tgId, clanId);
  const cfg = getClanConfig();
  const request = db.prepare(`SELECT * FROM clan_join_requests WHERE id = ? AND clan_id = ? AND status = 'pending'`).get(requestId, clanId);
  if (!request) throw new Error('This request is no longer valid');
  const tx = db.transaction(() => {
    db.prepare(`UPDATE clan_join_requests SET status = ?, resolved_at = datetime('now') WHERE id = ?`).run(accept ? 'accepted' : 'rejected', requestId);
    if (accept) {
      if (getMyClan(request.tg_id)) throw new Error('This user has already joined another clan');
      const memberCount = db.prepare('SELECT COUNT(*) c FROM clan_members WHERE clan_id = ?').get(clanId).c;
      if (memberCount >= cfg.max_members) throw new Error('This clan is full');
      db.prepare(`INSERT INTO clan_members (tg_id, clan_id, role) VALUES (?,?,'member')`).run(request.tg_id, clanId);
    }
  });
  tx();
}

// If the leader leaves, the clan is fully disbanded; a regular member just leaves
export function leaveClan(tgId) {
  const member = db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(tgId);
  if (!member) throw new Error('You are not in any clan');
  if (member.role === 'owner') {
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM clan_members WHERE clan_id = ?').run(member.clan_id);
      db.prepare('DELETE FROM clans WHERE id = ?').run(member.clan_id);
    });
    tx();
    return { disbanded: true };
  }
  db.prepare('DELETE FROM clan_members WHERE tg_id = ?').run(tgId);
  return { disbanded: false };
}

export function kickMember(ownerTgId, targetTgId) {
  const owner = db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(ownerTgId);
  if (!owner || owner.role !== 'owner') throw new Error('Only the clan leader can kick');
  const target = db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(targetTgId);
  if (!target || target.clan_id !== owner.clan_id) throw new Error('This user is not in your clan');
  if (target.role === 'owner') throw new Error('You cannot kick yourself');
  db.prepare('DELETE FROM clan_members WHERE tg_id = ?').run(targetTgId);
}
export function setMemberRole(ownerTgId, targetTgId, role) {
  const owner = db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(ownerTgId);
  if (!owner || owner.role !== 'owner') throw new Error('Only the clan leader can assign roles');
  const target = db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(targetTgId);
  if (!target || target.clan_id !== owner.clan_id) throw new Error('This user is not in your clan');
  db.prepare(`UPDATE clan_members SET role = ? WHERE tg_id = ?`).run(role === 'admin' ? 'admin' : 'member', targetTgId);
}

export function donateToClan(tgId, amount) {
  const member = db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(tgId);
  if (!member) throw new Error('You are not in any clan');
  if (!amount || amount <= 0) throw new Error('Invalid amount');
  const user = getUser(tgId);
  if (!user || user.balance_toman < amount) throw new Error('Insufficient balance');
  const cfg = getClanConfig();
  const scoreGain = Math.floor(amount / 1000) * cfg.score_per_1k_donation;

  const tx = db.transaction(() => {
    adjustToman(tgId, -amount, 'Donation to clan bank');
    db.prepare('UPDATE clans SET bank_balance = bank_balance + ?, score = score + ? WHERE id = ?').run(amount, scoreGain, member.clan_id);
    db.prepare('UPDATE clan_members SET donated_total = donated_total + ? WHERE tg_id = ?').run(amount, tgId);
    db.prepare('INSERT INTO clan_donations (clan_id, tg_id, amount) VALUES (?,?,?)').run(member.clan_id, tgId, amount);
  });
  tx();
}

// The clan leader can withdraw from the clan bank (funds members donated) to their own wallet
export function withdrawFromClanBank(ownerTgId, amount) {
  const owner = db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(ownerTgId);
  if (!owner || owner.role !== 'owner') throw new Error('Only the clan leader can withdraw from the clan bank');
  if (!amount || amount <= 0) throw new Error('Invalid amount');
  const clan = getClanById(owner.clan_id);
  if (!clan || clan.bank_balance < amount) throw new Error('Insufficient clan bank balance');
  const cfg = getClanConfig();
  const fee = Math.round(amount * (cfg.withdraw_fee_percent || 0) / 100);
  const net = amount - fee;
  const tx = db.transaction(() => {
    db.prepare('UPDATE clans SET bank_balance = bank_balance - ? WHERE id = ?').run(amount, clan.id);
    db.prepare('UPDATE clan_members SET withdrawn_total = withdrawn_total + ? WHERE tg_id = ?').run(amount, ownerTgId);
    adjustToman(ownerTgId, net, `Withdrawal from clan bank «${clan.name}»${fee > 0 ? ` (${fee.toLocaleString()} LNDC fee deducted)` : ''}`);
  });
  tx();
  return { net, fee };
}
// The clan leader can gift directly from the clan bank to a member
export function giftFromClanBank(ownerTgId, targetTgId, amount) {
  const owner = db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(ownerTgId);
  if (!owner || owner.role !== 'owner') throw new Error('Only the clan leader can gift from the clan bank');
  if (!amount || amount <= 0) throw new Error('Invalid amount');
  const target = db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(targetTgId);
  if (!target || target.clan_id !== owner.clan_id) throw new Error('This user is not in your clan');
  const clan = getClanById(owner.clan_id);
  if (!clan || clan.bank_balance < amount) throw new Error('Insufficient clan bank balance');
  const cfg = getClanConfig();
  const fee = Math.round(amount * (cfg.withdraw_fee_percent || 0) / 100);
  const net = amount - fee;
  const tx = db.transaction(() => {
    db.prepare('UPDATE clans SET bank_balance = bank_balance - ? WHERE id = ?').run(amount, clan.id);
    db.prepare('UPDATE clan_members SET withdrawn_total = withdrawn_total + ? WHERE tg_id = ?').run(amount, ownerTgId);
    adjustToman(targetTgId, net, `Gift from clan bank «${clan.name}»${fee > 0 ? ` (${fee.toLocaleString()} LNDC fee deducted)` : ''}`);
  });
  tx();
  return { net, fee };
}

// Hooks called from other parts of the app (shop purchases, game wins)
export function addClanPurchaseScore(tgId, amountToman) {
  const member = db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(tgId);
  if (!member) return;
  const cfg = getClanConfig();
  const scoreGain = Math.floor(amountToman / 1000) * cfg.score_per_1k_purchase;
  if (scoreGain > 0) db.prepare('UPDATE clans SET score = score + ? WHERE id = ?').run(scoreGain, member.clan_id);
}
export function addClanWinScore(tgId) {
  const member = db.prepare('SELECT * FROM clan_members WHERE tg_id = ?').get(tgId);
  if (!member) return;
  const cfg = getClanConfig();
  if (cfg.score_per_win > 0) db.prepare('UPDATE clans SET score = score + ? WHERE id = ?').run(cfg.score_per_win, member.clan_id);
}

export function getClanState() { return db.prepare('SELECT * FROM clan_state WHERE id = 1').get(); }

// Distributes prizes to the top clans and resets scores (the bank remains untouched)
export function resetClanSeason(notifyFn) {
  const cfg = getClanConfig();
  const top = db.prepare('SELECT * FROM clans WHERE score >= ? ORDER BY score DESC LIMIT ?').all(cfg.min_score_threshold, cfg.winners_count);
  for (const clan of top) {
    const members = getClanMembers(clan.id);
    if (!members.length || cfg.reward_toman <= 0) continue;
    if (cfg.distribution_method === 'donation_share') {
      const totalDonated = members.reduce((s, m) => s + m.donated_total, 0);
      for (const m of members) {
        const share = totalDonated > 0 ? Math.floor((cfg.reward_toman * m.donated_total) / totalDonated) : Math.floor(cfg.reward_toman / members.length);
        if (share > 0) { adjustToman(m.tg_id, share, `Clan prize "${clan.name}" (based on donation share)`); if (notifyFn) notifyFn(m.tg_id, clan, share); }
      }
    } else {
      const share = Math.floor(cfg.reward_toman / members.length);
      for (const m of members) {
        if (share > 0) { adjustToman(m.tg_id, share, `Clan prize «${clan.name}»`); if (notifyFn) notifyFn(m.tg_id, clan, share); }
      }
    }
  }
  db.prepare('UPDATE clans SET score = 0').run();
  db.prepare(`UPDATE clan_state SET period_started_at = datetime('now') WHERE id = 1`).run();
}
export function checkAutoResetClanSeason(notifyFn) {
  const cfg = getClanConfig();
  if (!cfg.enabled) return;
  const state = getClanState();
  const startedAt = new Date(state.period_started_at.replace(' ', 'T') + 'Z').getTime();
  if (Date.now() >= startedAt + cfg.reset_days * 24 * 60 * 60 * 1000) resetClanSeason(notifyFn);
}

/* ---------- Admin operations on any clan ---------- */
export function adminDeleteClan(clanId) {
  const clan = getClanById(clanId);
  if (!clan) throw new Error('Clan not found');
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM clan_members WHERE clan_id = ?').run(clanId);
    db.prepare('DELETE FROM clan_donations WHERE clan_id = ?').run(clanId);
    db.prepare('DELETE FROM clans WHERE id = ?').run(clanId);
  });
  tx();
}
// The admin can manually increase/decrease any clan's bank balance without limit (no fee)
export function adminAdjustClanBank(clanId, amount) {
  const clan = getClanById(clanId);
  if (!clan) throw new Error('Clan not found');
  if (clan.bank_balance + amount < 0) throw new Error('The clan bank balance cannot go negative');
  db.prepare('UPDATE clans SET bank_balance = bank_balance + ? WHERE id = ?').run(amount, clanId);
}
export function listAllClansAdmin() {
  return db.prepare('SELECT * FROM clans ORDER BY score DESC').all();
}

/* =========================================================================
 * Clan chat — private to each clan's own members. Messages are polled by the mini app every couple
 * of seconds while the chat is open (there's no websocket/push layer in this stack, so short polling
 * is what gets closest to "real-time" here) and are auto-deleted after a configurable retention
 * window so the chat never grows unbounded.
 * ========================================================================= */
db.exec(`
CREATE TABLE IF NOT EXISTS clan_chat_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 1,
  retention_minutes INTEGER NOT NULL DEFAULT 60,
  max_message_length INTEGER NOT NULL DEFAULT 300
);
INSERT OR IGNORE INTO clan_chat_config (id) VALUES (1);

CREATE TABLE IF NOT EXISTS clan_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clan_id INTEGER NOT NULL,
  tg_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export function getClanChatConfig() { return db.prepare('SELECT * FROM clan_chat_config WHERE id = 1').get(); }
export function setClanChatConfig(c) {
  db.prepare(`UPDATE clan_chat_config SET enabled=?, retention_minutes=?, max_message_length=? WHERE id = 1`)
    .run(c.enabled ? 1 : 0, Math.max(1, Number(c.retention_minutes) || 60), Math.max(20, Number(c.max_message_length) || 300));
}
function getMemberClanId(tgId) {
  const member = db.prepare('SELECT clan_id FROM clan_members WHERE tg_id = ?').get(tgId);
  return member ? member.clan_id : null;
}
// Deletes messages older than the configured retention window — run on every send/fetch so a clan's
// chat never keeps growing and old messages always disappear on schedule, without needing a
// separate background job/cron.
function cleanupOldClanMessages(clanId, retentionMinutes) {
  db.prepare(`DELETE FROM clan_messages WHERE clan_id = ? AND created_at < datetime('now', ?)`)
    .run(clanId, `-${retentionMinutes} minutes`);
}
export function sendClanMessage(tgId, text) {
  const cfg = getClanChatConfig();
  if (!cfg.enabled) throw new Error('Clan chat is currently disabled');
  const clanId = getMemberClanId(tgId);
  if (!clanId) throw new Error('You are not in a clan');
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Message cannot be empty');
  if (trimmed.length > cfg.max_message_length) throw new Error(`Message is too long (max ${cfg.max_message_length} characters)`);
  cleanupOldClanMessages(clanId, cfg.retention_minutes);
  const info = db.prepare('INSERT INTO clan_messages (clan_id, tg_id, text) VALUES (?,?,?)').run(clanId, tgId, trimmed);
  return info.lastInsertRowid;
}
// afterId lets the mini app poll incrementally (only new messages since its last known id) instead of
// re-fetching and re-rendering the whole chat every couple of seconds.
export function getClanMessages(tgId, afterId = 0) {
  const cfg = getClanChatConfig();
  const clanId = getMemberClanId(tgId);
  if (!clanId) return { messages: [], enabled: cfg.enabled };
  cleanupOldClanMessages(clanId, cfg.retention_minutes);
  // Level + equipped avatar are joined in directly (not fetched per-message) so the chat can show a
  // proper level badge and avatar image next to each sender's name without an N+1 query per message.
  const xpPerLevel = getRankConfig().xp_per_level || 1000;
  const rows = db.prepare(`
    SELECT cm.id, cm.tg_id, cm.text, cm.created_at, u.first_name, u.username,
      COALESCE(ur.xp, 0) AS xp, av.image_url AS avatar_image
    FROM clan_messages cm JOIN users u ON u.tg_id = cm.tg_id
    LEFT JOIN user_rank ur ON ur.tg_id = cm.tg_id
    LEFT JOIN avatars av ON av.id = ur.equipped_avatar_id
    WHERE cm.clan_id = ? AND cm.id > ? ORDER BY cm.id ASC LIMIT 200
  `).all(clanId, afterId);
  const messages = rows.map(r => ({ ...r, level: Math.max(1, Math.floor(r.xp / xpPerLevel) + 1) }));
  return { messages, enabled: cfg.enabled, retentionMinutes: cfg.retention_minutes };
}
