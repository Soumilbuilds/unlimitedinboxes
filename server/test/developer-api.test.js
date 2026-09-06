import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

import {
  canonicalJson,
  normalizeDomain,
  normalizeNames,
  normalizeRedirect,
  orderStage,
  validateCreatePayload,
  validMailboxPassword,
} from '../services/developerApiValidation.js';
import { unlimitedInboxesOpenApi } from '../services/openapi.js';

process.env.APP_DB_PATH = join(mkdtempSync(join(tmpdir(), 'unlimited-inboxes-api-test-')), 'app.db');
const legacyDb = new Database(process.env.APP_DB_PATH);
legacyDb.exec(`
  CREATE TABLE api_keys (id INTEGER PRIMARY KEY, api_key TEXT);
  CREATE TABLE orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    user_id INTEGER,
    order_name TEXT,
    status TEXT DEFAULT 'pending',
    progress INTEGER DEFAULT 0,
    total_mailboxes INTEGER DEFAULT 100,
    mailbox_password TEXT,
    mailbox_names TEXT,
    created_mailboxes TEXT DEFAULT '[]',
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
legacyDb.close();
const database = await import('../db/database.js');
const developerApi = await import('../services/developerApi.js');

const paidAccess = { canUseCustomNames: true, canUseDomainRedirects: true };

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

test('idempotency canonicalizes object keys without changing array order', () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
  assert.notEqual(canonicalJson({ names: ['A', 'B'] }), canonicalJson({ names: ['B', 'A'] }));
});

test('developer API accepts the complete random-name order payload', () => {
  const input = validateCreatePayload({
    order_name: 'Client Batch',
    domain: 'Example.COM',
    tenant: {
      email: 'admin@company.onmicrosoft.com',
      password: 'TenantPassword!',
      mfa_secret: 'JBSWY3DPEHPK3PXP',
    },
    mailboxes: {
      quantity: 100,
      password: 'MailboxPassword123!',
      naming: { mode: 'random' },
    },
    redirect: { enabled: true, url: 'destination.example' },
  }, paidAccess);

  assert.equal(input.domain, 'example.com');
  assert.equal(input.quantity, 100);
  assert.equal(input.naming.names, null);
  assert.equal(input.redirectUrl, 'https://destination.example/');
});

test('trial API orders reject paid naming and redirect features', () => {
  const trialAccess = { canUseCustomNames: false, canUseDomainRedirects: false };
  const base = {
    order_name: 'Trial Batch',
    domain: 'trial.example.com',
    tenant: {
      email: 'admin@trial.onmicrosoft.com',
      password: 'TenantPassword!',
      mfa_secret: 'JBSWY3DPEHPK3PXP',
    },
    mailboxes: {
      quantity: 2,
      password: 'MailboxPassword123!',
      naming: { mode: 'random' },
    },
    redirect: { enabled: false },
  };

  assert.throws(
    () => validateCreatePayload({
      ...base,
      mailboxes: { ...base.mailboxes, naming: { mode: 'custom', names: ['Taylor Morgan', 'Jordan Lee'] } },
    }, trialAccess),
    (error) => error.code === 'CUSTOM_NAMES_NOT_AVAILABLE',
  );
  assert.throws(
    () => validateCreatePayload({ ...base, redirect: { enabled: true, url: 'destination.example' } }, trialAccess),
    (error) => error.code === 'REDIRECTS_NOT_AVAILABLE',
  );
});

test('custom names must exactly match the requested mailbox quantity', () => {
  assert.throws(
    () => normalizeNames({ mode: 'custom', names: ['Taylor Morgan'] }, 2),
    (error) => error.code === 'INVALID_CUSTOM_NAMES',
  );
  assert.deepEqual(
    normalizeNames({ mode: 'custom', names: [{ first_name: 'Taylor', last_name: 'Morgan' }] }, 1).names,
    ['Taylor Morgan'],
  );
});

test('redirect validation rejects loops and embedded credentials', () => {
  assert.throws(() => normalizeRedirect('https://example.com/path', 'example.com'), (error) => error.code === 'REDIRECT_LOOP');
  assert.throws(() => normalizeRedirect('https://user:pass@other.example', 'example.com'));
});

test('domain and Microsoft password validation match the public contract', () => {
  assert.equal(normalizeDomain('https://Mail.Example.com/'), 'mail.example.com');
  assert.throws(() => normalizeDomain('localhost'));
  assert.equal(validMailboxPassword('Password123!'), true);
  assert.equal(validMailboxPassword('alllowercase'), false);
});

test('order stages expose the registrar gate before provisioning', () => {
  assert.equal(orderStage({ status: 'pending' }, { accepted: false }), 'awaiting_nameservers');
  assert.equal(orderStage({ status: 'pending' }, { accepted: true }), 'ready_to_start');
  assert.equal(orderStage({ status: 'processing' }), 'provisioning');
  assert.equal(orderStage({ status: 'completed' }), 'completed');
});

test('OpenAPI publishes the complete supported lifecycle and marks tenant secrets write-only', () => {
  const paths = unlimitedInboxesOpenApi.paths;
  for (const path of [
    '/v1/account',
    '/v1/orders',
    '/v1/orders/{order_id}',
    '/v1/orders/{order_id}/nameservers/prepare',
    '/v1/orders/{order_id}/nameservers',
    '/v1/orders/{order_id}/start',
    '/v1/orders/{order_id}/download',
  ]) assert.ok(paths[path], `Missing ${path}`);
  const tenant = unlimitedInboxesOpenApi.components.schemas.CreateOrderRequest.properties.tenant;
  assert.equal(tenant.properties.password.writeOnly, true);
  assert.equal(tenant.properties.mfa_secret.writeOnly, true);
});

test('API keys are one-time secrets with hash-at-rest authentication and revocation', () => {
  const userResult = database.createUser('api-key@example.com', 'hash', 'salt', 'basic');
  const issued = developerApi.issueDeveloperApiKey(Number(userResult.lastInsertRowid), 'Production');
  assert.match(issued.secret, /^ui_live_[A-Za-z0-9_-]{40,}$/);
  assert.equal(issued.key.name, 'Production');
  assert.equal(database.listDeveloperApiKeys(Number(userResult.lastInsertRowid))[0].secret_hash, undefined);
  assert.equal(developerApi.authenticateDeveloperApiKey(`Bearer ${issued.secret}`).user.email, 'api-key@example.com');
  database.revokeDeveloperApiKey(issued.key.id, Number(userResult.lastInsertRowid));
  assert.equal(developerApi.authenticateDeveloperApiKey(`Bearer ${issued.secret}`), null);
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
