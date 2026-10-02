import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import express from 'express';
import session from 'express-session';
import Database from 'better-sqlite3';
import { createSmtpRouter } from '../routes/smtp.js';
import { buildSmtpCsv } from '../services/smtpCsv.js';
import { createSmtpDnsService } from '../services/smtpDns.js';
import { smtpError } from '../services/smtpValidation.js';

// Dynamic imports ensure schema initialization never touches the application database.
process.env.APP_DB_PATH = ':memory:';
const { default: schemaDb } = await import('../db/database.js');
const { createSmtpRepository } = await import('../db/smtp.js');
const { createSmtpProcessor } = await import('../services/smtpOrderProcessor.js');
after(() => schemaDb.close());
const schema = schemaDb.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END").all();
const PRIVATE = 'RAW_PRIVATE_BODY /opt/stalwart/secrets/values re_private_secret';
const NS = ['one.ns.example.test', 'two.ns.example.test'];
const defer = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture(t, options = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const { sql } of schema) db.exec(sql);
  for (const id of [1, 2]) db.prepare("INSERT INTO users(id,email,password_hash,password_salt,plan,xpay_subscription_status) VALUES(?,?,'x','x','starter','ACTIVE')").run(id, `user${id}@example.test`);
  const repository = createSmtpRepository(db);
  const secrets = new Map();
  const state = { connected: false, failPrepare: false, list: async () => [{ id: 'domain1' }, { id: 'domain2' }], prepareCalls: 0, runtimeCalls: 0 };
  const secretStore = {
    get: async ref => secrets.get(ref) ?? null,
    set: async (ref, value) => { secrets.set(ref, value); },
    delete: async ref => secrets.delete(ref),
  };
  const dnsService = createSmtpDnsService({ resolver: { resolveNs: async () => state.connected ? NS : ['old.ns.example.test'] } });
  let deleteZoneCalls = 0;
  let deleteDomainCalls = 0;
  const makeResend = () => ({
    listDomains: () => state.list(),
    ensureDomain: async domain => {
      if (state.failPrepare) throw smtpError('RESEND_DOMAIN_LIMIT');
      return { id: 'resend1', name: domain, status: 'pending', records: [] };
    },
    getDomain: async () => ({ id: 'resend1', name: 'example.test', status: 'pending', records: [] }),
    deleteDomain: async () => { deleteDomainCalls++; },
  });
  const runtime = {
    repository, secretStore, config: { publicHost: 'mail.example.test' }, buildCsv: buildSmtpCsv,
    resendFactory: () => { deleteDomainCalls = 0; return makeResend(); },
    dns: {
      findSmtpZone: async () => null,
      ensureSmtpZone: async () => ({ zoneId: 'zone1', nameServers: NS, created: true }),
      deleteSmtpZone: async () => { deleteZoneCalls++; },
      reconcileSmtpDns: async ({ records }) => records,
      checkSmtpNameservers: input => dnsService.checkSmtpNameservers(input),
    },
    mailInfrastructure: { getDomain: async () => null },
  };
  const processor = createSmtpProcessor(runtime);
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'synthetic-test-session-secret', resave: false, saveUninitialized: false }));
  app.post('/login/:id', (req, res) => {
    req.session.authenticated = true; req.session.user = { id: Number(req.params.id) }; res.sendStatus(204);
  });
  app.use('/smtp', createSmtpRouter({
    getRuntime: async () => { state.runtimeCalls++; if (options.runtimeFailure) throw new Error(PRIVATE); return runtime; },
    getProcessor: async () => ({ prepareOrder: async id => { state.prepareCalls++; return processor.prepareOrder(id); } }),
    ...(options.getAccessState ? { getAccessState: options.getAccessState } : {}),
  }));
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(async () => {
    await processor.stop();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookies = new Map();
  const request = async (path, { method = 'GET', body, user = 1 } = {}) => {
    if (user && !cookies.has(user)) {
      const login = await fetch(`${base}/login/${user}`, { method: 'POST' });
      cookies.set(user, login.headers.get('set-cookie').split(';')[0]);
    }
    const response = await fetch(`${base}/smtp${path}`, {
      method, headers: { ...(user ? { cookie: cookies.get(user) } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const data = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
    return { status: response.status, headers: response.headers, data, text };
  };
  const connect = async () => request('/connection', { method: 'POST', body: { api_key: 're_synthetic_valid' } });
  const draft = (domain = 'example.test', user = 1) => repository.createDraft(user, domain);
  const ready = (domain = 'example.test', names = ['alice'], user = 1) => {
    const order = draft(domain, user);
    const token = `fixture-zone-${order.id}`;
    assert.equal(repository.acquireLease(order.id, token), true);
    repository.beginResourceCreation(order.id, 'zone', domain, token);
    repository.recordResourceCreation(order.id, 'zone', domain, token, { created: true, remoteId: 'zone1' });
    repository.updateOrder(order.id, { status: 'ready', cloudflare_zone_id: 'zone1', cloudflare_ns: JSON.stringify(NS), nameservers_connected: 1 }, token);
    repository.releaseLease(order.id, token);
    return repository.reserveMailboxes(order.id, user, names, Infinity);
  };
  const completed = (domain = 'example.test', names = ['alice'], user = 1) => {
    const order = ready(domain, names, user);
    db.prepare("UPDATE smtp_orders SET status='completed',progress=100,started_at=CURRENT_TIMESTAMP,side_effects=1 WHERE id=?").run(order.id);
    for (const mailbox of repository.getMailboxes(order.id)) {
      const ref = `mailbox:${mailbox.email}`;
      secrets.set(ref, `Password-${mailbox.local_part},\"quoted\"!`);
      db.prepare("UPDATE smtp_mailboxes SET status='verified',credential_ref=? WHERE id=?").run(ref, mailbox.id);
    }
    return order;
  };
  return { db, repository, runtime, processor, state, secrets, request, connect, draft, ready, completed, get deleteZoneCalls() { return deleteZoneCalls; }, get deleteDomainCalls() { return deleteDomainCalls; } };
}
function expectError(response, status, code) {
  assert.equal(response.status, status, response.text);
  assert.equal(response.data.status, status);
  assert.equal(response.data.code, code);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(!response.text.includes(PRIVATE));
}

test('unauthenticated requests never initialize SMTP runtime', async t => {
  const f = await fixture(t, { runtimeFailure: true });
  for (const [path, method] of [['/orders', 'GET'], ['/connection', 'POST'], ['/orders/1/download', 'GET']]) {
    expectError(await f.request(path, { method, user: null }), 401, 'UNAUTHORIZED');
  }
  assert.equal(f.state.runtimeCalls, 0);
  expectError(await f.request('/orders'), 503, 'SERVICE_UNAVAILABLE');
});
test('deleted users are unauthorized and inactive access gives billing contract', async t => {
  const f = await fixture(t);
  expectError(await f.request('/orders', { user: 99 }), 401, 'UNAUTHORIZED');
  f.db.prepare("UPDATE users SET xpay_subscription_status='PAST_DUE' WHERE id=1").run();
  const response = await f.request('/connection');
  expectError(response, 403, 'BILLING_REQUIRED');
  assert.equal(response.data.recommendedCheckoutIntent, 'retry');
});
test('all order endpoints enforce authenticated ownership', async t => {
  const f = await fixture(t); const order = f.ready();
  for (const [suffix, method] of [['', 'GET'], ['/logs', 'GET'], ['/download', 'GET'], ['/mailboxes', 'PATCH'], ['/nameservers/check', 'POST'], ['/start', 'POST'], ['/cancel', 'POST'], ['', 'DELETE']]) {
    expectError(await f.request(`/orders/${order.id}${suffix}`, { method, user: 2, body: method === 'PATCH' ? { names: 'bob' } : undefined }), 404, 'NOT_FOUND');
  }
  assert.deepEqual((await f.request('/orders', { user: 2 })).data, []);
});
test('connection stores random isolated references, actual domain counts, and replaces via CAS', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/connection')).data.connected, false);
  const first = await f.connect(); assert.equal(first.status, 201); assert.equal(first.data.connected_domain_count, 2);
  const oldRef = f.repository.getConnection(1).secret_ref;
  await f.runtime.secretStore.set('other-user-ref', 'other-user-key');
  f.repository.swapConnection(2, { secret_ref: 'other-user-ref', validated_at: 1, connected_domain_count: 1 });
  const second = await f.connect(); assert.equal(second.status, 201);
  const newRef = f.repository.getConnection(1).secret_ref;
  assert.notEqual(oldRef, newRef); assert.equal(f.secrets.has(oldRef), false); assert.equal(f.secrets.has(newRef), true);
  assert.equal(f.secrets.get('other-user-ref'), 'other-user-key');
  assert.ok(!second.text.includes('re_synthetic')); assert.ok(!second.text.includes(newRef));
  assert.equal((await f.request('/connection', { method: 'DELETE' })).status, 204);
  assert.equal(f.secrets.has(newRef), false); assert.equal(f.secrets.has('other-user-ref'), true);
  assert.equal((await f.request('/connection', { method: 'DELETE' })).status, 204);
});
test('busy connection replacement and deletion preserve active key', async t => {
  const f = await fixture(t); await f.connect(); const ref = f.repository.getConnection(1).secret_ref;
  const order = f.ready(); f.repository.startOrder(order.id, 1, { inboxesLimit: 500, maxConcurrentOrders: 1 });
  expectError(await f.connect(), 409, 'CONNECTION_BUSY');
  expectError(await f.request('/connection', { method: 'DELETE' }), 409, 'CONNECTION_BUSY');
  assert.equal(f.secrets.get(ref), 're_synthetic_valid'); assert.equal(f.secrets.size, 1);
});
test('CAS loser cleans only its staged secret during concurrent replacement', async t => {
  const f = await fixture(t); await f.connect();
  const gate = defer(); const arrived = defer(); let calls = 0;
  f.state.list = async () => { if (++calls === 2) arrived.resolve(); await gate.promise; return []; };
  const requests = [f.connect(), f.connect()]; await arrived.promise; gate.resolve();
  const responses = await Promise.all(requests);
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
  expectError(responses.find(r => r.status === 409), 409, 'CONNECTION_BUSY');
  assert.equal(f.secrets.size, 1); assert.ok(f.secrets.has(f.repository.getConnection(1).secret_ref));
});
test('replacement rechecks busy state after provider validation', async t => {
  const f = await fixture(t); await f.connect(); const ref = f.repository.getConnection(1).secret_ref;
  const gate = defer(); const arrived = defer();
  f.state.list = async () => { arrived.resolve(); await gate.promise; return []; };
  const pending = f.connect(); await arrived.promise;
  const order = f.ready(); f.repository.startOrder(order.id, 1, { inboxesLimit: 500, maxConcurrentOrders: 1 });
  gate.resolve(); expectError(await pending, 409, 'CONNECTION_BUSY');
  assert.equal(f.secrets.size, 1); assert.equal(f.secrets.get(ref), 're_synthetic_valid');
});
test('secret write and cleanup failures do not destroy committed keys', async t => {
  const f = await fixture(t); await f.connect(); const ref = f.repository.getConnection(1).secret_ref;
  const set = f.runtime.secretStore.set;
  f.runtime.secretStore.set = async () => { throw new Error(PRIVATE); };
  expectError(await f.connect(), 503, 'SERVICE_UNAVAILABLE'); assert.ok(f.secrets.has(ref));
  f.runtime.secretStore.set = set;
  f.runtime.secretStore.delete = async () => { throw new Error(PRIVATE); };
  assert.equal((await f.connect()).status, 201); assert.notEqual(f.repository.getConnection(1).secret_ref, ref);
  assert.equal((await f.request('/connection', { method: 'DELETE' })).status, 204);
  assert.equal(f.repository.getConnection(1), undefined);
});
test('provider failures and invalid keys return safe consistent statuses', async t => {
  const f = await fixture(t);
  expectError(await f.request('/connection', { method: 'POST', body: { api_key: 'bad' } }), 400, 'RESEND_INVALID_KEY');
  for (const [upstream, status, code] of [['RESEND_RATE_LIMIT', 429, 'RESEND_RATE_LIMITED'], ['RESEND_DOMAIN_LIMIT', 400, 'RESEND_DOMAIN_LIMIT'], ['RESEND_DOMAIN_NOT_FOUND', 409, 'RESEND_DOMAIN_NOT_FOUND'], ['RESEND_FORBIDDEN', 400, 'RESEND_FULL_ACCESS_REQUIRED'], ['private', 503, 'SERVICE_UNAVAILABLE']]) {
    f.state.list = async () => { throw Object.assign(new Error(PRIVATE), { code: upstream }); };
    expectError(await f.connect(), status, code);
    assert.equal(f.secrets.size, 0);
  }
});
test('refresh handles missing secrets and CAS races without resurrecting deleted connections', async t => {
  const f = await fixture(t);
  expectError(await f.request('/connection/refresh', { method: 'POST' }), 409, 'RESEND_CONNECTION_REQUIRED');
  await f.connect(); const ref = f.repository.getConnection(1).secret_ref; f.secrets.delete(ref);
  expectError(await f.request('/connection/refresh', { method: 'POST' }), 409, 'RESEND_CONNECTION_INVALID');
  f.secrets.set(ref, 're_synthetic_valid');
  f.state.list = async () => [{ id: 'one' }];
  assert.equal((await f.request('/connection/refresh', { method: 'POST' })).data.connected_domain_count, 1);
  const arrived = defer(); const gate = defer();
  f.state.list = async () => { arrived.resolve(); await gate.promise; return []; };
  const pending = f.request('/connection/refresh', { method: 'POST' }); await arrived.promise;
  assert.equal((await f.request('/connection', { method: 'DELETE' })).status, 204);
  gate.resolve(); expectError(await pending, 409, 'CONNECTION_BUSY'); assert.equal(f.repository.getConnection(1), undefined);
});
test('draft creation prepares real processor checkpoints and idempotent domain claims', async t => {
  const f = await fixture(t);
  expectError(await f.request('/orders', { method: 'POST', body: { domain: 'bad domain' } }), 400, 'INVALID_DOMAIN');
  expectError(await f.request('/orders', { method: 'POST', body: { domain: 'example.test' } }), 409, 'RESEND_CONNECTION_REQUIRED');
  await f.connect();
  const first = await f.request('/orders', { method: 'POST', body: { domain: ' EXAMPLE.TEST. ' } });
  assert.equal(first.status, 201); assert.equal(first.data.status, 'pending_nameservers'); assert.deepEqual(first.data.name_servers, NS);
  assert.equal(f.state.prepareCalls, 1); assert.equal(first.data.domain, 'example.test');
  assert.ok(!first.text.includes('secret_ref')); assert.ok(!first.text.includes('resend_domain_id'));
  const second = await f.request('/orders', { method: 'POST', body: { domain: 'example.test' } });
  assert.equal(second.data.id, first.data.id); assert.equal(f.state.prepareCalls, 1);
  await f.request('/connection', { method: 'POST', user: 2, body: { api_key: 're_user_two' } });
  expectError(await f.request('/orders', { method: 'POST', user: 2, body: { domain: 'example.test' } }), 409, 'DOMAIN_UNAVAILABLE');
});
test('failed preparation retries through prepareOrder without mailbox/start deadlock', async t => {
  const f = await fixture(t); await f.connect(); f.state.failPrepare = true;
  const failed = await f.request('/orders', { method: 'POST', body: { domain: 'example.test' } });
  assert.equal(failed.data.status, 'failed'); assert.equal(failed.data.error_code, 'RESEND_DOMAIN_LIMIT');
  f.state.failPrepare = false;
  const retried = await f.request(`/orders/${failed.data.id}/start`, { method: 'POST' });
  assert.equal(retried.status, 200); assert.equal(retried.data.status, 'pending_nameservers'); assert.equal(f.state.prepareCalls, 2);
});
test('nameserver check uses actual delegation and preserves assigned nameservers', async t => {
  const f = await fixture(t); await f.connect();
  const order = (await f.request('/orders', { method: 'POST', body: { domain: 'example.test' } })).data;
  const first = await f.request(`/orders/${order.id}/nameservers/check`, { method: 'POST' });
  assert.equal(first.status, 200); assert.equal(first.data.connected, false); assert.equal(first.data.order.status, 'pending_nameservers');
  f.state.connected = true;
  const second = await f.request(`/orders/${order.id}/nameservers/check`, { method: 'POST' });
  assert.equal(second.status, 200); assert.equal(second.data.connected, true); assert.equal(second.data.order.status, 'ready');
  assert.deepEqual(second.data.order.name_servers, NS);
  f.state.connected = false;
  const third = await f.request(`/orders/${order.id}/nameservers/check`, { method: 'POST' });
  assert.equal(third.data.order.nameservers_connected, false); assert.equal(third.data.order.status, 'pending_nameservers');
});
test('nameserver response cannot overwrite an order that changed during DNS lookup', async t => {
  const f = await fixture(t); await f.connect(); const order = f.ready();
  const arrived = defer(); const gate = defer();
  f.runtime.dns.checkSmtpNameservers = async () => { arrived.resolve(); await gate.promise; return { connected: true }; };
  const pending = f.request(`/orders/${order.id}/nameservers/check`, { method: 'POST' }); await arrived.promise;
  // Simulate a competing lifecycle write while the HTTP request owns its lease.
  f.db.prepare("UPDATE smtp_orders SET status='processing',started_at=CURRENT_TIMESTAMP WHERE id=?").run(order.id); gate.resolve();
  expectError(await pending, 409, 'ORDER_STATE_CONFLICT'); assert.equal(f.repository.getOrder(order.id).status, 'processing');
});
test('mailbox validation uses array contract and enforces shared inboxesLimit', async t => {
  const f = await fixture(t, { getAccessState: () => ({ canAccessApp: true, inboxesLimit: 2, maxConcurrentOrders: 1 }) });
  const order = f.ready();
  for (const [names, code] of [['alice\nalice', 'DUPLICATE_MAILBOX_NAMES'], ['alice@other.test', 'INVALID_MAILBOX_NAMES'], ['alice\n\nbob', 'INVALID_MAILBOX_NAMES'], [Array(502).fill('a').join('\n'), 'INVALID_MAILBOX_QUANTITY']]) {
    expectError(await f.request(`/orders/${order.id}/mailboxes`, { method: 'PATCH', body: { names } }), 400, code);
  }
  const saved = await f.request(`/orders/${order.id}/mailboxes`, { method: 'PATCH', body: { names: 'Alice@example.test\nbob+' } });
  assert.equal(saved.status, 200); assert.deepEqual(saved.data.mailbox_names, ['alice', 'bob+']);
  f.db.prepare('UPDATE users SET inboxes_used=1 WHERE id=1').run();
  expectError(await f.request(`/orders/${order.id}/mailboxes`, { method: 'PATCH', body: { names: 'alice\nbob' } }), 403, 'INBOX_LIMIT_REACHED');
  assert.deepEqual(f.repository.getMailboxes(order.id).map(m => m.local_part), ['alice', 'bob+']);
});
test('start rechecks quota, shared concurrency and order state; cancellation preserves keys', async t => {
  const f = await fixture(t, { getAccessState: () => ({ canAccessApp: true, inboxesLimit: 2, maxConcurrentOrders: 1 }) });
  await f.connect(); const order = f.ready('example.test', ['alice', 'bob']);
  f.db.prepare('UPDATE users SET inboxes_used=1 WHERE id=1').run();
  expectError(await f.request(`/orders/${order.id}/start`, { method: 'POST' }), 403, 'INBOX_LIMIT_REACHED');
  f.db.prepare('UPDATE users SET inboxes_used=0 WHERE id=1').run();
  assert.equal((await f.request(`/orders/${order.id}/start`, { method: 'POST' })).data.status, 'processing');
  const other = f.ready('other.test');
  // Release quota pressure so this request specifically checks concurrency.
  f.db.prepare('UPDATE smtp_orders SET reserved_inboxes=0 WHERE id=?').run(order.id);
  expectError(await f.request(`/orders/${other.id}/start`, { method: 'POST' }), 409, 'ORDER_CONCURRENCY_LIMIT');
  expectError(await f.request(`/orders/${order.id}/mailboxes`, { method: 'PATCH', body: { names: 'alice' } }), 409, 'ORDER_STATE_CONFLICT');
  assert.equal((await f.request(`/orders/${order.id}/cancel`, { method: 'POST' })).data.status, 'cancelled');
  assert.ok(f.secrets.has(f.repository.getConnection(1).secret_ref));
  expectError(await f.request(`/orders/${order.id}/cancel`, { method: 'POST' }), 409, 'ORDER_STATE_CONFLICT');
});
test('order list/detail report real counts; logs expose timestamp and sanitized messages only', async t => {
  const f = await fixture(t); const order = f.completed();
  f.db.prepare('INSERT INTO smtp_order_logs(order_id,message) VALUES(?,?)').run(order.id, PRIVATE);
  const detail = await f.request(`/orders/${order.id}`); assert.equal(detail.data.created_mailboxes_count, 1);
  assert.ok(!detail.text.includes('credential_ref')); assert.ok(!detail.text.includes('Password-'));
  assert.equal((await f.request('/orders')).data[0].created_mailboxes_count, 1);
  const log = (await f.request(`/orders/${order.id}/logs`)).data[0];
  assert.equal(typeof log.timestamp, 'string'); assert.equal(log.time, undefined); assert.equal(log.message, 'Provisioning Paused');
});
test('deletion respects actual mailbox counts and repository infrastructure safeguards', async t => {
  const f = await fixture(t); const order = f.completed();
  expectError(await f.request(`/orders/${order.id}`, { method: 'DELETE' }), 409, 'ORDER_NOT_DELETABLE');
  const draft = f.draft('delete.test'); assert.equal((await f.request(`/orders/${draft.id}`, { method: 'DELETE' })).status, 204);
  assert.equal(f.repository.getDomainClaim('delete.test'), undefined);
});
test('deletion cleans up provisioned Cloudflare and Resend infrastructure', async t => {
  const f = await fixture(t);
  // Orders with infrastructure get their external resources deleted before removal.
  const withZone = f.ready('zoned.test');
  f.repository.updateOrder(withZone.id, { side_effects: 1 });
  assert.equal((await f.request(`/orders/${withZone.id}`, { method: 'DELETE' })).status, 204);
  assert.equal(f.deleteZoneCalls, 1);
  assert.equal(f.repository.getOrder(withZone.id), undefined);

  // When both Cloudflare and Resend resources exist, both get cleaned up.
  const withBoth = f.ready('bothtype.test');
  f.repository.updateOrder(withBoth.id, { side_effects: 1, resend_domain_id: 'resend1' });
  await f.connect();
  assert.equal((await f.request(`/orders/${withBoth.id}`, { method: 'DELETE' })).status, 204);
  assert.equal(f.deleteZoneCalls, 2);
  assert.equal(f.deleteDomainCalls, 1);
  assert.equal(f.repository.getOrder(withBoth.id), undefined);
});
test('deletion with infrastructure is best-effort: cleanup failure never blocks', async t => {
  const f = await fixture(t);
  const order = f.ready('fragile.test');
  f.repository.updateOrder(order.id, { side_effects: 1 });
  f.runtime.dns.deleteSmtpZone = async () => { throw new Error('Cloudflare unavailable'); };
  assert.equal((await f.request(`/orders/${order.id}`, { method: 'DELETE' })).status, 204);
  assert.equal(f.repository.getOrder(order.id), undefined);
});
test('deletion clears stale side_effects flag even when no infrastructure exists', async t => {
  const f = await fixture(t);
  // Reproduces the live bug: failed order with side_effects=1 but no cloudflare_zone_id
  // or resend_domain_id (provisioning failed before either was created).
  const stale = f.ready('stale.test');
  f.repository.updateOrder(stale.id, { side_effects: 1, status: 'failed', cloudflare_zone_id: null, resend_domain_id: null });
  assert.equal((await f.request(`/orders/${stale.id}`, { method: 'DELETE' })).status, 204);
  assert.equal(f.repository.getOrder(stale.id), undefined);
  assert.equal(f.deleteZoneCalls, 0);
  assert.equal(f.deleteDomainCalls, 0);
});
test('CSV reads secret refs, preserves exact passwords and returns no-store metadata', async t => {
  const f = await fixture(t); const order = f.completed();
  const response = await f.request(`/orders/${order.id}/download`);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-type'), /^text\/csv; charset=utf-8/);
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="inboxes-example.test.csv"');
  assert.equal(response.text, buildSmtpCsv([{ email: 'alice@example.test', password: 'Password-alice,"quoted"!' }], f.runtime.config).replace(/^\uFEFF/, ''));
  assert.ok(!response.text.includes('credential_ref')); assert.ok(!response.text.includes('/opt/'));
});
test('trial CSV allowance is shared with other providers and repeat downloads are idempotent', async t => {
  const access = { canAccessApp: true, inboxesLimit: 500, maxConcurrentOrders: 1, canDownloadAll: false, downloadAllowance: 10 };
  const f = await fixture(t, { getAccessState: () => access });
  const existing = Array.from({ length: 9 }, (_, i) => ({ email: `existing${i}@other.test`, password: 'Synthetic!' }));
  f.repository.selectCredentialRowsForAllowance(1, 'microsoft', existing, access);
  const order = f.completed('example.test', ['alice', 'bob']);
  const response = await f.request(`/orders/${order.id}/download`); assert.equal(response.status, 200);
  assert.ok(response.text.includes('alice@example.test')); assert.ok(!response.text.includes('bob@example.test'));
  assert.equal((await f.request(`/orders/${order.id}/download`)).text, response.text);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM inbox_download_allocations WHERE user_id=1').get().n, 10);
  const other = f.completed('second.test'); expectError(await f.request(`/orders/${other.id}/download`), 403, 'DOWNLOAD_ALLOWANCE_REACHED');
});
test('incomplete, missing-secret and invalid CSV configuration fail without consuming allowance', async t => {
  const f = await fixture(t, { getAccessState: () => ({ canAccessApp: true, inboxesLimit: 500, canDownloadAll: false, downloadAllowance: 10 }) });
  const draft = f.ready('draft.test'); expectError(await f.request(`/orders/${draft.id}/download`), 409, 'DOWNLOAD_NOT_READY');
  const order = f.completed(); const ref = f.repository.getMailboxes(order.id)[0].credential_ref;
  f.secrets.delete(ref); expectError(await f.request(`/orders/${order.id}/download`), 503, 'MAIL_INFRASTRUCTURE_UNAVAILABLE');
  f.secrets.set(ref, 'SyntheticPassword!'); f.runtime.config.publicHost = '';
  expectError(await f.request(`/orders/${order.id}/download`), 503, 'SERVICE_UNAVAILABLE');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM inbox_download_allocations').get().n, 0);
  f.runtime.config.publicHost = 'mail.example.test';
  f.db.prepare("UPDATE smtp_mailboxes SET status='created' WHERE order_id=?").run(order.id);
  expectError(await f.request(`/orders/${order.id}/download`), 409, 'DOWNLOAD_NOT_READY');
});

test('duplicate starts return existing active orders without new side effects', async t => {
  const f = await fixture(t); await f.connect(); const order = f.ready();
  const first = await f.request(`/orders/${order.id}/start`, { method: 'POST' });
  assert.equal(first.status, 200);
  for (const status of ['processing', 'waiting_dns', 'waiting_verification']) {
    f.repository.updateOrder(order.id, { status });
    const repeated = await f.request(`/orders/${order.id}/start`, { method: 'POST' });
    assert.equal(repeated.status, 200); assert.equal(repeated.data.status, status); assert.equal(repeated.data.id, order.id);
  }
  assert.equal(f.state.prepareCalls, 0);
});
test('missing and revoked credentials invalidate only the snapshotted connection', async t => {
  const f = await fixture(t); await f.connect(); const ref = f.repository.getConnection(1).secret_ref;
  f.secrets.delete(ref);
  expectError(await f.request('/connection/refresh', { method: 'POST' }), 409, 'RESEND_CONNECTION_INVALID');
  assert.equal(f.repository.getConnection(1).status, 'invalid');
  f.secrets.set(ref, 're_synthetic_valid');
  for (const code of ['RESEND_UNAUTHORIZED', 'RESEND_FORBIDDEN']) {
    f.repository.updateConnection(1, ref, { status: 'connected', connected_domain_count: 2, validated_at: 1 });
    f.state.list = async () => { throw smtpError(code); };
    expectError(await f.request('/connection/refresh', { method: 'POST' }), 400, code === 'RESEND_UNAUTHORIZED' ? 'RESEND_INVALID_KEY' : 'RESEND_FULL_ACCESS_REQUIRED');
    assert.equal(f.repository.getConnection(1).status, 'invalid');
    assert.equal((await f.request('/connection')).data.connected, false);
  }
});
test('transient refresh errors preserve connection and late revocation cannot invalidate replacement', async t => {
  const f = await fixture(t); await f.connect();
  f.state.list = async () => { throw smtpError('RESEND_RATE_LIMIT'); };
  expectError(await f.request('/connection/refresh', { method: 'POST' }), 429, 'RESEND_RATE_LIMITED');
  assert.equal(f.repository.getConnection(1).status, 'connected');
  const arrived = defer(); const gate = defer();
  f.state.list = async () => { arrived.resolve(); await gate.promise; throw smtpError('RESEND_UNAUTHORIZED'); };
  const pending = f.request('/connection/refresh', { method: 'POST' }); await arrived.promise;
  f.secrets.set('replacement-ref', 're_replacement');
  const old = f.repository.getConnection(1);
  assert.equal(f.repository.swapConnection(1, { secret_ref: 'replacement-ref', validated_at: 2, connected_domain_count: 3 }, old.secret_ref), true);
  gate.resolve(); expectError(await pending, 409, 'CONNECTION_BUSY');
  assert.equal(f.repository.getConnection(1).status, 'connected'); assert.equal(f.repository.getConnection(1).secret_ref, 'replacement-ref');
});
test('disconnect CAS mismatch never deletes a replacement secret', async t => {
  const f = await fixture(t); await f.connect(); const old = f.repository.getConnection(1);
  const disconnect = f.repository.disconnectConnection;
  f.repository.disconnectConnection = (id, ref) => {
    f.secrets.set('new-ref', 're_new');
    f.repository.swapConnection(id, { secret_ref: 'new-ref', connected_domain_count: 0, validated_at: 1 }, ref);
    return disconnect.call(f.repository, id, ref);
  };
  expectError(await f.request('/connection', { method: 'DELETE' }), 409, 'CONNECTION_BUSY');
  assert.equal(f.secrets.has(old.secret_ref), true); assert.equal(f.secrets.get('new-ref'), 're_new');
});
test('nameserver checks sanitize DNS exceptions and reject live worker leases', async t => {
  const f = await fixture(t); const order = f.ready();
  f.runtime.dns.checkSmtpNameservers = async () => { throw Object.assign(new Error(PRIVATE), { code: 'DNS_UNAVAILABLE' }); };
  expectError(await f.request(`/orders/${order.id}/nameservers/check`, { method: 'POST' }), 503, 'DNS_UNAVAILABLE');
  f.runtime.dns.checkSmtpNameservers = async () => ({ connected: true });
  assert.equal(f.repository.acquireLease(order.id, 'worker-token'), true);
  expectError(await f.request(`/orders/${order.id}/nameservers/check`, { method: 'POST' }), 409, 'ORDER_STATE_CONFLICT');
  assert.equal(f.repository.getOrder(order.id).processing_token, 'worker-token');
});
test('quota and concurrency include reservations from Microsoft orders', async t => {
  const f = await fixture(t, { getAccessState: () => ({ canAccessApp: true, inboxesLimit: 2, maxConcurrentOrders: 1 }) });
  await f.connect(); const order = f.ready();
  const tenant = f.db.prepare("INSERT INTO tenants(user_id,name,domain,admin_email,admin_password) VALUES(1,'Test','microsoft.test','admin@microsoft.test','synthetic')").run().lastInsertRowid;
  const other = f.db.prepare("INSERT INTO orders(user_id,tenant_id,total_mailboxes,status) VALUES(1,?,2,'pending')").run(tenant).lastInsertRowid;
  expectError(await f.request(`/orders/${order.id}/start`, { method: 'POST' }), 403, 'INBOX_LIMIT_REACHED');
  f.db.prepare("UPDATE orders SET total_mailboxes=1,status='processing' WHERE id=?").run(other);
  expectError(await f.request(`/orders/${order.id}/start`, { method: 'POST' }), 409, 'ORDER_CONCURRENCY_LIMIT');
});
test('CSV rejects tampered credential references and mismatched mailbox emails before secret reads', async t => {
  const f = await fixture(t); const order = f.completed();
  let reads = 0; const get = f.runtime.secretStore.get;
  f.runtime.secretStore.get = async ref => { reads++; return get(ref); };
  f.db.prepare("UPDATE smtp_mailboxes SET credential_ref='stalwart:provisioning-api-key' WHERE order_id=?").run(order.id);
  expectError(await f.request(`/orders/${order.id}/download`), 409, 'DOWNLOAD_NOT_READY'); assert.equal(reads, 0);
  f.db.prepare("UPDATE smtp_mailboxes SET email='other@other.test',credential_ref='mailbox:other@other.test' WHERE order_id=?").run(order.id);
  expectError(await f.request(`/orders/${order.id}/download`), 409, 'DOWNLOAD_NOT_READY'); assert.equal(reads, 0);
});
test('unexpected repository failures return private JSON errors instead of unhandled rejections', async t => {
  const f = await fixture(t);
  f.repository.listOrders = () => { throw new Error(PRIVATE); };
  const response = await f.request('/orders'); expectError(response, 503, 'SERVICE_UNAVAILABLE');
  assert.equal(response.headers.get('pragma'), 'no-cache'); assert.ok(!response.text.includes('Error:'));
});

test('HTTP setup through real processor completion exports only positively owned mailbox credentials', async t => {
  const f = await fixture(t);
  let zone = null; let domain = null;
  const mailboxes = new Map();
  f.runtime.dns.findSmtpZone = async () => zone;
  f.runtime.dns.ensureSmtpZone = async () => {
    const created = !zone; zone = { zoneId: 'zone1', nameServers: NS };
    return { ...zone, created };
  };
  f.runtime.dns.verifySmtpDns = async () => ({ ready: true });
  f.runtime.resendFactory = () => ({
    listDomains: async () => [],
    ensureDomain: async name => ({ id: 'resend1', name, records: [], status: 'verified' }),
    getDomain: async () => ({ id: 'resend1', name: 'example.test', records: [], status: 'verified' }),
  });
  Object.assign(f.runtime.mailInfrastructure, {
    getDomain: async () => domain,
    ensureDomain: async name => { domain = { id: 'mail-domain1', name }; return { ...domain, created: true }; },
    ensureDomainAuthentication: async () => ({ records: [] }),
    getRequiredDnsRecords: async () => [],
    getMailbox: async email => mailboxes.get(email) ?? null,
    ensureMailbox: async email => {
      const item = { id: `mailbox-${mailboxes.size + 1}`, email };
      mailboxes.set(email, item); const credentialRef = `mailbox:${email}`;
      f.secrets.set(credentialRef, 'SyntheticMailboxPassword!');
      return { ...item, created: true, credentialRef };
    },
    verifyMailbox: async () => ({ smtp: true, imap: true }),
    verifyRelaySecurity: async () => true,
  });
  await f.connect();
  const draft = await f.request('/orders', { method: 'POST', body: { domain: 'example.test' } });
  assert.equal(draft.data.status, 'pending_nameservers'); const id = draft.data.id;
  assert.equal(f.repository.getResourceClaim(id, 'zone', 'example.test').remote_id, 'zone1');
  f.state.connected = true;
  assert.equal((await f.request(`/orders/${id}/nameservers/check`, { method: 'POST' })).data.connected, true);
  assert.equal((await f.request(`/orders/${id}/mailboxes`, { method: 'PATCH', body: { names: 'alice\nbob' } })).data.total_mailboxes, 2);
  assert.equal((await f.request(`/orders/${id}/start`, { method: 'POST' })).data.status, 'processing');
  const provisioner = createSmtpProcessor(f.runtime);
  t.after(() => provisioner.stop());
  const complete = await provisioner.processOrder(id);
  assert.equal(complete.status, 'completed', JSON.stringify(complete));
  assert.equal(f.repository.getResourceClaim(id, 'domain', 'example.test').remote_id, 'mail-domain1');
  for (const mailbox of f.repository.getMailboxes(id)) {
    const receipt = f.repository.getResourceClaim(id, 'mailbox', mailbox.email);
    assert.equal(receipt.remote_id, mailboxes.get(mailbox.email).id);
    assert.equal(receipt.credential_ref, mailbox.credential_ref);
  }
  const detail = await f.request(`/orders/${id}`); assert.equal(detail.data.created_mailboxes_count, 2);
  assert.equal(f.repository.getUser(1).inboxes_used, 2);
  const csv = await f.request(`/orders/${id}/download`); assert.equal(csv.status, 200);
  assert.ok(csv.text.includes('alice@example.test')); assert.ok(csv.text.includes('bob@example.test'));
  assert.ok(!detail.text.includes('SyntheticMailboxPassword!'));
  assert.equal((await f.request(`/orders/${id}/logs`)).data.at(-1).message, 'Provisioning Complete');
});

test('nameserver check rejects lost ownership after DNS await and releases its lease', async t => {
  const f = await fixture(t); const order = f.ready();
  f.repository.updateOrder(order.id, { status: 'pending_nameservers', nameservers_connected: 0 });
  const arrived = defer(); const gate = defer();
  f.runtime.dns.checkSmtpNameservers = async () => { arrived.resolve(); await gate.promise; return { connected: true }; };
  const pending = f.request(`/orders/${order.id}/nameservers/check`, { method: 'POST' });
  await arrived.promise;
  assert.ok(f.repository.getOrder(order.id).processing_token);
  f.db.prepare('DELETE FROM smtp_domain_claims WHERE order_id=?').run(order.id);
  gate.resolve(); expectError(await pending, 409, 'DOMAIN_UNAVAILABLE');
  const current = f.repository.getOrder(order.id);
  assert.equal(current.status, 'pending_nameservers'); assert.equal(current.nameservers_connected, 0);
  assert.equal(current.processing_token, null); assert.equal(current.lease_until, null);
});
test('nameserver check requires positive zone ownership receipts before DNS and after await', async t => {
  const f = await fixture(t); const order = f.ready();
  f.repository.updateOrder(order.id, { status: 'pending_nameservers', nameservers_connected: 0 });
  const arrived = defer(); const gate = defer(); let calls = 0;
  f.runtime.dns.checkSmtpNameservers = async () => { calls++; arrived.resolve(); await gate.promise; return { connected: true }; };
  const pending = f.request(`/orders/${order.id}/nameservers/check`, { method: 'POST' });
  await arrived.promise;
  f.db.prepare("UPDATE smtp_resource_claims SET remote_id=NULL WHERE order_id=? AND kind='zone'").run(order.id);
  gate.resolve(); expectError(await pending, 409, 'DOMAIN_UNAVAILABLE');
  expectError(await f.request(`/orders/${order.id}/nameservers/check`, { method: 'POST' }), 409, 'DOMAIN_UNAVAILABLE');
  assert.equal(calls, 1); assert.equal(f.repository.getOrder(order.id).status, 'pending_nameservers');
  assert.equal(f.repository.getOrder(order.id).processing_token, null);
});

test('claim expiry during nameserver DNS await does not block the owner and prevents later reclaim', async t => {
  const f = await fixture(t); const order = f.ready();
  f.repository.updateOrder(order.id, { status: 'pending_nameservers', nameservers_connected: 0 });
  const arrived = defer(); const gate = defer();
  f.runtime.dns.checkSmtpNameservers = async () => { arrived.resolve(); await gate.promise; return { connected: true }; };
  const pending = f.request(`/orders/${order.id}/nameservers/check`, { method: 'POST' });
  await arrived.promise;
  f.db.prepare("UPDATE smtp_domain_claims SET created_at=datetime('now','-25 hours') WHERE order_id=?").run(order.id);
  // A live route lease prevents reclaim while the DNS request is still in flight.
  assert.throws(() => f.repository.createDraft(2, order.domain), error => error.code === 'DOMAIN_UNAVAILABLE');
  gate.resolve();
  const response = await pending;
  assert.equal(response.status, 200);
  const current = f.repository.getOrder(order.id);
  assert.equal(current.status, 'ready'); assert.equal(current.nameservers_connected, 1);
  assert.equal(current.processing_token, null); assert.equal(current.lease_until, null);
  assert.throws(() => f.repository.createDraft(2, order.domain), error => error.code === 'DOMAIN_UNAVAILABLE');
});
test('already expired unverified claim is accepted for nameserver lookup by the original owner', async t => {
  const f = await fixture(t); const order = f.ready();
  f.repository.updateOrder(order.id, { status: 'pending_nameservers', nameservers_connected: 0 });
  f.db.prepare("UPDATE smtp_domain_claims SET created_at=datetime('now','-25 hours') WHERE order_id=?").run(order.id);
  let calls = 0; f.runtime.dns.checkSmtpNameservers = async () => { calls++; return { connected: true }; };
  const response = await f.request(`/orders/${order.id}/nameservers/check`, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal(calls, 1); assert.equal(f.repository.getOrder(order.id).nameservers_connected, 1);
  assert.equal(f.repository.getOrder(order.id).processing_token, null);
});

test('transient preparation exposes a safe pause and retry resumes the same order', async t => {
  const f = await fixture(t); await f.connect();
  const ensureZone = f.runtime.dns.ensureSmtpZone;
  f.runtime.dns.ensureSmtpZone = async () => { throw Object.assign(new Error(PRIVATE), { code: 'DNS_UNAVAILABLE' }); };
  const paused = await f.request('/orders', { method: 'POST', body: { domain: 'example.test' } });
  assert.equal(paused.status, 201);
  assert.equal(paused.data.status, 'draft');
  assert.equal(paused.data.error_code, 'DNS_UNAVAILABLE');
  assert.equal(paused.data.error_message, 'DNS could not be checked. Try again.');
  assert.ok(!paused.text.includes(PRIVATE));
  f.runtime.dns.ensureSmtpZone = ensureZone;
  const retried = await f.request(`/orders/${paused.data.id}/start`, { method: 'POST' });
  assert.equal(retried.status, 200);
  assert.equal(retried.data.id, paused.data.id);
  assert.equal(retried.data.status, 'pending_nameservers');
  assert.equal(retried.data.error_code, null);
  assert.deepEqual(retried.data.name_servers, NS);
});
