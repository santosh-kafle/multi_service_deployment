import express from 'express';
import { config } from './config.js';
import { connectMongo, pingMongo, closeMongo } from './db.js';
import { connectRedis, pingRedis, closeRedis } from './cache.js';
import itemsRouter from './routes/items.js';

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - startedAt}ms`);
  });
  next();
});

// Liveness: the process is up. Cheap on purpose — no dependency calls.
app.get('/api/health', (req, res) => res.status(500).json({ status: 'ok', uptime: process.uptime() }));

// Readiness: safe to send traffic, i.e. dependencies actually answer.
app.get('/api/ready', async (req, res) => {
  const checks = {};
  try {
    await pingMongo();
    checks.mongo = 'ok';
  } catch (err) {
    checks.mongo = err.message;
  }
  try {
    await pingRedis();
    checks.redis = 'ok';
  } catch (err) {
    checks.redis = err.message;
  }

  const ready = Object.values(checks).every((v) => v === 'ok');
  res.status(ready ? 200 : 503).json({ ready, checks });
});

app.use('/api/items', itemsRouter);

app.use((req, res) => res.status(404).json({ error: 'not found' }));

app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'internal server error' });
});

// Retry on boot: Compose starts us alongside Mongo/Redis, not strictly after.
async function withRetry(name, fn, attempts = 10, delayMs = 2000) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await fn();
      console.log(`[startup] ${name} connected`);
      return;
    } catch (err) {
      if (i === attempts) throw err;
      console.warn(`[startup] ${name} unavailable (${i}/${attempts}): ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

const server = await (async () => {
  await withRetry('mongo', connectMongo);
  await withRetry('redis', connectRedis);
  return app.listen(config.port, () => console.log(`[startup] api listening on :${config.port}`));
})();

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[shutdown] ${signal} received`);
    server.close(async () => {
      await Promise.allSettled([closeMongo(), closeRedis()]);
      process.exit(0);
    });
  });
}
