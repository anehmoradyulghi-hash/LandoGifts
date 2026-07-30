import db from './db.js';
import { getMyClan, getClanById, getClanMembers, addClanWinScore } from './clan-db.js';
import { getUserCard, getUserCards } from './game-db.js';

/* =========================================================================
 * جنگ کلن به کلن — ورودی از بانک کلن (پول‌های اهدایی)، هر طرف ۵ نفر از اعضاش
 * رو با کارت‌هاشون می‌فرسته، مجموع قدرت مقایسه می‌شه، برنده کل مبلغ رو با
 * کسر کارمزد می‌بره. کاملا داخل‌سروری، بدون نیاز به تماس بیرونی.
 * ========================================================================= */
db.exec(`
CREATE TABLE IF NOT EXISTS clan_war_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 1,
  min_entry_toman INTEGER NOT NULL DEFAULT 100000,
  fee_percent INTEGER NOT NULL DEFAULT 10,
  team_size INTEGER NOT NULL DEFAULT 5
);
INSERT OR IGNORE INTO clan_war_config (id) VALUES (1);

CREATE TABLE IF NOT EXISTS clan_wars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clan_a_id INTEGER NOT NULL,
  clan_b_id INTEGER,
  entry_toman INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open | picking | finished | cancelled
  clan_a_picks TEXT DEFAULT '[]',
  clan_b_picks TEXT DEFAULT '[]',
  clan_a_power INTEGER,
  clan_b_power INTEGER,
  winner_clan_id INTEGER,
  pot_toman INTEGER,
  fee_toman INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
`);

export function getClanWarConfig() { return db.prepare('SELECT * FROM clan_war_config WHERE id = 1').get(); }
export function setClanWarConfig(c) {
  db.prepare(`
    UPDATE clan_war_config SET enabled=?, min_entry_toman=?, fee_percent=?, team_size=? WHERE id = 1
  `).run(c.enabled ? 1 : 0, Number(c.min_entry_toman) || 100000, Number(c.fee_percent) || 10, Number(c.team_size) || 5);
}

function requireLeader(tgId) {
  const clan = getMyClan(tgId);
  if (!clan) throw new Error('عضو هیچ کلنی نیستی');
  if (clan.myRole !== 'owner' && clan.myRole !== 'admin') throw new Error('فقط رهبر یا مدیر کلن می‌تونه این کارو بکنه');
  return clan;
}

function decorateWar(w) {
  const clanA = getClanById(w.clan_a_id);
  const clanB = w.clan_b_id ? getClanById(w.clan_b_id) : null;
  return {
    ...w,
    clanAPicks: JSON.parse(w.clan_a_picks || '[]'),
    clanBPicks: JSON.parse(w.clan_b_picks || '[]'),
    clanAName: clanA ? `${clanA.name} #${clanA.tag}` : '—',
    clanBName: clanB ? `${clanB.name} #${clanB.tag}` : null,
  };
}

export function getClanWar(id) {
  const w = db.prepare('SELECT * FROM clan_wars WHERE id = ?').get(id);
  return w ? decorateWar(w) : null;
}
// جنگ‌های بازی که منتظر حریفن (کلن خودم رو نشون نمی‌ده)
export function listOpenClanWars(excludeClanId) {
  return db.prepare(`SELECT * FROM clan_wars WHERE status = 'open' AND clan_a_id != ? ORDER BY id DESC LIMIT 30`)
    .all(excludeClanId || 0).map(decorateWar);
}
// جنگ فعال کلن خودم (چه در انتظار حریف، چه در حال چیدن دسته)
export function getMyActiveClanWar(clanId) {
  const w = db.prepare(`
    SELECT * FROM clan_wars WHERE (clan_a_id = ? OR clan_b_id = ?) AND status IN ('open','picking')
    ORDER BY id DESC LIMIT 1
  `).get(clanId, clanId);
  return w ? decorateWar(w) : null;
}
export function getClanWarHistory(clanId, limit = 20) {
  return db.prepare(`
    SELECT * FROM clan_wars WHERE (clan_a_id = ? OR clan_b_id = ?) AND status IN ('finished','cancelled')
    ORDER BY id DESC LIMIT ?
  `).all(clanId, clanId, limit).map(decorateWar);
}

export function getMemberCardsForLeader(leaderTgId, memberTgId) {
  const clan = requireLeader(leaderTgId);
  const isMember = getClanMembers(clan.id).some(m => m.tg_id === Number(memberTgId));
  if (!isMember) throw new Error('این فرد عضو کلن تو نیست');
  return getUserCards(Number(memberTgId));
}

export function createClanWar(leaderTgId, entryToman) {
  const cfg = getClanWarConfig();
  if (!cfg.enabled) throw new Error('جنگ کلن‌ها فعلا غیرفعاله');
  const clan = requireLeader(leaderTgId);
  const entry = Number(entryToman);
  if (!entry || entry < cfg.min_entry_toman) throw new Error(`حداقل ورودی ${cfg.min_entry_toman.toLocaleString()} تومانه`);
  if (getMyActiveClanWar(clan.id)) throw new Error('کلنت همین الان یه جنگ باز داره');
  if (clan.bank_balance < entry) throw new Error('موجودی بانک کلن (پول‌های اهدایی) کافی نیست');

  return db.transaction(() => {
    db.prepare('UPDATE clans SET bank_balance = bank_balance - ? WHERE id = ?').run(entry, clan.id);
    return db.prepare('INSERT INTO clan_wars (clan_a_id, entry_toman) VALUES (?,?)').run(clan.id, entry).lastInsertRowid;
  })();
}

export function cancelClanWar(warId, leaderTgId) {
  const clan = requireLeader(leaderTgId);
  const war = db.prepare('SELECT * FROM clan_wars WHERE id = ?').get(warId);
  if (!war) throw new Error('جنگ پیدا نشد');
  if (war.clan_a_id !== clan.id) throw new Error('فقط کلن سازنده می‌تونه لغوش کنه');
  if (war.status !== 'open') throw new Error('این جنگ دیگه قابل لغو نیست (حریف پیدا کرده)');
  db.transaction(() => {
    db.prepare('UPDATE clans SET bank_balance = bank_balance + ? WHERE id = ?').run(war.entry_toman, clan.id);
    db.prepare(`UPDATE clan_wars SET status = 'cancelled' WHERE id = ?`).run(warId);
  })();
}

export function joinClanWar(warId, leaderTgId) {
  const clan = requireLeader(leaderTgId);
  const war = db.prepare('SELECT * FROM clan_wars WHERE id = ?').get(warId);
  if (!war) throw new Error('جنگ پیدا نشد');
  if (war.status !== 'open') throw new Error('این جنگ در انتظار حریف نیست');
  if (war.clan_a_id === clan.id) throw new Error('نمی‌تونی با کلن خودت بجنگی');
  if (getMyActiveClanWar(clan.id)) throw new Error('کلنت همین الان یه جنگ باز داره');
  if (clan.bank_balance < war.entry_toman) throw new Error('موجودی بانک کلن (پول‌های اهدایی) کافی نیست');

  db.transaction(() => {
    db.prepare('UPDATE clans SET bank_balance = bank_balance - ? WHERE id = ?').run(war.entry_toman, clan.id);
    db.prepare(`UPDATE clan_wars SET clan_b_id = ?, status = 'picking' WHERE id = ?`).run(clan.id, warId);
  })();
  return getClanWar(warId);
}

function validatePicks(clanId, cfg, picks) {
  if (!Array.isArray(picks) || picks.length !== cfg.team_size) throw new Error(`باید دقیقا ${cfg.team_size} نفر رو با کارت‌هاشون انتخاب کنی`);
  const memberIds = new Set(getClanMembers(clanId).map(m => m.tg_id));
  const seen = new Set();
  let totalPower = 0;
  for (const p of picks) {
    const tgId = Number(p.tgId);
    if (!memberIds.has(tgId)) throw new Error('یکی از افراد انتخاب‌شده عضو این کلن نیست');
    if (seen.has(tgId)) throw new Error('یه نفر رو نمی‌تونی دوبار انتخاب کنی');
    seen.add(tgId);
    const cardIds = Array.isArray(p.cardIds) ? [...new Set(p.cardIds.map(Number))] : [];
    if (!cardIds.length) throw new Error('هر عضو باید حداقل یه کارت داشته باشه');
    for (const cid of cardIds) {
      const card = getUserCard(tgId, cid);
      if (!card) throw new Error('یکی از کارت‌های انتخابی معتبر نیست');
      totalPower += card.power;
    }
  }
  return { picks: picks.map(p => ({ tgId: Number(p.tgId), cardIds: [...new Set(p.cardIds.map(Number))] })), totalPower };
}

// رهبر/مدیر هر طرف، ۵ نفر و کارت‌هاشون رو ثبت می‌کنه؛ وقتی هر دو طرف ثبت کردن، جنگ خودکار حل می‌شه
export function submitWarPicks(warId, leaderTgId, picks) {
  const cfg = getClanWarConfig();
  const clan = requireLeader(leaderTgId);
  const war = db.prepare('SELECT * FROM clan_wars WHERE id = ?').get(warId);
  if (!war) throw new Error('جنگ پیدا نشد');
  if (war.status !== 'picking') throw new Error('این جنگ الان تو مرحله چیدن دسته نیست');
  if (war.clan_a_id !== clan.id && war.clan_b_id !== clan.id) throw new Error('این جنگ مال کلن تو نیست');

  const side = war.clan_a_id === clan.id ? 'a' : 'b';
  if (side === 'a' && war.clan_a_power != null) throw new Error('کلن تو قبلا دسته‌ش رو ثبت کرده');
  if (side === 'b' && war.clan_b_power != null) throw new Error('کلن تو قبلا دسته‌ش رو ثبت کرده');

  const { picks: cleanPicks, totalPower } = validatePicks(clan.id, cfg, picks);

  return db.transaction(() => {
    if (side === 'a') {
      db.prepare('UPDATE clan_wars SET clan_a_picks = ?, clan_a_power = ? WHERE id = ?').run(JSON.stringify(cleanPicks), totalPower, warId);
    } else {
      db.prepare('UPDATE clan_wars SET clan_b_picks = ?, clan_b_power = ? WHERE id = ?').run(JSON.stringify(cleanPicks), totalPower, warId);
    }
    const fresh = db.prepare('SELECT * FROM clan_wars WHERE id = ?').get(warId);
    if (fresh.clan_a_power != null && fresh.clan_b_power != null) {
      resolveClanWar(fresh);
    }
    return getClanWar(warId);
  })();
}

function resolveClanWar(war) {
  const cfg = getClanWarConfig();
  // کمی شانس تصادفی (تا ۱۵٪) تا مسابقه صرفا ریاضی نباشه — همون فرمول نبرد ۱به۱
  const rollA = war.clan_a_power * (1 + Math.random() * 0.15);
  const rollB = war.clan_b_power * (1 + Math.random() * 0.15);
  const winnerClanId = rollA >= rollB ? war.clan_a_id : war.clan_b_id;
  const pot = war.entry_toman * 2;
  const fee = Math.round(pot * cfg.fee_percent / 100);
  const payout = pot - fee;

  db.prepare('UPDATE clans SET bank_balance = bank_balance + ? WHERE id = ?').run(payout, winnerClanId);
  db.prepare(`
    UPDATE clan_wars SET status = 'finished', winner_clan_id = ?, pot_toman = ?, fee_toman = ?, finished_at = datetime('now')
    WHERE id = ?
  `).run(winnerClanId, pot, fee, war.id);

  const winnerOwner = db.prepare(`SELECT tg_id FROM clan_members WHERE clan_id = ? AND role = 'owner'`).get(winnerClanId);
  if (winnerOwner) addClanWinScore(winnerOwner.tg_id);
}
