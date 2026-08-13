import { MongoClient } from 'mongodb';
import { config } from './config.js';

const client = new MongoClient(config.mongoUrl, {
  serverSelectionTimeoutMS: 5000,
});

let items;

export async function connectMongo() {
  await client.connect();
  const db = client.db(config.mongoDb);
  items = db.collection('items');
  await items.createIndex({ createdAt: -1 });
  return db;
}

export function getItems() {
  if (!items) throw new Error('Mongo not connected');
  return items;
}

export async function pingMongo() {
  await client.db(config.mongoDb).command({ ping: 1 });
}

export async function closeMongo() {
  await client.close();
}
