import { createClient } from 'redis';
import { config } from './config.js';

const client = createClient({ url: config.redisUrl });

// Without a listener, a dropped connection crashes the process.
client.on('error', (err) => console.error('[redis]', err.message));

export async function connectRedis() {
  await client.connect();
}

export async function cacheGet(key) {
  const raw = await client.get(key);
  return raw ? JSON.parse(raw) : null;
}

export async function cacheSet(key, value) {
  await client.set(key, JSON.stringify(value), { EX: config.cacheTtlSeconds });
}

export async function cacheDel(key) {
  await client.del(key);
}

export async function pingRedis() {
  await client.ping();
}

export async function closeRedis() {
  await client.quit();
}
