import db from './db.js';
import { adjustToman, getUser } from './db.js';
import { getUserCard } from './game-db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS staking_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  min_stake_days INTEGER NOT NULL DEFAULT 1,
  early_withdrawal_penalty_percent INTEGER NOT NULL DEFAULT 20,
  max_cards_per_user INTEGER NOT NULL DEFAULT 5,
  daily_system_cap INTEGER NOT NULL DEFAULT 0, -- 0 = بدون سقف
  min_card_power INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO staking_config (id) VALUES (1);

-- تومان به‌ازای هر واحد قدرت در ساعت، به تفکیک ریرتی
CREATE TABLE IF NOT EXISTS staking_rarity_rates (
  rarity TEXT PRIMARY KEY,
  toman_per_power_per_hour REAL NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO staking_rarity_rates (rarity, toman_per_power_per_hour) VALUES
  ('common',0.5), ('uncommon',0.8), ('rare',1.2), ('epic',1.8), ('legendary',2.5), ('mythic',3.5), ('god',5);

CREATE TABLE IF NOT EXISTS user_stakes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  user_card_id INTEGER NOT NULL,
  staked_at TEXT NOT NULL DEFAULT (datetime('now')),
  active INTEGER NOT NULL DEFAULT 1
);
`);

export function getStakingConfig() { return db.prepare('SELECT * FROM staking_config WHERE id = 1').get(); }
export function setStakingConfig(c) {
  db.prepare(`
    UPDATE staking_config SET enabled=?, min_stake_days=?, early_withdrawal_penalty_percent=?, max_cards_per_user=?, daily_system_cap=?, min_card_power=?
    WHERE id = 1
  `).run(c.enabled ? 1 : 0, c.min_stake_days, c.early_withdrawal_penalty_percent, c.max_cards_per_user, c.daily_system_cap, c.min_card_power);
}
export function listRarityRates() { return db.prepare('SELECT * FROM staking_rarity_rates ORDER BY rarity').all(); }
export function upsertRarityRate(rarity, rate) {
  db.prepare(`
    INSERT INTO staking_rarity_rates (rarity, toman_per_power_per_hour) VALUES (?, ?)
    ON CONFLICT(rarity) DO UPDATE SET toman_per_power_per_hour = excluded.toman_per_power_per_hour
  `).run(rarity, rate);
}
function getRate(rarity) {
  const row = db.prepare('SELECT toman_per_power_per_hour FROM staking_rarity_rates WHERE rarity = ?').get(rarity);
  return row ? row.toman_per_power_per_hour : 0.5;
}

function computeAccrued(stake, userCard) {
  const hours = (Date.now() - new Date(stake.staked_at.replace(' ', 'T') + 'Z').getTime()) / 3600000;
  const rate = getRate(userCard.rarity);
  return Math.max(0, Math.floor(hours * userCard.power * rate));
}

export function listMyStakes(tgId) {
  const rows = db.prepare(`
    SELECT us.*, uc.card_id, uc.level FROM user_stakes us JOIN user_cards uc ON uc.id = us.user_card_id
    WHERE us.tg_id = ? AND us.active = 1 ORDER BY us.staked_at ASC
  `).all(tgId);
  return rows.map(s => {
    const card = getUserCard(tgId, s.user_card_id);
    const accrued = card ? computeAccrued(s, card) : 0;
    const stakedHours = (Date.now() - new Date(s.staked_at.replace(' ', 'T') + 'Z').getTime()) / 3600000;
    return { ...s, card, accrued, stakedDays: +(stakedHours / 24).toFixed(2) };
  });
}

export function stakeCard(tgId, userCardId) {
  const cfg = getStakingConfig();
  if (!cfg.enabled) throw new Error('استیکینگ فعلا غیرفعاله');
  const card = getUserCard(tgId, userCardId);
  if (!card) throw new Error('این کارت پیدا نشد');
  if (card.power < cfg.min_card_power) throw new Error(`حداقل قدرت لازم برای استیک ${cfg.min_card_power} است`);
  const already = db.prepare('SELECT 1 FROM user_stakes WHERE user_card_id = ? AND active = 1').get(userCardId);
  if (already) throw new Error('این کارت از قبل استیک شده');
  const activeCount = db.prepare('SELECT COUNT(*) c FROM user_stakes WHERE tg_id = ? AND active = 1').get(tgId).c;
  if (activeCount >= cfg.max_cards_per_user) throw new Error(`حداکثر ${cfg.max_cards_per_user} کارت می‌تونی استیک کنی`);
  db.prepare('INSERT INTO user_stakes (tg_id, user_card_id) VALUES (?,?)').run(tgId, userCardId);
}

// برداشت جایزه بدون خارج کردن کارت از فارم — پنالتی نداره چون کارت هنوز استیک مونده
export function harvestStake(tgId, stakeId) {
  const stake = db.prepare('SELECT * FROM user_stakes WHERE id = ? AND tg_id = ? AND active = 1').get(stakeId, tgId);
  if (!stake) throw new Error('این استیک پیدا نشد');
  const card = getUserCard(tgId, stake.user_card_id);
  if (!card) throw new Error('کارت مربوطه پیدا نشد');
  const accrued = computeAccrued(stake, card);
  if (accrued <= 0) throw new Error('هنوز جایزه‌ای جمع نشده');
  const tx = db.transaction(() => {
    adjustToman(tgId, accrued, `برداشت جایزه استیکینگ کارت «${card.name}»`);
    db.prepare(`UPDATE user_stakes SET staked_at = datetime('now') WHERE id = ?`).run(stakeId);
  });
  tx();
  return { accrued };
}

// خارج کردن کامل کارت از فارم — اگه زودتر از حداقل مدت باشه، جریمه می‌خوره
export function unstakeCard(tgId, stakeId) {
  const cfg = getStakingConfig();
  const stake = db.prepare('SELECT * FROM user_stakes WHERE id = ? AND tg_id = ? AND active = 1').get(stakeId, tgId);
  if (!stake) throw new Error('این استیک پیدا نشد');
  const card = getUserCard(tgId, stake.user_card_id);
  if (!card) throw new Error('کارت مربوطه پیدا نشد');
  let accrued = computeAccrued(stake, card);
  const stakedDays = (Date.now() - new Date(stake.staked_at.replace(' ', 'T') + 'Z').getTime()) / (24 * 3600000);
  let penalized = false;
  if (stakedDays < cfg.min_stake_days) {
    accrued = Math.floor(accrued * (1 - cfg.early_withdrawal_penalty_percent / 100));
    penalized = true;
  }
  const tx = db.transaction(() => {
    if (accrued > 0) adjustToman(tgId, accrued, `برداشت از فارم کارت «${card.name}»${penalized ? ' (با جریمه برداشت زودهنگام)' : ''}`);
    db.prepare('UPDATE user_stakes SET active = 0 WHERE id = ?').run(stakeId);
  });
  tx();
  return { accrued, penalized };
}
