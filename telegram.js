import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const API = () => `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;
const TIMEOUT_MS = 8000; // if Telegram does not respond within this time, we stop waiting
// Same directory server.js/admin-api.js already serve at /uploads — reused here so a re-hosted NFT
// gift image is just another file in the one upload folder the app already exposes statically.
const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

async function call(method, payload) {
  try {
    const res = await fetch(`${API()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS), // <- Key point: without this, a slow/unresponsive call to the Telegram API would lock up the whole mini app forever
    });
    const data = await res.json();
    if (!data.ok) console.error(`[telegram:${method}]`, data.description || data);
    return data;
  } catch (e) {
    const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
    console.error(`[telegram:${method}] ${timedOut ? 'timeout (was rejected after 8 seconds)' : 'network error'}`, e.message);
    return { ok: false, error: e.message, timedOut };
  }
}

export const sendMessage = (chatId, text, extra = {}) =>
  call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });

export const sendPhoto = (chatId, photoUrl, caption, extra = {}) =>
  call('sendPhoto', { chat_id: chatId, photo: photoUrl, caption, parse_mode: 'HTML', ...extra });

export const answerCallbackQuery = (id, text) =>
  call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });

export const setWebhook = (url, secretToken) =>
  call('setWebhook', { url, secret_token: secretToken, allowed_updates: ['message', 'callback_query', 'pre_checkout_query'] });

export const editMessageText = (chatId, messageId, text, extra = {}) =>
  call('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...extra });

export const pinChatMessage = (chatId, messageId, disableNotification = true) =>
  call('pinChatMessage', { chat_id: chatId, message_id: messageId, disable_notification: disableNotification });

// Creates (and Telegram will keep reusing/renewing) an invite link for a channel — needed for the
// mandatory-join button when the channel is configured by numeric ID (private channel, no public
// @username to build a t.me/... link from).
export const createChatInviteLink = (chatId, name) =>
  call('createChatInviteLink', { chat_id: chatId, ...(name ? { name } : {}) });

// Creating a payment invoice link with Telegram Stars (XTR currency) — does not need a provider_token, Telegram handles it itself
export const createStarsInvoiceLink = (title, description, payload, starsAmount) =>
  call('createInvoiceLink', {
    title, description, payload, currency: 'XTR', provider_token: '',
    prices: [{ label: title, amount: starsAmount }],
  });

export const answerPreCheckoutQuery = (id, ok, errorMessage) =>
  call('answerPreCheckoutQuery', { pre_checkout_query_id: id, ok, ...(errorMessage ? { error_message: errorMessage } : {}) });

export const getMe = () => call('getMe', {});

// Turns whatever an admin might have pasted into "Channel ID or @username" (a bare username, an
// @username, a full t.me link, or a numeric -100... channel ID) into the chat_id format Telegram's
// API actually expects. Previously this always force-prefixed "@", which silently broke mandatory
// join / the isChannelMember check whenever the admin used a numeric channel ID (needed for private
// channels, which have no public @username at all) — every check would then fail, and because
// isChannelMember fails open (see below), the join requirement was quietly never enforced.
function normalizeChatId(raw) {
  let v = String(raw || '').trim();
  if (!v) return null;
  v = v.replace(/^https?:\/\/t\.me\//i, '').replace(/^t\.me\//i, '');
  if (/^-?\d+$/.test(v)) return v; // already a numeric chat id, e.g. -1001234567890
  return '@' + v.replace(/^@/, '');
}

// Caches recent membership check results for a short time so mandatory-join isn't re-verified with
// Telegram on every single mini-app request (requireTelegramAuth checks it on every /api/* call) —
// without this, an active user's normal browsing could fire dozens of getChatMember calls a minute,
// adding latency to every request and risking Telegram rate-limiting the bot token, which in turn
// would slow down or delay everything else the bot does, including replying to /start.
const MEMBERSHIP_CACHE_TTL_MS = 3 * 60 * 1000;
const membershipCache = new Map(); // `${chatId}:${userId}` -> { joined, expiresAt }

export function clearChannelMemberCache(userId) {
  for (const key of membershipCache.keys()) {
    if (key.endsWith(`:${userId}`)) membershipCache.delete(key);
  }
}

// Channel membership check, for tasks and mandatory join.
let lastConfigWarningAt = 0;
export async function isChannelMember(channelSetting, userId) {
  const chatId = normalizeChatId(channelSetting);
  if (!chatId) return true; // nothing configured -> nothing to enforce

  const cacheKey = `${chatId}:${userId}`;
  const cached = membershipCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.joined;

  const data = await call('getChatMember', { chat_id: chatId, user_id: userId });
  if (!data.ok || !data.result?.status) {
    const reason = data.description || data.error || 'unknown error';
    // "chat not found" / "not enough rights" mean the required channel is misconfigured (wrong ID,
    // or the bot was never added there as admin) rather than a transient Telegram hiccup — that's a
    // real, ongoing bug worth surfacing loudly instead of silently waving every user through.
    const isConfigProblem = /chat not found|not enough rights|CHAT_ADMIN_REQUIRED|not.*administrator|user not found/i.test(reason);
    if (isConfigProblem && Date.now() - lastConfigWarningAt > 10 * 60 * 1000) {
      lastConfigWarningAt = Date.now();
      console.error(
        `[isChannelMember] Mandatory-join channel "${channelSetting}" (resolved to ${chatId}) is misconfigured: ${reason}. ` +
        `The bot must be an admin of that channel, and numeric IDs must include the -100 prefix. ` +
        `Until this is fixed, the join requirement is NOT being enforced for anyone.`
      );
    } else if (!isConfigProblem) {
      console.error(`[isChannelMember] check failed (${reason}) — treating as joined so a Telegram hiccup does not lock everyone out`);
    }
    return true; // do not block the user without reason (transient error or misconfiguration — see log above)
  }
  const joined = !['left', 'kicked'].includes(data.result.status);
  membershipCache.set(cacheKey, { joined, expiresAt: Date.now() + MEMBERSHIP_CACHE_TTL_MS });
  return joined;
}

// Mini app initData validation per Telegram's official docs
// Any odd/tampered input does not throw; it just returns null so the request
// gets rejected with a clean 401, not a 500 from this function crashing
export function validateInitData(initData, botToken) {
  try {
    if (!initData || !botToken) return null;
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (computedHash !== hash) return null;

    const authDate = Number(params.get('auth_date')) * 1000;
    if (!authDate || Date.now() - authDate > 24 * 60 * 60 * 1000) return null;

    const userJson = params.get('user');
    if (!userJson) return null;
    return JSON.parse(userJson);
  } catch (e) {
    console.error('[validateInitData] was malformed or tampered with, rejected:', e.message);
    return null;
  }
}

/* ---------- Telegram NFT gift lookup ----------
 * Given a t.me/nft/<Name>-<number> link, fetches Telegram's own public preview page for that gift
 * (the same page Telegram serves for link previews everywhere) and reads its image/name/number/
 * attributes out of the standard Open Graph meta tags. No bot token or special API access needed —
 * it's a plain HTTP GET of a public page, same as any browser opening that link would do. Shared by
 * the admin panel (products, raffle prizes) and the public mini app (gift market listings). */
export async function fetchTelegramNftMeta(link) {
  let url = String(link || '').trim();
  const tgSchemeMatch = url.match(/tg:\/\/nft\?slug=([\w-]+)/i);
  if (tgSchemeMatch) url = `https://t.me/nft/${tgSchemeMatch[1]}`;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  if (!/^https:\/\/t\.me\/nft\/[\w-]+\/?(\?.*)?$/i.test(url)) {
    throw new Error('This does not look like a Telegram NFT gift link (should look like t.me/nft/Name-123)');
  }

  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LandoGiftsBot/1.0)' } });
  } catch (e) {
    throw new Error('Could not reach Telegram — check the server has internet access');
  }
  if (!res.ok) throw new Error('Telegram did not return this gift page — check the link is correct');
  const html = await res.text();

  const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const getMeta = (prop) => {
    const m = html.match(new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i'))
      || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${prop}["']`, 'i'));
    return m ? decode(m[1]) : null;
  };

  const title = getMeta('og:title');
  const image = getMeta('og:image');
  const description = getMeta('og:description') || '';
  if (!title || !image) throw new Error("Could not read this gift's info from Telegram (wrong link, or the gift page didn't load)");

  const numberMatch = title.match(/#(\d+)/);
  const attrs = {};
  description.split('\n').forEach(line => {
    const idx = line.indexOf(':');
    if (idx > 0) attrs[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  });

  return {
    title, image_url: await rehostImage(image),
    name: title.replace(/\s*#\d+\s*$/, '').trim(),
    number: numberMatch ? numberMatch[1] : null,
    model: attrs.Model || null, backdrop: attrs.Backdrop || null, symbol: attrs.Symbol || null,
  };
}

// Root cause of gift images sometimes not showing in the market: the raw og:image URL Telegram's
// t.me/nft/... preview page returns is served from Telegram's own CDN, which is not guaranteed to
// stay hotlink-able from an arbitrary origin indefinitely (referrer checks, cache eviction, etc.) —
// so an image that loaded fine right after listing could silently break later for buyers. Instead of
// storing that URL directly, we download the bytes once, right when the listing is created, and
// re-host them under our own /uploads/ (the same static folder every other uploaded image in the
// app already uses) — from then on the listing depends on nothing but our own server. If the
// download itself fails for any reason, we fall back to the original Telegram URL rather than
// blocking the whole listing on an image-hosting hiccup.
async function rehostImage(sourceUrl) {
  try {
    const res = await fetch(sourceUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return sourceUrl;
    const contentType = res.headers.get('content-type') || '';
    const extFromType = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[contentType.split(';')[0].trim()];
    const ext = extFromType || (path.extname(new URL(sourceUrl).pathname) || '.jpg');
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length) return sourceUrl;
    const filename = `nft-${crypto.randomBytes(12).toString('hex')}${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);
    return `/uploads/${filename}`;
  } catch (e) {
    console.error('[fetchTelegramNftMeta] could not re-host image, falling back to the original URL', e.message || e);
    return sourceUrl;
  }
}
