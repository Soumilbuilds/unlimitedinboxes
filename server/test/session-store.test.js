import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { SQLiteSessionStore } from '../services/sessionStore.js';

function invoke(store, method, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (error, value) => (error ? reject(error) : resolve(value)));
  });
}

test('SQLite sessions survive store recreation and can be destroyed', async () => {
  const db = new Database(':memory:');
  const firstStore = new SQLiteSessionStore(db);
  const value = {
    authenticated: true,
    user: { id: 42, email: 'member@example.com' },
    cookie: { expires: new Date(Date.now() + 60_000).toISOString() },
  };

  await invoke(firstStore, 'set', 'session-42', value);

  const recreatedStore = new SQLiteSessionStore(db);
  assert.deepEqual(await invoke(recreatedStore, 'get', 'session-42'), value);

  await invoke(recreatedStore, 'destroy', 'session-42');
  assert.equal(await invoke(recreatedStore, 'get', 'session-42'), null);
  db.close();
});

test('SQLite sessions reject expired records', async () => {
  const db = new Database(':memory:');
  const store = new SQLiteSessionStore(db);
  await invoke(store, 'set', 'expired-session', {
    cookie: { expires: new Date(Date.now() - 1_000).toISOString() },
  });

  assert.equal(await invoke(store, 'get', 'expired-session'), null);
  db.close();
});
