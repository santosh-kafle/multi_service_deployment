import { useCallback, useEffect, useState } from 'react';

// Relative URL on purpose: Nginx proxies /api to the API service, so the
// frontend needs no per-environment API host baked in at build time.
const API = '/api';

async function request(path, options) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

export default function App() {
  const [items, setItems] = useState([]);
  const [meta, setMeta] = useState(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState(null);
  const [ready, setReady] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await request('/items');
      setItems(data.items);
      setMeta({ source: data.source, latencyMs: data.latencyMs });
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
    request('/ready')
      .then(setReady)
      .catch(() => setReady({ ready: false, checks: { api: 'unreachable' } }));
  }, [load]);

  async function addItem(event) {
    event.preventDefault();
    if (!title.trim()) return;
    try {
      await request('/items', { method: 'POST', body: JSON.stringify({ title }) });
      setTitle('');
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleItem(item) {
    await request(`/items/${item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ done: !item.done }),
    });
    await load();
  }

  async function deleteItem(item) {
    await request(`/items/${item.id}`, { method: 'DELETE' });
    await load();
  }

  return (
    <main>
      <header>
        <h1>Multi-Service Deployment</h1>
        <p className="subtitle">React &rarr; Nginx &rarr; Express &rarr; MongoDB + Redis</p>
      </header>

      <section className="status">
        {meta && (
          <span className={`badge ${meta.source}`}>
            {meta.source === 'cache' ? 'Redis HIT' : 'Mongo read'} &middot; {meta.latencyMs}ms
          </span>
        )}
        {ready && (
          <span className={`badge ${ready.ready ? 'ok' : 'down'}`}>
            {ready.ready ? 'all services ready' : 'degraded'}
          </span>
        )}
        <button type="button" className="ghost" onClick={load}>
          Refresh
        </button>
      </section>

      <p className="hint">
        Reads are cached in Redis for 30s. Refresh twice to see the source flip to a cache hit; any
        write invalidates the key.
      </p>

      <form onSubmit={addItem}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Add an item&hellip;"
          aria-label="Item title"
        />
        <button type="submit">Add</button>
      </form>

      {error && <p className="error">{error}</p>}

      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <label>
              <input type="checkbox" checked={item.done} onChange={() => toggleItem(item)} />
              <span className={item.done ? 'done' : undefined}>{item.title}</span>
            </label>
            <button type="button" className="ghost" onClick={() => deleteItem(item)}>
              Delete
            </button>
          </li>
        ))}
        {!items.length && !error && <li className="empty">No items yet.</li>}
      </ul>
    </main>
  );
}
