import db from './db.js';
import { adjustToman, getUser } from './db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS gift_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 1,
  toman_gift_fee_percent INTEGER NOT NULL DEFAULT 2
);
INSERT OR IGNORE INTO gift_config (id) VALUES (1);
`);

// The "gift a card to another user" feature was removed — it had no frontend UI and was never
// actually reachable in the bot. Drop its leftover table/columns so nothing remains of it.
try { db.exec('DROP TABLE IF EXISTS card_gifts_log'); } catch (e) {}
try {
  const cols = db.prepare("PRAGMA table_info(gift_config)").all().map(c => c.name);
  if (cols.includes('card_gift_min_referrals')) {
    db.exec(`
      CREATE TABLE gift_config_new (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 1,
        toman_gift_fee_percent INTEGER NOT NULL DEFAULT 2
      );
      INSERT INTO gift_config_new (id, enabled, toman_gift_fee_percent)
        SELECT id, enabled, toman_gift_fee_percent FROM gift_config;
      DROP TABLE gift_config;
      ALTER TABLE gift_config_new RENAME TO gift_config;
    `);
  }
} catch (e) { console.error('[gift-db] card gift column cleanup', e); }

export function getGiftConfig() { return db.prepare('SELECT * FROM gift_config WHERE id = 1').get(); }
export function setGiftConfig(c) {
  db.prepare(`UPDATE gift_config SET enabled=?, toman_gift_fee_percent=? WHERE id = 1`)
    .run(c.enabled ? 1 : 0, c.toman_gift_fee_percent);
}

function findReceiver(usernameOrId) {
  const raw = String(usernameOrId || '').trim().replace(/^@/, '');
  if (/^\d+$/.test(raw)) return getUser(Number(raw));
  return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(raw);
}

export function giftToman(senderTgId, receiverInput, amount) {
  const cfg = getGiftConfig();
  if (!cfg.enabled) throw new Error('The gift system is currently disabled');
  if (!amount || amount <= 0) throw new Error('Invalid amount');
  const receiver = findReceiver(receiverInput);
  if (!receiver) throw new Error('Recipient user not found — they must have already opened the bot');
  if (receiver.tg_id === senderTgId) throw new Error('You cannot gift yourself');
  const sender = getUser(senderTgId);
  if (!sender || sender.balance_toman < amount) throw new Error('Insufficient balance');

  const fee = round2((amount * cfg.toman_gift_fee_percent) / 100);
  const receiverGets = round2(amount - fee);
  const tx = db.transaction(() => {
    adjustToman(senderTgId, -amount, `LNDC gift to ${receiver.first_name || receiver.tg_id}`);
    adjustToman(receiver.tg_id, receiverGets, `LNDC gift from ${sender.first_name || sender.tg_id}`);
  });
  tx();
  return { receiverGets, fee, receiverTgId: receiver.tg_id, receiverName: receiver.first_name };
}

// Rounds to 2 decimal places (the bot's currency precision) instead of truncating to a whole
// number, so small gift amounts/fees are not silently zeroed out or under/over-charged.
function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
