import db from './db.js';
import { adjustToman, getUser } from './db.js';

/* =========================================================================
 * SCHEMA — بازی کارتی. همه‌چیز خودکار و داخل‌سروری (بدون تماس بیرونی)، تنظیمات
 * (تعداد بازی روزانه، سایز دسته، قیمت بازی اضافه، دوره ریست جدول امتیازات و
 * جوایزش) کاملا از پنل ادمین قابل تغییره.
 * ========================================================================= */
db.exec(`
CREATE TABLE IF NOT EXISTS game_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  image_url TEXT,
  rarity TEXT NOT NULL DEFAULT 'common', -- common | rare | epic | legendary
  base_power INTEGER NOT NULL DEFAULT 10,
  price_toman INTEGER NOT NULL DEFAULT 0,
  max_level INTEGER NOT NULL DEFAULT 10,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  card_id INTEGER NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS game_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  min_deck_size INTEGER NOT NULL DEFAULT 3,
  max_deck_size INTEGER NOT NULL DEFAULT 5,
  daily_play_limit INTEGER NOT NULL DEFAULT 10,
  extra_play_price_toman INTEGER NOT NULL DEFAULT 5000,
  extra_play_count INTEGER NOT NULL DEFAULT 5,
  leaderboard_reset_days INTEGER NOT NULL DEFAULT 7,
  upgrade_base_cost_toman INTEGER NOT NULL DEFAULT 3000
);
INSERT OR IGNORE INTO game_config (id) VALUES (1);

CREATE TABLE IF NOT EXISTS game_queue (
  tg_id INTEGER PRIMARY KEY,
  deck_json TEXT NOT NULL,
  power INTEGER NOT NULL,
  joined_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS game_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_a INTEGER NOT NULL,
  player_b INTEGER NOT NULL,
  power_a INTEGER NOT NULL,
  power_b INTEGER NOT NULL,
  winner_tg_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS game_play_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  play_date TEXT NOT NULL DEFAULT (date('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS game_extra_plays (
  tg_id INTEGER PRIMARY KEY,
  extra_plays INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS game_scores (
  tg_id INTEGER PRIMARY KEY,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leaderboard_prizes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rank_from INTEGER NOT NULL,
  rank_to INTEGER NOT NULL,
  reward_toman INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS leaderboard_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  period_started_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_reset_at TEXT
);
INSERT OR IGNORE INTO leaderboard_state (id) VALUES (1);

CREATE TABLE IF NOT EXISTS card_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'join_channel',
  channel_username TEXT,
  reward_card_id INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS card_task_claims (
  tg_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tg_id, task_id)
);
`);

/* =========================================================================
 * CONFIG
 * ========================================================================= */
export function getGameConfig() {
  return db.prepare('SELECT * FROM game_config WHERE id = 1').get();
}
export function setGameConfig(cfg) {
  const cur = getGameConfig();
  const merged = { ...cur, ...cfg };
  db.prepare(`
    UPDATE game_config SET min_deck_size=@min_deck_size, max_deck_size=@max_deck_size,
      daily_play_limit=@daily_play_limit, extra_play_price_toman=@extra_play_price_toman,
      extra_play_count=@extra_play_count, leaderboard_reset_days=@leaderboard_reset_days,
      upgrade_base_cost_toman=@upgrade_base_cost_toman
    WHERE id = 1
  `).run(merged);
}

/* =========================================================================
 * CARDS (admin catalogue)
 * ========================================================================= */
export function listGameCards(onlyActive = false) {
  return onlyActive
    ? db.prepare('SELECT * FROM game_cards WHERE active = 1 ORDER BY price_toman ASC').all()
    : db.prepare('SELECT * FROM game_cards ORDER BY id DESC').all();
}
export function getGameCard(id) { return db.prepare('SELECT * FROM game_cards WHERE id = ?').get(id); }
export function upsertGameCard(c) {
  if (c.id) {
    db.prepare(`UPDATE game_cards SET name=?, image_url=?, rarity=?, base_power=?, price_toman=?, max_level=?, active=? WHERE id=?`)
      .run(c.name, c.image_url || null, c.rarity, c.base_power, c.price_toman, c.max_level, c.active ? 1 : 0, c.id);
    return c.id;
  }
  return db.prepare(`INSERT INTO game_cards (name, image_url, rarity, base_power, price_toman, max_level, active) VALUES (?,?,?,?,?,?,?)`)
    .run(c.name, c.image_url || null, c.rarity, c.base_power, c.price_toman, c.max_level, c.active ? 1 : 0).lastInsertRowid;
}
export function deleteGameCard(id) { db.prepare('DELETE FROM game_cards WHERE id = ?').run(id); }

export function computeCardPower(basePower, level) {
  return Math.round(basePower * (1 + 0.15 * (level - 1)));
}

/* =========================================================================
 * USER CARDS — خرید، دیدن مجموعه، ارتقا (پولی یا با قربانی‌کردن کارت مشابه)
 * ========================================================================= */
export function getUserCards(tgId) {
  return db.prepare(`
    SELECT uc.id, uc.card_id, uc.level, uc.created_at,
      c.name, c.image_url, c.rarity, c.base_power, c.max_level
    FROM user_cards uc JOIN game_cards c ON c.id = uc.card_id
    WHERE uc.tg_id = ? ORDER BY uc.id DESC
  `).all(tgId).map(row => ({ ...row, power: computeCardPower(row.base_power, row.level) }));
}
export function getUserCard(tgId, userCardId) {
  const row = db.prepare(`
    SELECT uc.*, c.name, c.image_url, c.rarity, c.base_power, c.max_level, c.price_toman
    FROM user_cards uc JOIN game_cards c ON c.id = uc.card_id
    WHERE uc.id = ? AND uc.tg_id = ?
  `).get(userCardId, tgId);
  return row ? { ...row, power: computeCardPower(row.base_power, row.level) } : null;
}

export function buyGameCard(tgId, cardId) {
  const card = getGameCard(cardId);
  if (!card || !card.active) throw new Error('این کارت در دسترس نیست');
  const user = getUser(tgId);
  if (!user || user.balance_toman < card.price_toman) throw new Error('موجودی کیف‌پول کافی نیست');
  adjustToman(tgId, -card.price_toman, `خرید کارت «${card.name}»`);
  const id = db.prepare(`INSERT INTO user_cards (tg_id, card_id) VALUES (?,?)`).run(tgId, cardId).lastInsertRowid;
  return id;
}

export function upgradeUserCard(tgId, userCardId) {
  const uc = getUserCard(tgId, userCardId);
  if (!uc) throw new Error('این کارت پیدا نشد');
  if (uc.level >= uc.max_level) throw new Error('این کارت به حداکثر سطح رسیده');
  const cfg = getGameConfig();
  const cost = Math.round(cfg.upgrade_base_cost_toman * uc.level);
  const user = getUser(tgId);
  if (user.balance_toman < cost) throw new Error(`برای ارتقا ${cost.toLocaleString()} تومان لازمه`);
  adjustToman(tgId, -cost, `ارتقای کارت «${uc.name}» به سطح ${uc.level + 1}`);
  db.prepare('UPDATE user_cards SET level = level + 1 WHERE id = ?').run(userCardId);
  return { cost, newLevel: uc.level + 1 };
}

// ادغام رایگان: یه کارت مشابه (همون card_id) رو قربانی می‌کنی تا کارت هدف یه سطح بره بالا
export function sacrificeUpgradeCard(tgId, targetUserCardId, sacrificeUserCardId) {
  if (targetUserCardId === sacrificeUserCardId) throw new Error('نمی‌تونی یه کارت رو با خودش ادغام کنی');
  const target = getUserCard(tgId, targetUserCardId);
  const sac = getUserCard(tgId, sacrificeUserCardId);
  if (!target || !sac) throw new Error('کارت پیدا نشد');
  if (target.card_id !== sac.card_id) throw new Error('فقط کارت‌های یکسان قابل ادغامن');
  if (target.level >= target.max_level) throw new Error('این کارت به حداکثر سطح رسیده');

  const tx = db.transaction(() => {
    db.prepare('UPDATE user_cards SET level = level + 1 WHERE id = ?').run(targetUserCardId);
    db.prepare('DELETE FROM user_cards WHERE id = ?').run(sacrificeUserCardId);
  });
  tx();
  return { newLevel: target.level + 1 };
}

/* =========================================================================
 * تسک‌های کارتی — پاداششون به‌جای تومان، یه کارت مشخصه
 * ========================================================================= */
export function listActiveCardTasks() {
  return db.prepare(`
    SELECT ct.*, c.name AS card_name, c.image_url AS card_image
    FROM card_tasks ct JOIN game_cards c ON c.id = ct.reward_card_id
    WHERE ct.active = 1 ORDER BY ct.id DESC
  `).all();
}
export function listAllCardTasksAdmin() { return db.prepare('SELECT * FROM card_tasks ORDER BY id DESC').all(); }
export function getCardTask(id) { return db.prepare('SELECT * FROM card_tasks WHERE id = ?').get(id); }
export function upsertCardTask(t) {
  if (t.id) {
    db.prepare(`UPDATE card_tasks SET title=?, kind=?, channel_username=?, reward_card_id=?, active=? WHERE id=?`)
      .run(t.title, t.kind, t.channel_username || null, t.reward_card_id, t.active ? 1 : 0, t.id);
    return t.id;
  }
  return db.prepare(`INSERT INTO card_tasks (title, kind, channel_username, reward_card_id, active) VALUES (?,?,?,?,?)`)
    .run(t.title, t.kind, t.channel_username || null, t.reward_card_id, t.active ? 1 : 0).lastInsertRowid;
}
export function deleteCardTask(id) { db.prepare('DELETE FROM card_tasks WHERE id = ?').run(id); }
export function hasClaimedCardTask(tgId, taskId) { return !!db.prepare('SELECT 1 FROM card_task_claims WHERE tg_id = ? AND task_id = ?').get(tgId, taskId); }
export function claimCardTask(tgId, task) {
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO card_task_claims (tg_id, task_id) VALUES (?,?)').run(tgId, task.id);
    db.prepare('INSERT INTO user_cards (tg_id, card_id) VALUES (?,?)').run(tgId, task.reward_card_id);
  });
  tx();
}

/* =========================================================================
 * محدودیت بازی روزانه + بازی اضافه
 * ========================================================================= */
function todayCount(tgId) {
  return db.prepare(`SELECT COUNT(*) c FROM game_play_log WHERE tg_id = ? AND play_date = date('now')`).get(tgId).c;
}
export function getExtraPlays(tgId) {
  return db.prepare('SELECT extra_plays FROM game_extra_plays WHERE tg_id = ?').get(tgId)?.extra_plays || 0;
}
export function getPlaysRemaining(tgId) {
  const cfg = getGameConfig();
  const used = todayCount(tgId);
  const extra = getExtraPlays(tgId);
  return Math.max(0, cfg.daily_play_limit + extra - used);
}
export function buyExtraPlays(tgId) {
  const cfg = getGameConfig();
  const user = getUser(tgId);
  if (user.balance_toman < cfg.extra_play_price_toman) throw new Error('موجودی کافی نیست');
  adjustToman(tgId, -cfg.extra_play_price_toman, `خرید ${cfg.extra_play_count} بازی اضافه`);
  db.prepare(`
    INSERT INTO game_extra_plays (tg_id, extra_plays) VALUES (?, ?)
    ON CONFLICT(tg_id) DO UPDATE SET extra_plays = extra_plays + excluded.extra_plays
  `).run(tgId, cfg.extra_play_count);
  return getPlaysRemaining(tgId);
}
function consumePlay(tgId) {
  db.prepare('INSERT INTO game_play_log (tg_id) VALUES (?)').run(tgId);
  const extra = getExtraPlays(tgId);
  const cfg = getGameConfig();
  const used = todayCount(tgId);
  // بازی‌های روزانه رایگان اول مصرف می‌شن، بعد بازی‌های اضافه
  if (used > cfg.daily_play_limit && extra > 0) {
    db.prepare('UPDATE game_extra_plays SET extra_plays = MAX(0, extra_plays - 1) WHERE tg_id = ?').run(tgId);
  }
}

/* =========================================================================
 * صف بازی و مسابقه — کاملا سینک (بدون await) تا هیچ race condition‌ای پیش نیاد
 * ========================================================================= */
export function getQueueStatus(tgId) {
  const row = db.prepare('SELECT * FROM game_queue WHERE tg_id = ?').get(tgId);
  return row ? { waiting: true, joined_at: row.joined_at } : { waiting: false };
}
export function cancelQueue(tgId) {
  db.prepare('DELETE FROM game_queue WHERE tg_id = ?').run(tgId);
}

export function joinQueue(tgId, userCardIds) {
  const cfg = getGameConfig();
  if (!Array.isArray(userCardIds) || userCardIds.length < cfg.min_deck_size || userCardIds.length > cfg.max_deck_size) {
    throw new Error(`دسته باید بین ${cfg.min_deck_size} تا ${cfg.max_deck_size} کارت داشته باشه`);
  }
  if (getQueueStatus(tgId).waiting) throw new Error('همین الان تو صف انتظاری');
  if (getPlaysRemaining(tgId) <= 0) throw new Error('بازی‌های امروزت تموم شده — از فروشگاه بازی اضافه بخر');

  const uniqueIds = [...new Set(userCardIds.map(Number))];
  if (uniqueIds.length !== userCardIds.length) throw new Error('کارت تکراری تو دسته مجاز نیست');

  const cards = uniqueIds.map(id => getUserCard(tgId, id));
  if (cards.some(c => !c)) throw new Error('یکی از کارت‌های انتخابی پیدا نشد');
  const power = cards.reduce((s, c) => s + c.power, 0);

  return db.transaction(() => {
    const opponent = db.prepare('SELECT * FROM game_queue ORDER BY joined_at ASC LIMIT 1').get();
    if (!opponent) {
      db.prepare('INSERT INTO game_queue (tg_id, deck_json, power) VALUES (?,?,?)').run(tgId, JSON.stringify(uniqueIds), power);
      return { matched: false, waiting: true };
    }
    // مسابقه فوری با اولین حریف تو صف
    db.prepare('DELETE FROM game_queue WHERE tg_id = ?').run(opponent.tg_id);
    consumePlay(tgId);
    consumePlay(opponent.tg_id);

    // کمی شانس تصادفی (تا ۱۵٪) به قدرت هر طرف اضافه می‌شه تا مسابقه صرفا ریاضی نباشه
    const rollA = power * (1 + Math.random() * 0.15);
    const rollB = opponent.power * (1 + Math.random() * 0.15);
    const winner = rollA >= rollB ? tgId : opponent.tg_id;
    const loser = winner === tgId ? opponent.tg_id : tgId;

    db.prepare('INSERT INTO game_matches (player_a, player_b, power_a, power_b, winner_tg_id) VALUES (?,?,?,?,?)')
      .run(tgId, opponent.tg_id, power, opponent.power, winner);

    bumpScore(winner, true);
    bumpScore(loser, false);

    return {
      matched: true,
      opponentTgId: opponent.tg_id,
      myPower: power,
      opponentPower: opponent.power,
      won: winner === tgId,
    };
  })();
}

function bumpScore(tgId, won) {
  db.prepare(`
    INSERT INTO game_scores (tg_id, wins, losses, score, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(tg_id) DO UPDATE SET
      wins = wins + excluded.wins,
      losses = losses + excluded.losses,
      score = score + excluded.score,
      updated_at = datetime('now')
  `).run(tgId, won ? 1 : 0, won ? 0 : 1, won ? 3 : 1);
}

export function getMatchHistory(tgId, limit = 20) {
  return db.prepare(`
    SELECT * FROM game_matches WHERE player_a = ? OR player_b = ? ORDER BY created_at DESC LIMIT ?
  `).all(tgId, tgId, limit);
}

/* =========================================================================
 * جدول امتیازات + جوایز + ریست دوره‌ای
 * ========================================================================= */
export function getLeaderboard(limit = 20) {
  return db.prepare(`
    SELECT gs.tg_id, gs.wins, gs.losses, gs.score, u.first_name, u.username
    FROM game_scores gs JOIN users u ON u.tg_id = gs.tg_id
    ORDER BY gs.score DESC LIMIT ?
  `).all(limit);
}
export function getMyRank(tgId) {
  const row = db.prepare(`
    SELECT COUNT(*) + 1 AS rank FROM game_scores
    WHERE score > (SELECT COALESCE(score,0) FROM game_scores WHERE tg_id = ?)
  `).get(tgId);
  return row.rank;
}
export function listLeaderboardPrizes() { return db.prepare('SELECT * FROM leaderboard_prizes ORDER BY rank_from ASC').all(); }
export function upsertLeaderboardPrize(p) {
  if (p.id) {
    db.prepare('UPDATE leaderboard_prizes SET rank_from=?, rank_to=?, reward_toman=? WHERE id=?')
      .run(p.rank_from, p.rank_to, p.reward_toman, p.id);
    return p.id;
  }
  return db.prepare('INSERT INTO leaderboard_prizes (rank_from, rank_to, reward_toman) VALUES (?,?,?)')
    .run(p.rank_from, p.rank_to, p.reward_toman).lastInsertRowid;
}
export function deleteLeaderboardPrize(id) { db.prepare('DELETE FROM leaderboard_prizes WHERE id = ?').run(id); }

export function getLeaderboardState() { return db.prepare('SELECT * FROM leaderboard_state WHERE id = 1').get(); }

// جوایز رو بین برترین‌ها پخش می‌کنه و جدول رو صفر می‌کنه — چه دستی چه خودکار صدا زده بشه، امن‌ه
export function resetLeaderboard(notifyFn) {
  const prizes = listLeaderboardPrizes();
  if (prizes.length) {
    const ranked = db.prepare(`
      SELECT gs.tg_id, gs.score, ROW_NUMBER() OVER (ORDER BY gs.score DESC) AS rnk
      FROM game_scores gs WHERE gs.score > 0
    `).all();
    ranked.forEach(r => {
      const prize = prizes.find(p => r.rnk >= p.rank_from && r.rnk <= p.rank_to);
      if (prize && prize.reward_toman > 0) {
        adjustToman(r.tg_id, prize.reward_toman, `جایزه رتبه ${r.rnk} جدول امتیازات`);
        if (typeof notifyFn === 'function') notifyFn(r.tg_id, r.rnk, prize.reward_toman);
      }
    });
  }
  db.prepare('DELETE FROM game_scores').run();
  db.prepare(`UPDATE leaderboard_state SET period_started_at = datetime('now'), last_reset_at = datetime('now') WHERE id = 1`).run();
}

// اگه دوره فعلی تموم شده باشه، خودکار جوایز رو پخش و ریست می‌کنه؛ در غیر این‌صورت کاری نمی‌کنه
export function checkAndAutoResetLeaderboard(notifyFn) {
  const cfg = getGameConfig();
  const state = getLeaderboardState();
  const startedAt = new Date(state.period_started_at.replace(' ', 'T') + 'Z').getTime();
  const dueAt = startedAt + cfg.leaderboard_reset_days * 24 * 60 * 60 * 1000;
  if (Date.now() >= dueAt) resetLeaderboard(notifyFn);
}
