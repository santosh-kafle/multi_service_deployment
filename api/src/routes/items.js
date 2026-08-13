import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { getItems } from '../db.js';
import { cacheGet, cacheSet, cacheDel } from '../cache.js';

const CACHE_KEY = 'items:all';
const router = Router();

const serialize = (doc) => ({
  id: doc._id.toString(),
  title: doc.title,
  done: doc.done,
  createdAt: doc.createdAt,
});

// Cache-aside: try Redis, fall back to Mongo, then backfill the cache.
router.get('/', async (req, res) => {
  const startedAt = process.hrtime.bigint();

  let source = 'cache';
  let items = await cacheGet(CACHE_KEY);

  if (!items) {
    source = 'mongo';
    const docs = await getItems().find().sort({ createdAt: -1 }).limit(100).toArray();
    items = docs.map(serialize);
    await cacheSet(CACHE_KEY, items);
  }

  const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  res.json({ source, latencyMs: Number(latencyMs.toFixed(2)), count: items.length, items });
});

router.post('/', async (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  if (!title) return res.status(400).json({ error: 'title is required' });

  const doc = { title, done: false, createdAt: new Date().toISOString() };
  const { insertedId } = await getItems().insertOne(doc);
  await cacheDel(CACHE_KEY);

  res.status(201).json(serialize({ ...doc, _id: insertedId }));
});

router.patch('/:id', async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'invalid id' });

  const doc = await getItems().findOneAndUpdate(
    { _id: new ObjectId(req.params.id) },
    { $set: { done: Boolean(req.body?.done) } },
    { returnDocument: 'after' },
  );
  if (!doc) return res.status(404).json({ error: 'not found' });

  await cacheDel(CACHE_KEY);
  res.json(serialize(doc));
});

router.delete('/:id', async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'invalid id' });

  const { deletedCount } = await getItems().deleteOne({ _id: new ObjectId(req.params.id) });
  if (!deletedCount) return res.status(404).json({ error: 'not found' });

  await cacheDel(CACHE_KEY);
  res.status(204).end();
});

export default router;
