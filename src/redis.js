// =========================================================================
// REDIS — used for admin session tokens (replaces the old in-memory Map,
// so sessions survive restarts / work across multiple server instances)
// and available as a general-purpose cache for any module that needs one.
// =========================================================================

import { createClient } from 'redis';

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

export const redis = createClient({ url: redisUrl });

redis.on('error', (err) => {
  // Same philosophy as the pg pool: log, don't crash the whole bot over a
  // transient Redis hiccup.
  console.error('Redis client error:', err);
});

let connected = false;
export async function connectRedis() {
  if (connected) return;
  await redis.connect();
  connected = true;
  console.log('Redis connected');
}

export async function closeRedis() {
  if (!connected) return;
  await redis.quit();
  connected = false;
}
