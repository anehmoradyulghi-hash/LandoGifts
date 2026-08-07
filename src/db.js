import db from './db-core.js';
import crypto from 'crypto';

/* =========================================================================
 * SCHEMA
 * Table creation lives in migrations/ now (see migrations/001_init.sql and
 * onward) instead of being run inline at import time — see MIGRATIONS.md
 * for how to apply them.
 * Everything is designed to be manual: the admin sets currency prices from the panel, no request
 * No network calls are made to any exchange or pricing API. Deposit/withdrawal also require approval
 * done manually by the admin, not automatic.
 * ========================================================================= */

async function safeAddColumn(table, columnDef) {
  // Postgres supports IF NOT EXISTS natively, so no need for the
  // try/catch-"duplicate column" dance better-sqlite3 needed.
  await db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${columnDef}`);
}

// A few default currencies (inactive until the admin manually sets their rate)
async function seedDefaultCurrencies() {
  const seed = await db.prepare(`
    INSERT INTO currencies (code, name, rate_toman, min_deposit, min_withdraw, active)
    VALUES (?,?,?,?,?,0) ON CONFLICT (code) DO NOTHING
  `);
  await seed.run('USDT', 'USDT', 0, 1, 1);
  await seed.run('TON', 'TON Coin', 0, 0.1, 0.1);
}
seedDefaultCurrencies().catch(err => console.error('Failed to seed default currencies:', err));

export async function createStarPaymentRequest(tgId, starsAmount, rateToman) {
  const tomanCredited = Math.round(starsAmount * rateToman);
  return (await db.prepare('INSERT INTO star_payments (tg_id, stars_amount, rate_toman, toman_credited) VALUES (?,?,?,?)')
    .run(tgId, starsAmount, rateToman, tomanCredited)).lastInsertRowid;
}
export async function getStarPayment(id) { return await db.prepare('SELECT * FROM star_payments WHERE id = ?').get(id); }
// tops up instantly — as soon as Telegram sends payment confirmation
export async function completeStarPayment(id, telegramChargeId) {
  const sp = await getStarPayment(id);
  if (!sp || sp.status === 'paid') return null; // Safe against duplicate messages from Telegram
  const tx = db.transaction(async () => {
    await db.prepare(`UPDATE star_payments SET status='paid', telegram_charge_id=?, paid_at=now_text() WHERE id=?`).run(telegramChargeId, id);
    await adjustToman(sp.tg_id, sp.toman_credited, `Account top-up with Telegram Stars (${sp.stars_amount}⭐)`);
  });
  await tx();
  return sp;
}

export async function listGiftCategories(onlyActive = false) {
  return onlyActive
    ? await db.prepare('SELECT * FROM gift_categories WHERE active = 1 ORDER BY name ASC').all()
    : await db.prepare('SELECT * FROM gift_categories ORDER BY id DESC').all();
}
export async function upsertGiftCategory(c) {
  if (c.id) {
    await db.prepare('UPDATE gift_categories SET name=?, image_url=?, active=? WHERE id=?')
      .run(c.name, c.image_url || null, c.active ? 1 : 0, c.id);
    return c.id;
  }
  return (await db.prepare('INSERT INTO gift_categories (name, image_url, active) VALUES (?,?,?)')
    .run(c.name, c.image_url || null, c.active === false ? 0 : 1)).lastInsertRowid;
}
export async function deleteGiftCategory(id) { await db.prepare('DELETE FROM gift_categories WHERE id = ?').run(id); }

/* =========================================================================
 * USERS
 * ========================================================================= */
async function makeRefCode() {
  // We retry a few times to make sure the referral code isn't a duplicate (very unlikely but not zero)
  for (let i = 0; i < 5; i++) {
    const code = 'L' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const exists = await db.prepare('SELECT 1 FROM users WHERE ref_code = ?').get(code);
    if (!exists) return code;
  }
  return 'L' + crypto.randomBytes(8).toString('hex').toUpperCase(); // fallback, collisions are practically impossible
}

export async function getUser(tgId) {
  return await db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tgId);
}

export async function getOrCreateUser(tgUser, startParam) {
  if (!tgUser?.id) throw new Error('Invalid Telegram user data');
  let user = await getUser(tgUser.id);
  if (user) {
    await db.prepare(`UPDATE users SET username = ?, first_name = ?, last_seen_at = now_text() WHERE tg_id = ?`)
      .run(tgUser.username || null, tgUser.first_name || null, tgUser.id);
    return await getUser(tgUser.id);
  }

  let referredBy = null;
  if (startParam && startParam.startsWith('ref_')) {
    const refCode = startParam.slice(4);
    const referrer = await db.prepare('SELECT tg_id FROM users WHERE ref_code = ?').get(refCode);
    if (referrer && referrer.tg_id !== tgUser.id) referredBy = referrer.tg_id;
  }

  try {
    await db.prepare(`INSERT INTO users (tg_id, username, first_name, ref_code, referred_by) VALUES (?,?,?,?,?)`)
      .run(tgUser.id, tgUser.username || null, tgUser.first_name || null, await makeRefCode(), referredBy);
  } catch (e) {
    // If two simultaneous requests come from the same new user (very unlikely but possible), return the existing record instead of crashing
    const existing = await getUser(tgUser.id);
    if (existing) return existing;
    throw e;
  }
  if (referredBy) await payReferralSignupBonus(referredBy, tgUser.id);
  return await getUser(tgUser.id);
}

export async function isBanned(tgId) {
  const u = await getUser(tgId);
  return { banned: !!u?.is_banned, reason: u?.ban_reason || null };
}
export async function banUser(tgId, reason) {
  await db.prepare(`UPDATE users SET is_banned = 1, ban_reason = ? WHERE tg_id = ?`).run(reason || null, tgId);
}
export async function unbanUser(tgId) {
  await db.prepare(`UPDATE users SET is_banned = 0, ban_reason = NULL WHERE tg_id = ?`).run(tgId);
}

export async function listUsers(search) {
  if (search) {
    const like = `%${search}%`;
    return await db.prepare(`
      SELECT u.*, COALESCE(us.purchased_premium, 0) AS has_battlepass FROM users u
      LEFT JOIN user_season us ON us.tg_id = u.tg_id
      WHERE CAST(u.tg_id AS TEXT) LIKE ? OR u.username LIKE ? OR u.first_name LIKE ?
      ORDER BY u.created_at DESC LIMIT 100
    `).all(like, like, like);
  }
  return await db.prepare(`
    SELECT u.*, COALESCE(us.purchased_premium, 0) AS has_battlepass FROM users u
    LEFT JOIN user_season us ON us.tg_id = u.tg_id
    ORDER BY u.created_at DESC LIMIT 100
  `).all();
}

/* =========================================================================
 * LEDGER + LNDC BALANCE
 * ========================================================================= */
async function logLedger(tgId, currencyCode, direction, amount, reason) {
  await db.prepare(`INSERT INTO ledger (tg_id, currency_code, direction, amount, reason) VALUES (?,?,?,?,?)`)
    .run(tgId, currencyCode, direction, amount, reason || null);
}

export async function adjustToman(tgId, amount, reason) {
  await db.prepare(`UPDATE users SET balance_toman = balance_toman + ? WHERE tg_id = ?`).run(amount, tgId);
  await logLedger(tgId, 'LNDC', amount >= 0 ? 'in' : 'out', Math.abs(amount), reason);
}

export async function getLedger(tgId, limit = 15, offset = 0) {
  const rows = await db.prepare('SELECT * FROM ledger WHERE tg_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(tgId, limit, offset);
  const total = (await db.prepare('SELECT COUNT(*) c FROM ledger WHERE tg_id = ?').get(tgId)).c;
  return { rows, total, hasMore: offset + rows.length < total };
}

export async function payReferralBonus(tgId, purchaseAmountToman, percent) {
  const user = await getUser(tgId);
  if (!user?.referred_by || !percent) return;
  const bonus = Math.floor((purchaseAmountToman * percent) / 100);
  if (bonus <= 0) return;
  await adjustToman(user.referred_by, bonus, `Referral commission from user purchase ${tgId}`);
}

// Referral settings — fully changeable from the admin panel (no longer just .env)
export async function getReferralSettings() {
  return {
    percent: Number(await getSetting('referral_percent', process.env.REFERRAL_PERCENT || '5')),
    signupBonus: Number(await getSetting('referral_signup_bonus', '0')),
  };
}
export async function setReferralSettings({ percent, signupBonus }) {
  await setSetting('referral_percent', String(Number(percent) || 0));
  await setSetting('referral_signup_bonus', String(Number(signupBonus) || 0));
}
// One-time flat referral reward — given to the inviter the moment a new user opens the app via the invite link
export async function payReferralSignupBonus(referrerTgId, newUserTgId) {
  const bonus = await getReferralSettings().signupBonus;
  if (!bonus || bonus <= 0) return;
  await adjustToman(referrerTgId, bonus, `New member invite reward (${newUserTgId})`);
}

export async function getReferralInfo(tgId) {
  const invited = await db.prepare('SELECT tg_id, username, first_name, created_at FROM users WHERE referred_by = ? ORDER BY created_at DESC').all(tgId);
  const totalEarned = (await db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE tg_id = ? AND direction = 'in' AND reason LIKE 'Commission%'`).get(tgId)).s;
  return { invited, invitedCount: invited.length, totalEarned };
}

/* =========================================================================
 * CURRENCIES (manual — admin sets everything)
 * ========================================================================= */
export async function listCurrencies(onlyActive = false) {
  return onlyActive
    ? await db.prepare('SELECT * FROM currencies WHERE active = 1').all()
    : await db.prepare('SELECT * FROM currencies').all();
}
export async function getCurrency(code) {
  return await db.prepare('SELECT * FROM currencies WHERE code = ?').get(code);
}
export async function upsertCurrency({ code, name, rate_toman, min_deposit, min_withdraw, active, deposit_address }) {
  const activeInt = active ? 1 : 0;
  const dep = deposit_address || null;
  await db.prepare(`
    INSERT INTO currencies (code, name, rate_toman, min_deposit, min_withdraw, active, deposit_address, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, now_text())
    ON CONFLICT(code) DO UPDATE SET
      name = ?, rate_toman = ?, min_deposit = ?,
      min_withdraw = ?, active = ?, deposit_address = ?, updated_at = now_text()
  `).run(
    code, name, rate_toman, min_deposit, min_withdraw, activeInt, dep,
    name, rate_toman, min_deposit, min_withdraw, activeInt, dep,
  );
}

export async function getCurrencyBalance(tgId, code) {
  const row = await db.prepare('SELECT amount FROM wallet_balances WHERE tg_id = ? AND currency_code = ?').get(tgId, code);
  return row?.amount || 0;
}
export async function adjustCurrencyBalance(tgId, code, amount, reason) {
  await db.prepare(`
    INSERT INTO wallet_balances (tg_id, currency_code, amount) VALUES (?,?,?)
    ON CONFLICT(tg_id, currency_code) DO UPDATE SET amount = amount + excluded.amount
  `).run(tgId, code, amount);
  await logLedger(tgId, code, amount >= 0 ? 'in' : 'out', Math.abs(amount), reason);
}
export async function getWalletBalances(tgId) {
  const rows = await db.prepare('SELECT currency_code, amount FROM wallet_balances WHERE tg_id = ?').all(tgId);
  const map = {};
  rows.forEach(r => { map[r.currency_code] = r.amount; });
  return map;
}

/* ---- manual toman top-up (card-to-card) ---- */
export async function createTomanTopup(tgId, amount, trackingCode) {
  const info = await db.prepare(`INSERT INTO toman_topups (tg_id, amount, tracking_code) VALUES (?,?,?)`).run(tgId, amount, trackingCode);
  return info.lastInsertRowid;
}
export async function getTomanTopup(id) { return await db.prepare('SELECT * FROM toman_topups WHERE id = ?').get(id); }
export async function decideTomanTopup(id, approve) {
  const row = await getTomanTopup(id);
  if (!row || row.status !== 'pending') return null;
  await db.prepare(`UPDATE toman_topups SET status = ?, decided_at = now_text() WHERE id = ?`)
    .run(approve ? 'approved' : 'rejected', id);
  if (approve) await adjustToman(row.tg_id, row.amount, 'Wallet top-up (card-to-card, approved)');
  return row;
}
export async function listPendingTomanTopups() {
  return await db.prepare(`SELECT * FROM toman_topups WHERE status = 'pending' ORDER BY created_at ASC`).all();
}

/* ---- manual toman withdraw ---- */
export async function createTomanWithdrawal(tgId, amount, cardNumber) {
  const info = await db.prepare(`INSERT INTO toman_withdrawals (tg_id, amount, card_number) VALUES (?,?,?)`).run(tgId, amount, cardNumber);
  return info.lastInsertRowid;
}
export async function getTomanWithdrawal(id) { return await db.prepare('SELECT * FROM toman_withdrawals WHERE id = ?').get(id); }
export async function decideTomanWithdrawal(id, approve) {
  const row = await getTomanWithdrawal(id);
  if (!row || row.status !== 'pending') return null;
  await db.prepare(`UPDATE toman_withdrawals SET status = ?, decided_at = now_text() WHERE id = ?`)
    .run(approve ? 'approved' : 'rejected', id);
  if (!approve) await adjustToman(row.tg_id, row.amount, 'Refund for rejected withdrawal'); // the blocked amount is returned on request
  return row;
}
export async function listPendingTomanWithdrawals() {
  return await db.prepare(`SELECT * FROM toman_withdrawals WHERE status = 'pending' ORDER BY created_at ASC`).all();
}

/* ---- manual currency deposit / withdraw ---- */
export async function createCurrencyRequest(tgId, code, kind, amount, opts = {}) {
  const info = await db.prepare(`
    INSERT INTO currency_requests (tg_id, currency_code, kind, amount, tx_hash, address) VALUES (?,?,?,?,?,?)
  `).run(tgId, code, kind, amount, opts.txHash || null, opts.address || null);
  return info.lastInsertRowid;
}
export async function getCurrencyRequest(id) { return await db.prepare('SELECT * FROM currency_requests WHERE id = ?').get(id); }
export async function decideCurrencyRequest(id, approve) {
  const row = await getCurrencyRequest(id);
  if (!row || row.status !== 'pending') return null;
  await db.prepare(`UPDATE currency_requests SET status = ?, decided_at = now_text() WHERE id = ?`)
    .run(approve ? 'approved' : 'rejected', id);
  if (row.kind === 'deposit' && approve) {
    await adjustCurrencyBalance(row.tg_id, row.currency_code, row.amount, `${row.currency_code} deposit approved`);
  }
  if (row.kind === 'withdraw' && !approve) {
    await adjustCurrencyBalance(row.tg_id, row.currency_code, row.amount, 'Refund of rejected withdrawal'); // the blocked amount is returned
  }
  return row;
}
export async function listPendingCurrencyRequests() {
  return await db.prepare(`SELECT * FROM currency_requests WHERE status = 'pending' ORDER BY created_at ASC`).all();
}

/* =========================================================================
 * PRODUCTS / CATEGORIES / ORDERS
 * ========================================================================= */
export async function listCategories() { return await db.prepare('SELECT * FROM categories ORDER BY id').all(); }
export async function addCategory(title) { return (await db.prepare('INSERT INTO categories (title) VALUES (?)').run(title)).lastInsertRowid; }
export async function deleteCategory(id) { await db.prepare('DELETE FROM categories WHERE id = ?').run(id); }

export async function listProducts(onlyActive = true) {
  return onlyActive
    ? await db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY id DESC').all()
    : await db.prepare('SELECT * FROM products ORDER BY id DESC').all();
}
export async function getProduct(id) { return await db.prepare('SELECT * FROM products WHERE id = ?').get(id); }
export async function upsertProduct(p) {
  if (p.id) {
    await db.prepare(`UPDATE products SET title=?, description=?, image_url=?, price_toman=?, category_id=?, active=? WHERE id=?`)
      .run(p.title, p.description || null, p.image_url || null, p.price_toman, p.category_id || null, p.active ? 1 : 0, p.id);
    return p.id;
  }
  return (await db.prepare(`INSERT INTO products (title, description, image_url, price_toman, category_id, active) VALUES (?,?,?,?,?,?)`)
    .run(p.title, p.description || null, p.image_url || null, p.price_toman, p.category_id || null, p.active ? 1 : 0)).lastInsertRowid;
}
export async function deleteProduct(id) { await db.prepare('DELETE FROM products WHERE id = ?').run(id); }

export async function createOrder(tgId, productId, qty, totalToman, note) {
  return (await db.prepare(`INSERT INTO orders (tg_id, product_id, qty, total_toman, note) VALUES (?,?,?,?,?)`)
    .run(tgId, productId, qty, totalToman, note || null)).lastInsertRowid;
}
export async function listOrdersForUser(tgId) {
  return await db.prepare('SELECT o.*, p.title AS product_title FROM orders o JOIN products p ON p.id = o.product_id WHERE o.tg_id = ? ORDER BY o.created_at DESC').all(tgId);
}
export async function listAllOrders() {
  return await db.prepare('SELECT o.*, p.title AS product_title FROM orders o JOIN products p ON p.id = o.product_id ORDER BY o.created_at DESC LIMIT 200').all();
}
export async function setOrderStatus(id, status) { await db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id); }

/* =========================================================================
 * GIFT MARKET — Consignment market for real gifts between users
 * ========================================================================= */
export async function createGiftOffer(sellerTgId, title, imageUrl, priceToman, serialNumber, link) {
  // If the admin has defined categories, the listing title must be exactly one of them (not free text)
  const categories = await listGiftCategories(true);
  if (categories.length && !categories.some(c => c.name === title)) {
    throw new Error('This category is not valid — pick one of the existing categories');
  }
  // New listings must first be approved by the admin before showing up in the market
  return (await db.prepare(`INSERT INTO gift_offers (seller_tg_id, title, image_url, price_toman, serial_number, link, status) VALUES (?,?,?,?,?,?,'pending')`)
    .run(sellerTgId, title, imageUrl || null, priceToman, serialNumber || null, link || null)).lastInsertRowid;
}
export async function getGiftOffer(id) { return await db.prepare('SELECT * FROM gift_offers WHERE id = ?').get(id); }
export async function listMyGiftOffers(tgId) {
  return await db.prepare('SELECT * FROM gift_offers WHERE seller_tg_id = ? OR buyer_tg_id = ? ORDER BY created_at DESC').all(tgId, tgId);
}
export async function listMarketGiftOffers(excludeTgId) {
  return await db.prepare(`SELECT * FROM gift_offers WHERE status = 'active' AND seller_tg_id != ? ORDER BY created_at DESC`).all(excludeTgId);
}
export async function cancelGiftOffer(tgId, id) {
  const offer = await getGiftOffer(id);
  if (!offer || offer.seller_tg_id !== tgId) throw new Error('This listing does not belong to you');
  if (offer.status !== 'active' && offer.status !== 'pending') throw new Error('This listing can no longer be cancelled');
  await db.prepare(`UPDATE gift_offers SET status = 'cancelled' WHERE id = ?`).run(id);
}
// Listing edited by seller — needs re-approval after editing
export async function updateGiftOffer(tgId, id, { title, image_url, price_toman, serial_number, link }) {
  const offer = await getGiftOffer(id);
  if (!offer || offer.seller_tg_id !== tgId) throw new Error('This listing does not belong to you');
  if (offer.status !== 'active' && offer.status !== 'pending') throw new Error('This listing cannot be edited in its current state');
  const categories = await listGiftCategories(true);
  if (categories.length && !categories.some(c => c.name === title)) {
    throw new Error('This category is not valid — pick one of the existing categories');
  }
  await db.prepare(`
    UPDATE gift_offers SET title=?, image_url=?, price_toman=?, serial_number=?, link=?, status='pending' WHERE id=?
  `).run(title, image_url || null, price_toman, serial_number || null, link || null, id);
}
export async function reserveGiftOffer(buyerTgId, id) {
  const offer = await getGiftOffer(id);
  if (!offer || offer.status !== 'active') throw new Error('This listing is not available');
  if (offer.seller_tg_id === buyerTgId) throw new Error('You cannot buy your own listing');
  const buyer = await getUser(buyerTgId);
  if (buyer.balance_toman < offer.price_toman) throw new Error('Insufficient wallet balance');

  await adjustToman(buyerTgId, -offer.price_toman, `Reserved purchase of gift "${offer.title}" (consignment)`);
  await db.prepare(`UPDATE gift_offers SET status = 'reserved', buyer_tg_id = ?, reserved_at = now_text() WHERE id = ?`)
    .run(buyerTgId, id);
  return await getGiftOffer(id);
}
export async function confirmGiftReceived(buyerTgId, id, feePercent) {
  const offer = await getGiftOffer(id);
  if (!offer || offer.status !== 'reserved' || offer.buyer_tg_id !== buyerTgId) throw new Error('This listing cannot be approved');
  const fee = Math.floor((offer.price_toman * feePercent) / 100);
  const sellerReceives = offer.price_toman - fee;
  await adjustToman(offer.seller_tg_id, sellerReceives, `Sale of gift "${offer.title}" (consignment, after buyer confirmation)`);
  await db.prepare(`UPDATE gift_offers SET status = 'completed', completed_at = now_text() WHERE id = ?`).run(id);
  return { ...offer, sellerReceives };
}
export async function listAllGiftOffersAdmin() {
  return await db.prepare('SELECT * FROM gift_offers ORDER BY created_at DESC LIMIT 200').all();
}
export async function listPendingGiftOffers() {
  return await db.prepare(`SELECT * FROM gift_offers WHERE status = 'pending' ORDER BY created_at ASC`).all();
}
export async function approveGiftOffer(id) {
  const offer = await getGiftOffer(id);
  if (!offer || offer.status !== 'pending') throw new Error('This listing is not pending approval');
  await db.prepare(`UPDATE gift_offers SET status = 'active' WHERE id = ?`).run(id);
}
export async function rejectGiftOffer(id) {
  const offer = await getGiftOffer(id);
  if (!offer || offer.status !== 'pending') throw new Error('This listing is not pending approval');
  await db.prepare(`UPDATE gift_offers SET status = 'cancelled' WHERE id = ?`).run(id);
}
// Listing fully removed by admin (in any state) — if it was reserved, the money is refunded to the buyer
export async function adminDeleteGiftOffer(id) {
  const offer = await getGiftOffer(id);
  if (!offer) throw new Error('Listing not found');
  if (offer.status === 'reserved') {
    await adjustToman(offer.buyer_tg_id, offer.price_toman, `Listing removed by admin — refund «${offer.title}»`);
  }
  await db.prepare('DELETE FROM gift_offers WHERE id = ?').run(id);
}
// For admin dispute resolution: refunding the buyer (e.g. the gift never arrived)
export async function adminRefundGiftOffer(id) {
  const offer = await getGiftOffer(id);
  if (!offer || offer.status !== 'reserved') throw new Error('This listing is not reserved');
  await adjustToman(offer.buyer_tg_id, offer.price_toman, `Refund by support — gift «${offer.title}»`);
  await db.prepare(`UPDATE gift_offers SET status = 'cancelled' WHERE id = ?`).run(id);
}

/* =========================================================================
 * TASKS
 * ========================================================================= */
export async function listActiveTasks() { return await db.prepare('SELECT * FROM tasks WHERE active = 1 ORDER BY id DESC').all(); }
export async function listAllTasksAdmin() { return await db.prepare('SELECT * FROM tasks ORDER BY id DESC').all(); }
export async function getTask(id) { return await db.prepare('SELECT * FROM tasks WHERE id = ?').get(id); }
export async function upsertTask(t) {
  if (t.id) {
    await db.prepare(`UPDATE tasks SET title=?, kind=?, channel_username=?, reward_toman=?, active=? WHERE id=?`)
      .run(t.title, t.kind, t.channel_username || null, t.reward_toman, t.active ? 1 : 0, t.id);
    return t.id;
  }
  return (await db.prepare(`INSERT INTO tasks (title, kind, channel_username, reward_toman, active) VALUES (?,?,?,?,?)`)
    .run(t.title, t.kind, t.channel_username || null, t.reward_toman, t.active ? 1 : 0)).lastInsertRowid;
}
export async function deleteTask(id) { await db.prepare('DELETE FROM tasks WHERE id = ?').run(id); }
export async function hasClaimedTask(tgId, taskId) { return !!await db.prepare('SELECT 1 FROM task_claims WHERE tg_id = ? AND task_id = ?').get(tgId, taskId); }
export async function claimTask(tgId, task) {
  await db.prepare('INSERT INTO task_claims (tg_id, task_id) VALUES (?,?)').run(tgId, task.id);
  if (task.reward_toman > 0) await adjustToman(tgId, task.reward_toman, `Task completion reward: ${task.title}`);
}

/* =========================================================================
 * SUPPORT TICKETS
 * ========================================================================= */
export async function getOrCreateOpenTicket(tgId) {
  let ticket = await db.prepare(`SELECT * FROM tickets WHERE tg_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1`).get(tgId);
  if (!ticket) {
    const id = (await db.prepare('INSERT INTO tickets (tg_id) VALUES (?)').run(tgId)).lastInsertRowid;
    ticket = await db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
  }
  return ticket;
}
export async function addTicketMessage(ticketId, sender, body, imageUrl) {
  await db.prepare('INSERT INTO ticket_messages (ticket_id, sender, body, image_url) VALUES (?,?,?,?)').run(ticketId, sender, body || null, imageUrl || null);
}
export async function listTicketMessages(ticketId) {
  return await db.prepare('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC').all(ticketId);
}
export async function listMyTickets(tgId) { return await db.prepare('SELECT * FROM tickets WHERE tg_id = ? ORDER BY created_at DESC').all(tgId); }
export async function listAllTicketsAdmin() {
  return await db.prepare(`
    SELECT t.*, u.first_name, u.username,
      (SELECT body FROM ticket_messages m WHERE m.ticket_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_message
    FROM tickets t JOIN users u ON u.tg_id = t.tg_id
    ORDER BY t.created_at DESC LIMIT 100
  `).all();
}
export async function getTicket(id) { return await db.prepare('SELECT * FROM tickets WHERE id = ?').get(id); }
export async function closeTicket(id) { await db.prepare(`UPDATE tickets SET status = 'closed' WHERE id = ?`).run(id); }

/* =========================================================================
 * SETTINGS — Simple values the admin changes from the panel (e.g. the deposit card number)
 * ========================================================================= */
export async function getSetting(key, fallback = null) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
export async function setSetting(key, value) {
  await db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}
export async function getPaymentSettings() {
  return {
    cardNumber: await getSetting('card_number', process.env.ADMIN_CARD_NUMBER || ''),
    cardOwner: await getSetting('card_owner', process.env.ADMIN_CARD_OWNER || ''),
    zarinpalMerchantId: await getSetting('zarinpal_merchant_id', process.env.ZARINPAL_MERCHANT_ID || ''),
  };
}
export async function setPaymentSettings({ cardNumber, cardOwner, zarinpalMerchantId }) {
  await setSetting('card_number', cardNumber || '');
  await setSetting('card_owner', cardOwner || '');
  await setSetting('zarinpal_merchant_id', zarinpalMerchantId || '');
}

// The Telegram ID/username the user's support button links directly to (instead of an internal ticket)
export async function getSupportContact() {
  return await getSetting('support_username', process.env.SUPPORT_USERNAME || '');
}
export async function setSupportContact(username) {
  await setSetting('support_username', (username || '').replace(/^@/, ''));
}

// Info page text (guide/FAQ/rules) — editable from the admin panel
export async function getInfoPage(key) { return await getSetting('info_' + key, ''); }
export async function setInfoPage(key, content) { await setSetting('info_' + key, content || ''); }

const DEFAULT_WELCOME = 'Welcome to <b>Lando Gifts</b> 🎁\nUse the button below to open the shop:';
const DEFAULT_JOIN_PROMPT = 'To use the bot, first join our channel:';
export async function getMessageSettings() {
  return {
    welcomeMessage: await getSetting('welcome_message', DEFAULT_WELCOME),
    joinPromptMessage: await getSetting('join_prompt_message', DEFAULT_JOIN_PROMPT),
  };
}
export async function setMessageSettings({ welcomeMessage, joinPromptMessage }) {
  await setSetting('welcome_message', welcomeMessage || DEFAULT_WELCOME);
  await setSetting('join_prompt_message', joinPromptMessage || DEFAULT_JOIN_PROMPT);
}

/* ---- Zarinpal: record the payment request so it can be tracked at confirmation in the callback ---- */
export async function createZarinpalPayment(authority, tgId, amount) {
  await db.prepare('INSERT INTO zarinpal_payments (authority, tg_id, amount) VALUES (?,?,?)').run(authority, tgId, amount);
}
export async function getZarinpalPayment(authority) {
  return await db.prepare('SELECT * FROM zarinpal_payments WHERE authority = ?').get(authority);
}
export async function markZarinpalPaymentStatus(authority, status) {
  await db.prepare('UPDATE zarinpal_payments SET status = ? WHERE authority = ?').run(status, authority);
}

/* =========================================================================
 * DASHBOARD STATS
 * ========================================================================= */
export async function getStats() {
  const users = (await db.prepare('SELECT COUNT(*) c FROM users').get()).c;
  const orders = (await db.prepare('SELECT COUNT(*) c FROM orders').get()).c;
  const totalToman = (await db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE currency_code='LNDC' AND direction='in'`).get()).s;
  const pendingTopups = (await db.prepare(`SELECT COUNT(*) c FROM toman_topups WHERE status='pending'`).get()).c;
  const pendingCurrency = (await db.prepare(`SELECT COUNT(*) c FROM currency_requests WHERE status='pending'`).get()).c;
  const openTickets = (await db.prepare(`SELECT COUNT(*) c FROM tickets WHERE status='open'`).get()).c;
  return { users, orders, totalToman, pendingTopups, pendingCurrency, openTickets };
}

export async function getAllUserIds() {
  return (await db.prepare('SELECT tg_id FROM users').all()).map(r => r.tg_id);
}

export default db;
