export const config = {
  port: Number(process.env.PORT ?? 4000),
  mongoUrl: process.env.MONGO_URL ?? 'mongodb://mongo:27017',
  mongoDb: process.env.MONGO_DB ?? 'appdb',
  redisUrl: process.env.REDIS_URL ?? 'redis://redis:6379',
  cacheTtlSeconds: Number(process.env.CACHE_TTL_SECONDS ?? 30),
};
