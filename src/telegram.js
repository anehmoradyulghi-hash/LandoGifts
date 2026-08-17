import crypto from 'crypto';

const API = () => `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;
const TIMEOUT_MS = 8000; // if Telegram does not respond within this time, we stop waiting

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

// Creating a payment invoice link with Telegram Stars (XTR currency) — does not need a provider_token, Telegram handles it itself
export const createStarsInvoiceLink = (title, description, payload, starsAmount) =>
  call('createInvoiceLink', {
    title, description, payload, currency: 'XTR', provider_token: '',
    prices: [{ label: title, amount: starsAmount }],
  });

export const answerPreCheckoutQuery = (id, ok, errorMessage) =>
  call('answerPreCheckoutQuery', { pre_checkout_query_id: id, ok, ...(errorMessage ? { error_message: errorMessage } : {}) });

export const getMe = () => call('getMe', {});

// Channel membership check, for tasks and mandatory join
export async function isChannelMember(channelUsername, userId) {
  if (!channelUsername) return true;
  const data = await call('getChatMember', { chat_id: '@' + channelUsername.replace('@', ''), user_id: userId });
  if (!data.ok || !data.result?.status) return true; // if it was not checked or the response was odd, do not block the user without reason
  return !['left', 'kicked'].includes(data.result.status);
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
    title, image_url: image,
    name: title.replace(/\s*#\d+\s*$/, '').trim(),
    number: numberMatch ? numberMatch[1] : null,
    model: attrs.Model || null, backdrop: attrs.Backdrop || null, symbol: attrs.Symbol || null,
  };
}
