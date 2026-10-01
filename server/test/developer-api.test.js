import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import express from 'express';

// This file tests the deployed /api contract. The previous tests imported
// abandoned /v1 modules that are absent from both Git and the live release.
const directory = mkdtempSync(join(tmpdir(), 'unlimited-inboxes-api-test-'));
process.env.APP_DB_PATH = join(directory, 'app.db');
const legacyDb = new Database(process.env.APP_DB_PATH);
legacyDb.exec(`
  CREATE TABLE api_keys (id INTEGER PRIMARY KEY, api_key TEXT);
  CREATE TABLE orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, user_id INTEGER,
    order_name TEXT, status TEXT DEFAULT 'pending', progress INTEGER DEFAULT 0,
    total_mailboxes INTEGER DEFAULT 100, mailbox_password TEXT, mailbox_names TEXT,
    created_mailboxes TEXT DEFAULT '[]', error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
legacyDb.close();
const database = await import('../db/database.js');
const { hashApiKey, validateApiKey } = await import('../services/apiKey.js');
const { default: apiRouter } = await import('../routes/api.js');
const { default: keyRouter } = await import('../routes/apiKeys.js');
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const user = database.getUserById(Number(req.headers['x-test-user']));
  req.session = { user, authenticated: Boolean(user) };
  next();
});
app.use('/api/keys', keyRouter);
app.use('/api', apiRouter);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  database.default.close();
  rmSync(directory, { recursive: true, force: true });
});
async function request(method, path, { userId, key, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(userId ? { 'x-test-user': String(userId) } : {}), ...(key ? { 'x-api-key': key } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
function user(email, plan = 'basic') {
  const id = Number(database.createUser(email, 'hash', 'salt', plan).lastInsertRowid);
  database.default.prepare("UPDATE users SET xpay_subscription_status = 'ACTIVE' WHERE id = ?").run(id);
  return id;
}
async function issueKey(userId) {
  const result = await request('POST', '/api/keys', { userId });
  assert.equal(result.status, 201);
  assert.match(result.body.rawKey, /^[a-f0-9]{64}$/);
  return result.body.rawKey;
}
test('fresh schema removes the retired API key table', () => {
  const legacyTable = database.default.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'api_keys'").get();
  assert.equal(legacyTable, undefined);
});

test('legacy order schemas gain an independent planned mailbox checkpoint', () => {
  const columns = database.default.prepare('PRAGMA table_info(orders)').all();
  assert.ok(columns.some(column => column.name === 'planned_mailboxes'));
});

test('order execution leases reject duplicate workers and allow explicit release', () => {
  const db = database.default;
  const user = db.prepare(`
    INSERT INTO users (email, password_hash, password_salt, plan)
    VALUES ('lease-test@example.com', 'hash', 'salt', 'basic')
  `).run();
  const tenant = db.prepare(`
    INSERT INTO tenants (user_id, name, domain, admin_email, admin_password)
    VALUES (?, 'Lease Test', 'lease-test.example.com', 'admin@lease-test.example.com', 'secret')
  `).run(user.lastInsertRowid);
  const order = db.prepare(`
    INSERT INTO orders (tenant_id, user_id, status, total_mailboxes, mailbox_password)
    VALUES (?, ?, 'pending', 2, 'MailboxPassword123!')
  `).run(tenant.lastInsertRowid, user.lastInsertRowid);

  assert.deepEqual(database.claimOrderForProcessing({
    orderId: order.lastInsertRowid,
    userId: user.lastInsertRowid,
    maxConcurrentOrders: 1,
  }), { claimed: true, reason: null });
  assert.equal(database.acquireOrderProcessingLease(order.lastInsertRowid, 'worker-a'), true);
  assert.equal(database.acquireOrderProcessingLease(order.lastInsertRowid, 'worker-b'), false);
  assert.equal(database.touchOrderProcessingLease(order.lastInsertRowid, 'worker-a').changes, 1);
  assert.equal(database.releaseOrderProcessingLease(order.lastInsertRowid, 'worker-a').changes, 1);
  assert.equal(database.acquireOrderProcessingLease(order.lastInsertRowid, 'worker-b'), true);
  db.prepare(`
    UPDATE orders SET processing_heartbeat_at = datetime('now', '-2 minutes') WHERE id = ?
  `).run(order.lastInsertRowid);
  assert.equal(database.acquireOrderProcessingLease(order.lastInsertRowid, 'worker-c', 60), true);
  assert.equal(database.touchOrderProcessingLease(order.lastInsertRowid, 'worker-b').changes, 0);
});

test('mailbox checkpoints are persisted independently from progress updates', () => {
  const row = database.default.prepare("SELECT id FROM orders WHERE status = 'processing' ORDER BY id DESC LIMIT 1").get();
  const checkpoint = [{ name: 'Taylor Morgan', email: 'taylormorgan@lease-test.example.com', objectId: 'object-1' }];
  database.persistCreatedMailboxes(row.id, checkpoint);
  const stored = database.default.prepare('SELECT created_mailboxes FROM orders WHERE id = ?').get(row.id);
  assert.deepEqual(JSON.parse(stored.created_mailboxes), checkpoint);
});

test('mailbox identity plans are immutable once the first worker persists them', () => {
  const row = database.default.prepare("SELECT id FROM orders WHERE status = 'processing' ORDER BY id DESC LIMIT 1").get();
  const firstPlan = [
    { fullName: 'Taylor Morgan', alias: 'taylormorgan' },
    { fullName: 'Jordan Lee', alias: 'jordanlee' },
  ];
  const competingPlan = [
    { fullName: 'Different Person', alias: 'differentperson' },
    { fullName: 'Another Person', alias: 'anotherperson' },
  ];
  assert.deepEqual(database.getOrPersistPlannedMailboxes(row.id, firstPlan), firstPlan);
  assert.deepEqual(database.getOrPersistPlannedMailboxes(row.id, competingPlan), firstPlan);
  const stored = database.default.prepare('SELECT mailbox_names, planned_mailboxes FROM orders WHERE id = ?').get(row.id);
  assert.equal(stored.mailbox_names, null);
  assert.deepEqual(JSON.parse(stored.planned_mailboxes), firstPlan);
});


test('deployed API keys are one-time secrets with hash-at-rest authentication and revocation', async () => {
  const userId = user('api-key@example.com');
  const key = await issueKey(userId);
  const stored = database.default.prepare('SELECT * FROM developer_api_keys WHERE user_id = ?').get(userId);
  assert.equal(stored.secret_hash, hashApiKey(key));
  assert.ok(!JSON.stringify(stored).includes(key));
  assert.equal(database.listDeveloperApiKeys(userId)[0].secret_hash, undefined);
  assert.equal((await validateApiKey(key)).id, userId);
  const summary = await request('GET', '/api/keys', { userId });
  assert.equal(summary.body.hasKey, true);
  assert.ok(!JSON.stringify(summary.body).includes(key));
  assert.equal((await request('DELETE', '/api/keys', { userId })).status, 200);
  assert.equal(await validateApiKey(key), null);
  assert.equal((await request('GET', '/api/orders', { key })).status, 401);
});

test('deployed API rejects missing, invalid and revoked credentials', async () => {
  assert.equal((await request('GET', '/api/orders')).status, 401);
  assert.equal((await request('GET', '/api/orders', { key: 'synthetic-invalid-key' })).status, 401);
  assert.equal((await request('POST', '/api/keys')).status, 401);
});

test('deployed API validates tenant credentials, MFA, mailbox password and quantity before provisioning', async () => {
  const userId = user('validation@example.com');
  const key = await issueKey(userId);
  const body = {
    tenant_domain: 'validation.example.com', admin_email: 'admin@validation.onmicrosoft.com',
    admin_password: 'SyntheticTenantPassword!', mfa_secret: 'JBSWY3DPEHPK3PXP',
    mailbox_password: 'SyntheticPassword123!', total_mailboxes: 2,
  };
  for (const field of ['tenant_domain', 'admin_email', 'admin_password', 'mfa_secret', 'mailbox_password']) {
    const invalid = { ...body }; delete invalid[field];
    const result = await request('POST', '/api/orders', { key, body: invalid });
    assert.equal(result.status, 400, field);
    assert.match(result.body.error, new RegExp(field));
  }
  for (const invalid of [
    { mfa_secret: 'invalid-characters!' }, { mailbox_password: 'alllowercase' },
    { total_mailboxes: -1 }, { total_mailboxes: 501 },
  ]) assert.equal((await request('POST', '/api/orders', { key, body: { ...body, ...invalid } })).status, 400);
  assert.equal(database.getOrders(userId).length, 0);
});

test('deployed API rejects unpaid users and trial API provisioning before side effects', async () => {
  const payload = {
    tenant_domain: 'gated.example.com', admin_email: 'admin@gated.onmicrosoft.com',
    admin_password: 'SyntheticTenantPassword!', mfa_secret: 'JBSWY3DPEHPK3PXP',
    mailbox_password: 'SyntheticPassword123!', total_mailboxes: 2,
  };
  const freeId = user('free-api@example.com', 'free');
  database.default.prepare("UPDATE users SET xpay_subscription_status = NULL WHERE id = ?").run(freeId);
  const freeKey = await issueKey(freeId);
  const blocked = await request('POST', '/api/orders', { key: freeKey, body: payload });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'BILLING_REQUIRED');
  const trialId = user('trial-api@example.com', 'trial');
  database.default.prepare("UPDATE users SET xpay_subscription_status = 'TRIALING', xpay_trial_ends_at = datetime('now', '+5 days') WHERE id = ?").run(trialId);
  const trialKey = await issueKey(trialId);
  const trial = await request('POST', '/api/orders', { key: trialKey, body: payload });
  assert.equal(trial.status, 403);
  assert.equal(trial.body.code, 'API_NOT_AVAILABLE');
  assert.equal(database.getOrders(freeId).length, 0);
  assert.equal(database.getOrders(trialId).length, 0);
});

test('deployed API keys cannot read another user order or credentials', async () => {
  const owner = user('owner-api@example.com');
  const other = user('other-api@example.com');
  const tenantId = database.createTenant({ user_id: owner, name: 'Owned', domain: 'owned.example.com', admin_email: 'admin@owned.onmicrosoft.com', admin_password: 'SyntheticTenantPassword!' }).lastInsertRowid;
  const orderId = database.createOrderWithinQuota({ tenantId, totalMailboxes: 1, mailboxPassword: 'SyntheticPassword123!', userId: owner, inboxesLimit: 100 });
  const key = await issueKey(other);
  assert.deepEqual((await request('GET', '/api/orders', { key })).body, []);
  for (const path of [`/api/orders/${orderId}`, '/api/orders/by-domain/owned.example.com', '/api/orders/by-domain/owned.example.com/download']) {
    const result = await request('GET', path, { key });
    assert.equal(result.status, 404, path);
    assert.ok(!JSON.stringify(result.body).includes('SyntheticPassword'));
  }
  assert.equal((await request('POST', `/api/orders/${orderId}/start`, { key })).status, 404);
});

test('dashboard and API orders share one transactional inbox allowance', () => {
  const userId = Number(database.createUser('quota@example.com', 'hash', 'salt', 'basic').lastInsertRowid);
  const tenantId = Number(database.createTenant({
    user_id: userId,
    name: 'Quota',
    domain: 'quota.example.com',
    admin_email: 'admin@quota.onmicrosoft.com',
    admin_password: 'TenantPassword!',
    mfa_secret: 'JBSWY3DPEHPK3PXP',
  }).lastInsertRowid);
  const first = database.createOrderWithinQuota({ tenantId, totalMailboxes: 60, mailboxPassword: 'Password123!', orderName: 'First', userId, inboxesLimit: 100 });
  database.createOrderWithinQuota({ tenantId, totalMailboxes: 40, mailboxPassword: 'Password123!', orderName: 'Second', userId, inboxesLimit: 100 });
  assert.throws(
    () => database.createOrderWithinQuota({ tenantId, totalMailboxes: 1, mailboxPassword: 'Password123!', orderName: 'Too Many', userId, inboxesLimit: 100 }),
    (error) => error.code === 'INBOX_LIMIT_REACHED' && error.remaining === 0,
  );
  database.updateOrderProgress(first, 100, Array.from({ length: 60 }, (_, i) => ({ email: `inbox${i}@quota.example.com`, password: 'Password123!' })));
  database.updateOrderStatus(first, 'completed');
  database.deleteOrder(first);
  assert.equal(database.getReservedInboxCount(userId), 100);
});
