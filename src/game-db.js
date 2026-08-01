import db from './db.js';
import { adjustToman, getUser } from './db.js';
import { getOrCreateUserLeague, pickQueueOpponentInLeague, recordLeagueResult } from './league-db.js';

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
  rarity TEXT NOT NULL DEFAULT 'common', -- common | uncommon | rare | epic | legendary | mythic | god
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

CREATE TABLE IF NOT EXISTS card_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  icon TEXT,
  color TEXT DEFAULT '#8b5cf6',
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- هزینه ادغام (جهش) به ازای هر پله سطح — ادمین کامل قابل تغییره
CREATE TABLE IF NOT EXISTS merge_costs (
  from_level INTEGER PRIMARY KEY,
  cost_toman INTEGER NOT NULL
);
INSERT OR IGNORE INTO merge_costs (from_level, cost_toman) VALUES
  (1,5000), (2,10000), (3,25000), (4,60000), (5,150000), (6,250000);
`);

// ستون‌های جدید رو با ALTER اضافه می‌کنیم (چون دیتابیس ممکنه از قبل ساخته شده باشه)؛
// اگه قبلا اضافه شده باشن، خطای «duplicate column» رو نادیده می‌گیریم — کاملا امن برای اجرای مکرر
function safeAddColumn(table, columnDef) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}
safeAddColumn('game_cards', 'category_id INTEGER');
safeAddColumn('game_cards', "level_images TEXT DEFAULT '[]'"); // آرایه JSON با ۷ لینک عکس، یکی برای هر سطح
safeAddColumn('game_cards', "edition TEXT DEFAULT 'standard'"); // standard | shiny | gold
safeAddColumn('game_cards', 'max_supply INTEGER'); // خالی = نامحدود
safeAddColumn('user_cards', 'bonus_power INTEGER NOT NULL DEFAULT 0'); // از روش «تقویت/قربانی» میاد، سطح رو عوض نمی‌کنه
safeAddColumn('user_cards', 'rolled_power INTEGER'); // قدرت واقعی که موقع ساخت/ارتقای سطح، تصادفی از بازهٔ همون سطح انتخاب شده
safeAddColumn('game_cards', 'instant_level INTEGER'); // اگه ست بشه (مثلا ۷)، هر کارتی که از این تمپلیت ساخته می‌شه از همون سطح شروع می‌شه (کارت ویژه/اختصاصی)
safeAddColumn('game_cards', 'fixed_power INTEGER'); // اگه ست بشه، به‌جای فرمول سطح‌محور، همین قدرت اختصاصی استفاده می‌شه
safeAddColumn('game_cards', 'min_power INTEGER'); // بازهٔ قدرت اختصاصی این کارت (اگه ست بشه، به‌جای بازهٔ کلی سطح استفاده می‌شه)
safeAddColumn('game_cards', 'max_power INTEGER'); // سقف قدرت این کارت — با تقویت/قربانی هم نباید ازش رد بشه

db.exec(`
CREATE TABLE IF NOT EXISTS card_level_power (
  level INTEGER PRIMARY KEY,
  min_power INTEGER NOT NULL,
  max_power INTEGER NOT NULL
);
`);
// بازهٔ پیش‌فرض قدرت هر سطح (اگه ادمین قبلا چیزی ست نکرده باشه) — قابل تغییر کامل از پنل ادمین
const seedLevelPower = db.prepare('INSERT OR IGNORE INTO card_level_power (level, min_power, max_power) VALUES (?,?,?)');
[[1,8,14],[2,14,22],[3,22,32],[4,32,45],[5,45,60],[6,60,80],[7,80,110]].forEach(([lvl,mn,mx]) => seedLevelPower.run(lvl,mn,mx));

export function getCardLevelPowerConfig() {
  return db.prepare('SELECT * FROM card_level_power ORDER BY level ASC').all();
}
export function setCardLevelPower(level, minPower, maxPower) {
  const mn = Number(minPower), mx = Number(maxPower);
  if (mn > mx) throw new Error('حداقل نمی‌تونه از حداکثر بیشتر باشه');
  db.prepare(`
    INSERT INTO card_level_power (level, min_power, max_power) VALUES (?,?,?)
    ON CONFLICT(level) DO UPDATE SET min_power = excluded.min_power, max_power = excluded.max_power
  `).run(level, mn, mx);
}
function rollPowerForLevel(level) {
  const range = db.prepare('SELECT * FROM card_level_power WHERE level = ?').get(level);
  if (!range) return null;
  return Math.round(range.min_power + Math.random() * (range.max_power - range.min_power));
}
// اگه خود کارت بازهٔ قدرت اختصاصی داشته باشه (تنظیم‌شده تو پنل ادمین)، همون رو استفاده می‌کنه؛
// وگرنه از بازهٔ کلی همون سطح استفاده می‌شه
function rollPowerForCard(card, level) {
  if (card && card.min_power != null && card.max_power != null) {
    return Math.round(card.min_power + Math.random() * (card.max_power - card.min_power));
  }
  return rollPowerForLevel(level);
}
// سقف مطلق قدرتی که این کارت (تو این سطح) هیچ‌وقت نباید ازش رد بشه، حتی با تقویت/قربانی
function getPowerCapForCard(card, level) {
  if (card?.max_power != null) return card.max_power;
  const range = db.prepare('SELECT * FROM card_level_power WHERE level = ?').get(level);
  return range ? range.max_power : null;
}

// سیستم سطح‌بندی ثابت ۷ تایی: سطح = ریرتی. هر کارتی که تو دیتابیس max_level متفاوتی داره
// (مثلا از نسخه‌های قبلی) رو یکبار برای همیشه به ۷ اصلاح می‌کنیم تا کل سیستم یکدست بشه
db.prepare('UPDATE game_cards SET max_level = 7 WHERE max_level != 7').run();

// نگاشت ثابت سطح ⇄ ریرتی — این تنها منبع حقیقت برای اسم/رنگ ریرتیه، نه یه فیلد جدا رو کارت
export const LEVEL_RARITY = [
  { level: 1, key: 'common', label: 'معمولی', color: '#9ca3af' },
  { level: 2, key: 'uncommon', label: 'غیرمعمولی', color: '#34d399' },
  { level: 3, key: 'rare', label: 'نادر', color: '#60a5fa' },
  { level: 4, key: 'epic', label: 'حماسی', color: '#a78bfa' },
  { level: 5, key: 'legendary', label: 'افسانه‌ای', color: '#fbbf24' },
  { level: 6, key: 'mythic', label: 'اسطوره‌ای', color: '#fb7185' },
  { level: 7, key: 'god', label: 'الهی', color: '#f472b6' },
];
export function getRarityForLevel(level) {
  const clamped = Math.min(7, Math.max(1, Math.round(level)));
  return LEVEL_RARITY[clamped - 1];
}

db.exec(`
CREATE TABLE IF NOT EXISTS game_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  min_deck_size INTEGER NOT NULL DEFAULT 1,
  max_deck_size INTEGER NOT NULL DEFAULT 5,
  daily_play_limit INTEGER NOT NULL DEFAULT 10,
  extra_play_price_toman INTEGER NOT NULL DEFAULT 5000,
  extra_play_count INTEGER NOT NULL DEFAULT 5,
  leaderboard_reset_days INTEGER NOT NULL DEFAULT 7,
  upgrade_base_cost_toman INTEGER NOT NULL DEFAULT 3000
);
INSERT OR IGNORE INTO game_config (id) VALUES (1);
-- اگه از قبل با مقدار پیش‌فرض قدیمی (۳) ساخته شده، به حداقل جدید (۱) اصلاحش کن؛
-- اگه ادمین خودش دستی چیز دیگه‌ای گذاشته، دست نمی‌زنیم
UPDATE game_config SET min_deck_size = 1 WHERE id = 1 AND min_deck_size = 3;

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

safeAddColumn('game_config', 'sacrifice_fee_toman INTEGER NOT NULL DEFAULT 1000');
safeAddColumn('game_config', 'sacrifice_transfer_percent INTEGER NOT NULL DEFAULT 20');

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
      upgrade_base_cost_toman=@upgrade_base_cost_toman,
      sacrifice_fee_toman=@sacrifice_fee_toman, sacrifice_transfer_percent=@sacrifice_transfer_percent
    WHERE id = 1
  `).run(merged);
}

/* =========================================================================
 * دسته‌بندی کارت‌ها (مثلا «اژدها»، «شوالیه»)
 * ========================================================================= */
export function listCardCategories(onlyActive = false) {
  return onlyActive
    ? db.prepare('SELECT * FROM card_categories WHERE active = 1 ORDER BY id DESC').all()
    : db.prepare('SELECT * FROM card_categories ORDER BY id DESC').all();
}
export function getCardCategory(id) { return db.prepare('SELECT * FROM card_categories WHERE id = ?').get(id); }
export function upsertCardCategory(c) {
  if (c.id) {
    db.prepare(`UPDATE card_categories SET name=?, icon=?, color=?, description=?, active=? WHERE id=?`)
      .run(c.name, c.icon || null, c.color || '#8b5cf6', c.description || null, c.active ? 1 : 0, c.id);
    return c.id;
  }
  return db.prepare(`INSERT INTO card_categories (name, icon, color, description, active) VALUES (?,?,?,?,?)`)
    .run(c.name, c.icon || null, c.color || '#8b5cf6', c.description || null, c.active ? 1 : 0).lastInsertRowid;
}
export function deleteCardCategory(id) { db.prepare('DELETE FROM card_categories WHERE id = ?').run(id); }

/* =========================================================================
 * هزینه ادغام/جهش به ازای هر پله سطح
 * ========================================================================= */
export function listMergeCosts() { return db.prepare('SELECT * FROM merge_costs ORDER BY from_level ASC').all(); }
export function getMergeCost(fromLevel) {
  const row = db.prepare('SELECT cost_toman FROM merge_costs WHERE from_level = ?').get(fromLevel);
  return row ? row.cost_toman : 0;
}
export function upsertMergeCost(fromLevel, costToman) {
  db.prepare(`
    INSERT INTO merge_costs (from_level, cost_toman) VALUES (?, ?)
    ON CONFLICT(from_level) DO UPDATE SET cost_toman = excluded.cost_toman
  `).run(fromLevel, costToman);
}

/* =========================================================================
 * CARDS (admin catalogue)
 * ========================================================================= */
function parseLevelImages(json) {
  try { const arr = JSON.parse(json || '[]'); return Array.isArray(arr) ? arr : []; } catch { return []; }
}
export function getCardImageForLevel(card, level) {
  const images = parseLevelImages(card.level_images);
  return images[level - 1] || card.image_url || null;
}

export function listGameCards(onlyActive = false) {
  return onlyActive
    ? db.prepare('SELECT * FROM game_cards WHERE active = 1 ORDER BY price_toman ASC').all()
    : db.prepare('SELECT * FROM game_cards ORDER BY id DESC').all();
}
export function getGameCard(id) { return db.prepare('SELECT * FROM game_cards WHERE id = ?').get(id); }
export function upsertGameCard(c) {
  const levelImagesJson = JSON.stringify((c.level_images || []).slice(0, 7));
  if (c.id) {
    db.prepare(`
      UPDATE game_cards SET name=?, image_url=?, rarity=?, base_power=?, price_toman=?, max_level=?, active=?,
        category_id=?, level_images=?, edition=?, max_supply=?, instant_level=?, fixed_power=?, min_power=?, max_power=? WHERE id=?
    `).run(c.name, c.image_url || null, c.rarity, c.base_power, c.price_toman, c.max_level, c.active ? 1 : 0,
      c.category_id || null, levelImagesJson, c.edition || 'standard', c.max_supply || null,
      c.instant_level || null, c.fixed_power || null, c.min_power ?? null, c.max_power ?? null, c.id);
    return c.id;
  }
  return db.prepare(`
    INSERT INTO game_cards (name, image_url, rarity, base_power, price_toman, max_level, active, category_id, level_images, edition, max_supply, instant_level, fixed_power, min_power, max_power)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(c.name, c.image_url || null, c.rarity, c.base_power, c.price_toman, c.max_level, c.active ? 1 : 0,
    c.category_id || null, levelImagesJson, c.edition || 'standard', c.max_supply || null,
    c.instant_level || null, c.fixed_power || null, c.min_power ?? null, c.max_power ?? null).lastInsertRowid;
}
export function deleteGameCard(id) { db.prepare('DELETE FROM game_cards WHERE id = ?').run(id); }

export function computeCardPower(basePower, level) {
  return Math.round(basePower * (1 + 0.15 * (level - 1)));
}
function computeTotalPower(row) {
  const base = row.fixed_power != null ? row.fixed_power : (row.rolled_power != null ? row.rolled_power : computeCardPower(row.base_power, row.level));
  return base + (row.bonus_power || 0);
}

// نقطهٔ واحد اضافه‌شدن کارت به کارت‌های یه کاربر — همه‌جا (خرید، جایزهٔ تسک، بتل‌پس، مزایده)
// از همینجا استفاده می‌کنن تا کارت‌های ویژهٔ لول ۷ (instant_level) همه‌جا درست رفتار کنن
export function grantCardInstance(tgId, cardId) {
  const card = getGameCard(cardId);
  const level = card?.instant_level || 1;
  const rolledPower = rollPowerForCard(card, level);
  return db.prepare('INSERT INTO user_cards (tg_id, card_id, level, rolled_power) VALUES (?,?,?,?)').run(tgId, cardId, level, rolledPower).lastInsertRowid;
}

/* =========================================================================
 * USER CARDS — خرید، دیدن مجموعه، دو روش ارتقا (جهش یا تقویت)
 * ========================================================================= */
export function getUserCards(tgId) {
  return db.prepare(`
    SELECT uc.id, uc.card_id, uc.level, uc.bonus_power, uc.rolled_power, uc.created_at,
      c.name, c.image_url, c.level_images, c.base_power, c.max_level, c.category_id, c.edition, c.fixed_power
    FROM user_cards uc JOIN game_cards c ON c.id = uc.card_id
    WHERE uc.tg_id = ? ORDER BY uc.id DESC
  `).all(tgId).map(row => {
    const rarity = getRarityForLevel(row.level);
    return { ...row, power: computeTotalPower(row), image: getCardImageForLevel(row, row.level), rarity_key: rarity.key, rarity_label: rarity.label, rarity_color: rarity.color };
  });
}
export function getUserCard(tgId, userCardId) {
  const row = db.prepare(`
    SELECT uc.*, c.name, c.image_url, c.level_images, c.base_power, c.max_level, c.price_toman, c.category_id, c.edition, c.fixed_power
    FROM user_cards uc JOIN game_cards c ON c.id = uc.card_id
    WHERE uc.id = ? AND uc.tg_id = ?
  `).get(userCardId, tgId);
  if (!row) return null;
  const rarity = getRarityForLevel(row.level);
  return { ...row, power: computeTotalPower(row), image: getCardImageForLevel(row, row.level), rarity_key: rarity.key, rarity_label: rarity.label, rarity_color: rarity.color };
}

export function buyGameCard(tgId, cardId) {
  const card = getGameCard(cardId);
  if (!card || !card.active) throw new Error('این کارت در دسترس نیست');
  if (card.max_supply != null) {
    const sold = db.prepare('SELECT COUNT(*) c FROM user_cards WHERE card_id = ?').get(cardId).c;
    if (sold >= card.max_supply) throw new Error('موجودی این کارت تموم شده');
  }
  const user = getUser(tgId);
  if (!user || user.balance_toman < card.price_toman) throw new Error('موجودی کیف‌پول کافی نیست');
  adjustToman(tgId, -card.price_toman, `خرید کارت «${card.name}»`);
  const id = grantCardInstance(tgId, cardId);
  return id;
}

// روش دوم ارتقا — «تقویت»: یه کارت (هر کارتی، فرقی نداره اسم/سطحش چیه) رو کامل نابود می‌کنی
// تا بخشی از قدرتش (پیش‌فرض ۲۰٪) به یه کارت هدف اضافه بشه. سطح و عکس کارت هدف عوض نمی‌شه،
// فقط عدد قدرتش بالا می‌ره. این کاملا از «جهش» جداست.
export function sacrificeCard(tgId, targetUserCardId, sacrificeUserCardId) {
  if (targetUserCardId === sacrificeUserCardId) throw new Error('نمی‌تونی یه کارت رو با خودش تقویت کنی');
  const target = getUserCard(tgId, targetUserCardId);
  const sac = getUserCard(tgId, sacrificeUserCardId);
  if (!target || !sac) throw new Error('کارت پیدا نشد');

  const cfg = getGameConfig();
  const fee = cfg.sacrifice_fee_toman || 0;
  const user = getUser(tgId);
  if (fee > 0 && (!user || user.balance_toman < fee)) throw new Error(`برای تقویت ${fee.toLocaleString()} تومان لازمه`);

  let transferAmount = Math.round(sac.power * ((cfg.sacrifice_transfer_percent || 20) / 100));
  const targetCard = getGameCard(target.card_id);
  const powerCap = getPowerCapForCard(targetCard, target.level);
  if (powerCap != null) {
    const room = powerCap - target.power;
    if (room <= 0) throw new Error('این کارت به حداکثر قدرت ممکنش رسیده، دیگه قابل تقویت نیست');
    transferAmount = Math.min(transferAmount, room);
  }

  const tx = db.transaction(() => {
    if (fee > 0) adjustToman(tgId, -fee, `هزینه تقویت کارت «${target.name}»`);
    db.prepare('UPDATE user_cards SET bonus_power = bonus_power + ? WHERE id = ?').run(transferAmount, targetUserCardId);
    db.prepare('DELETE FROM user_cards WHERE id = ?').run(sacrificeUserCardId);
  });
  tx();
  return { transferAmount, newPower: target.power + transferAmount, fee };
}

// گروه‌بندی کارت‌های کاملا یکسان (همون کارت، همون سطح) که حداقل دوتاشون هست —
// برای دکمه «جهش»، کاربر چیزی رو دستی انتخاب نمی‌کنه، خودمون جفت‌شون رو پیدا می‌کنیم
export function getMutationGroups(tgId) {
  const rows = db.prepare(`
    SELECT uc.card_id, uc.level, COUNT(*) AS cnt, c.name, c.image_url, c.level_images, c.base_power, c.max_level
    FROM user_cards uc JOIN game_cards c ON c.id = uc.card_id
    WHERE uc.tg_id = ?
    GROUP BY uc.card_id, uc.level
    HAVING cnt >= 2
    ORDER BY c.name ASC
  `).all(tgId);
  return rows.map(r => {
    const rarity = getRarityForLevel(r.level);
    return {
      ...r,
      power: computeCardPower(r.base_power, r.level),
      image: getCardImageForLevel(r, r.level),
      canMutate: r.level < r.max_level,
      mergeCost: getMergeCost(r.level),
      rarity_key: rarity.key, rarity_label: rarity.label, rarity_color: rarity.color,
    };
  });
}

// جهش: دو کارت کاملا یکسان (اسم و سطح) رو خودکار پیدا و با هزینه پله‌ای ادغام می‌کنه؛
// یکی حذف می‌شه و اون یکی یه سطح میره بالا (سطح = ریرتی، پس عکس و برچسب هم خودکار عوض می‌شه)
export function mutateCards(tgId, cardId, level) {
  const rows = db.prepare(`
    SELECT uc.id, uc.level, c.max_level FROM user_cards uc JOIN game_cards c ON c.id = uc.card_id
    WHERE uc.tg_id = ? AND uc.card_id = ? AND uc.level = ?
    ORDER BY uc.id ASC LIMIT 2
  `).all(tgId, cardId, level);
  if (rows.length < 2) throw new Error('برای جهش به دو کارت کاملا یکسان (اسم و سطح) نیاز داری');
  if (rows[0].level >= rows[0].max_level) throw new Error('این کارت به حداکثر سطح (الهی) رسیده');

  const cost = getMergeCost(level);
  const user = getUser(tgId);
  if (cost > 0 && (!user || user.balance_toman < cost)) throw new Error(`برای جهش ${cost.toLocaleString()} تومان لازمه`);

  const card = getGameCard(cardId);
  const keepId = rows[0].id;
  const removeId = rows[1].id;
  const newLevelNum = level + 1;
  const newRolledPower = rollPowerForCard(card, newLevelNum);
  const tx = db.transaction(() => {
    if (cost > 0) adjustToman(tgId, -cost, `هزینه جهش از سطح ${level} به ${level + 1}`);
    const result = db.prepare('UPDATE user_cards SET level = level + 1, rolled_power = ? WHERE id = ?').run(newRolledPower, keepId);
    if (result.changes !== 1) throw new Error('جهش با خطا مواجه شد، دوباره امتحان کن');
    db.prepare('DELETE FROM user_cards WHERE id = ?').run(removeId);
  });
  tx();

  const updated = db.prepare('SELECT level FROM user_cards WHERE id = ?').get(keepId);
  const newRarity = getRarityForLevel(updated.level);
  return { newLevel: updated.level, cost, rarity_key: newRarity.key, rarity_label: newRarity.label };
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
    grantCardInstance(tgId, task.reward_card_id);
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
  const myLeague = getOrCreateUserLeague(tgId).league;

  return db.transaction(() => {
    let opponent = pickQueueOpponentInLeague(myLeague, tgId);
    if (!opponent) opponent = db.prepare('SELECT * FROM game_queue WHERE tg_id != ? ORDER BY joined_at ASC LIMIT 1').get(tgId);
    if (!opponent) {
      db.prepare('INSERT INTO game_queue (tg_id, deck_json, power) VALUES (?,?,?)').run(tgId, JSON.stringify(uniqueIds), power);
      return { matched: false, waiting: true };
    }
    // مسابقه فوری — ترجیحا از همون لیگ خودت، وگرنه از هر جای صف
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
    recordLeagueResult(winner, true);
    recordLeagueResult(loser, false);

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
    SELECT gs.tg_id, gs.wins, gs.losses, gs.score, u.first_name, u.username, av.image_url AS avatar_image
    FROM game_scores gs JOIN users u ON u.tg_id = gs.tg_id
    LEFT JOIN user_rank ur ON ur.tg_id = gs.tg_id
    LEFT JOIN avatars av ON av.id = ur.equipped_avatar_id
    ORDER BY gs.score DESC LIMIT ?
  `).all(limit).map(r => ({ ...r, avatarImage: r.avatar_image || null }));
}
export function getMyRank(tgId) {
  const row = db.prepare(`
    SELECT COUNT(*) + 1 AS rank FROM game_scores
    WHERE score > (SELECT COALESCE(score,0) FROM game_scores WHERE tg_id = ?)
  `).get(tgId);
  return row.rank;
}
// ردیف خود کاربر تو جدول امتیازات (حتی اگه تو ۱۰ نفر برتر نباشه)
export function getUserLeaderboardRow(tgId) {
  const row = db.prepare(`
    SELECT gs.tg_id, gs.wins, gs.losses, gs.score, u.first_name, u.username, av.image_url AS avatar_image
    FROM game_scores gs JOIN users u ON u.tg_id = gs.tg_id
    LEFT JOIN user_rank ur ON ur.tg_id = gs.tg_id
    LEFT JOIN avatars av ON av.id = ur.equipped_avatar_id
    WHERE gs.tg_id = ?
  `).get(tgId);
  return row ? { ...row, avatarImage: row.avatar_image || null } : { tg_id: tgId, wins: 0, losses: 0, score: 0, avatarImage: null };
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
