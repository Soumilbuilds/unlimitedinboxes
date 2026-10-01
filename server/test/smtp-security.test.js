import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileSecretStore } from '../services/fileSecretStore.js';
import { normalizeSmtpDomain, normalizeSmtpMailboxNames } from '../services/smtpValidation.js';

const directory = await mkdtemp(join(tmpdir(), 'smtp-security-'));
after(() => rm(directory, { recursive: true, force: true }));
// Import the DB-backed modules only after selecting an isolated test database.
process.env.APP_DB_PATH = join(directory, 'app.db');
const { default: db, createTenant } = await import('../db/database.js');
const { createSmtpRepository } = await import('../db/smtp.js');
const { createSmtpProcessor } = await import('../services/smtpOrderProcessor.js');
after(() => db.close());

function fixture() {
  const userId = Number(db.prepare(`INSERT INTO users(email,password_hash,password_salt,plan,xpay_subscription_status)
    VALUES(?,'x','x','basic','ACTIVE')`).run(`smtp-${randomUUID()}@example.test`).lastInsertRowid);
  const repo = createSmtpRepository(db);
  const order = repo.createDraft(userId, `d-${userId}.example.test`);
  repo.swapConnection(userId, { secret_ref: `resend:${userId}`, validated_at: Date.now(), connected_domain_count: 0 });
  return { repo, order, userId };
}

function ready(f, names = ['alice']) {
  f.repo.reserveMailboxes(f.order.id, f.userId, names, 100);
  f.repo.acquireLease(f.order.id, 'setup');
  f.repo.beginResourceCreation(f.order.id, 'zone', f.order.domain, 'setup');
  f.repo.recordResourceCreation(f.order.id, 'zone', f.order.domain, 'setup', { created: true, remoteId: `zone-${f.order.id}` });
  f.repo.releaseLease(f.order.id, 'setup');
  f.repo.updateOrder(f.order.id, { status: 'ready', nameservers_connected: 1, cloudflare_zone_id: `zone-${f.order.id}` });
  return f.repo.startOrder(f.order.id, f.userId, { inboxesLimit: 100, maxConcurrentOrders: 1 });
}

function transports(f) {
  const domains = new Map();
  const mailboxes = new Map();
  let zone = null;
  const counts = { zones: 0, domains: 0, mailboxes: 0, verification: 0 };
  const mailInfrastructure = {
    getDomain: async name => domains.get(name) || null,
    ensureDomain: async name => {
      counts.domains++;
      const item = { id: `mail-${f.order.id}`, name, created: true };
      domains.set(name, item); return item;
    },
    ensureDomainAuthentication: async () => ({ records: [] }),
    getRequiredDnsRecords: async () => [],
    getMailbox: async email => mailboxes.get(email) || null,
    ensureMailbox: async email => {
      counts.mailboxes++;
      const item = { id: `inbox-${email}`, email, created: true, credentialRef: `mailbox:${email}` };
      mailboxes.set(email, item); return item;
    },
    verifyMailbox: async () => { counts.verification++; return { smtp: true, imap: true }; },
    verifyRelaySecurity: async () => true,
  };
  const dns = {
    findSmtpZone: async () => zone,
    ensureSmtpZone: async () => {
      if (zone) return { ...zone, created: false };
      counts.zones++;
      zone = { zoneId: `zone-${f.order.id}`, nameServers: ['ns1.example.test','ns2.example.test'], created: true };
      return zone;
    },
    reconcileSmtpDns: async () => [],
    checkSmtpNameservers: async () => ({ connected: true }),
    verifySmtpDns: async () => ({ ready: true }),
  };
  const resend = { ensureDomain: async () => ({ id: 'resend-domain', name: f.order.domain, status: 'verified', records: [] }),
    getDomain: async () => ({ id: 'resend-domain', name: f.order.domain, status: 'verified', records: [] }) };
  const deps = { repository: f.repo, dns, mailInfrastructure, secretStore: { get: async () => 'synthetic-key' }, resendFactory: () => resend };
  return { domains, mailboxes, counts, deps, mailInfrastructure, dns };
}

test('mailbox paste accepts CRLF and LF, rejects bare CR, controls, foreign domains and duplicates', () => {
  assert.equal(normalizeSmtpDomain(' EXAMPLE.test. '), 'example.test');
  assert.deepEqual(normalizeSmtpMailboxNames('Alice\r\nBob@example.test\r\n', 'example.test'), ['alice','bob']);
  assert.deepEqual(normalizeSmtpMailboxNames('Alice\nBob\n', 'example.test'), ['alice','bob']);
  for (const input of ['alice\rbob', 'alice\n\nbob', 'alice\u0000', 'alice@foreign.test', 'Alice\nalice']) {
    assert.throws(() => normalizeSmtpMailboxNames(input, 'example.test'));
  }
});

test('quota defaults to current plan and includes Microsoft and other SMTP reservations', () => {
  const f = fixture();
  db.prepare('UPDATE users SET inboxes_used=99 WHERE id=?').run(f.userId);
  f.repo.reserveMailboxes(f.order.id, f.userId, ['alice']);
  const second = f.repo.createDraft(f.userId, `second-${f.userId}.example.test`);
  assert.throws(() => f.repo.reserveMailboxes(second.id, f.userId, ['bob'], Infinity), { code: 'INBOX_LIMIT_REACHED' });
  db.prepare('UPDATE users SET inboxes_used=98 WHERE id=?').run(f.userId);
  const tenant = Number(db.prepare(`INSERT INTO tenants(user_id,name,domain,admin_email,admin_password)
    VALUES(?,'Test',?,'a@example.test','x')`).run(f.userId, `ms-${f.userId}.example.test`).lastInsertRowid);
  db.prepare("INSERT INTO orders(tenant_id,user_id,total_mailboxes,status) VALUES(?,?,1,'pending')").run(tenant, f.userId);
  assert.throws(() => f.repo.reserveMailboxes(second.id, f.userId, ['bob']), { code: 'INBOX_LIMIT_REACHED' });
});

test('a cancelled order must reserve its inboxes again before restart', () => {
  const f = fixture();
  f.repo.reserveMailboxes(f.order.id, f.userId, ['alice']);
  f.repo.cancelOrder(f.order.id, f.userId);
  f.repo.updateOrder(f.order.id, { nameservers_connected: 1, cloudflare_zone_id: 'zone' });
  db.prepare('UPDATE users SET inboxes_used=100 WHERE id=?').run(f.userId);
  assert.throws(() => f.repo.startOrder(f.order.id, f.userId, { inboxesLimit: Infinity, maxConcurrentOrders: Infinity }), { code: 'INBOX_LIMIT_REACHED' });
  db.prepare('UPDATE users SET inboxes_used=99 WHERE id=?').run(f.userId);
  assert.equal(f.repo.startOrder(f.order.id, f.userId, {}).reserved_inboxes, 1);
});

test('only one worker can lease an order and stale workers cannot update it', () => {
  const f = fixture();
  assert.equal(f.repo.acquireLease(f.order.id, 'first'), true);
  assert.equal(f.repo.acquireLease(f.order.id, 'second'), false);
  db.prepare('UPDATE smtp_orders SET lease_until=0 WHERE id=?').run(f.order.id);
  assert.equal(f.repo.acquireLease(f.order.id, 'second'), true);
  assert.throws(() => f.repo.updateOrder(f.order.id, { status: 'ready' }, 'first'), { code: 'LEASE_LOST' });
  assert.throws(() => f.repo.updateOrder(f.order.id, { status: 'ready' }, null), { code: 'LEASE_LOST' });
});

test('resource receipts are durable after cancellation but never adopt a creation race', () => {
  const f = fixture();
  f.repo.acquireLease(f.order.id, 'worker');
  f.repo.beginResourceCreation(f.order.id, 'domain', f.order.domain, 'worker');
  assert.throws(() => f.repo.recordResourceCreation(f.order.id, 'domain', f.order.domain, 'worker', { created: false, remoteId: 'foreign' }), { code: 'DOMAIN_UNAVAILABLE' });
  f.repo.cancelOrder(f.order.id, f.userId);
  f.repo.recordResourceCreation(f.order.id, 'domain', f.order.domain, 'worker', { created: true, remoteId: 'ours' });
  assert.equal(f.repo.recordResourceCreation(f.order.id, 'domain', f.order.domain, 'worker', { created: true, remoteId: 'ours' }).remote_id, 'ours');
  const restarted = createSmtpRepository(db);
  assert.equal(restarted.getResourceClaim(f.order.id, 'domain', f.order.domain).remote_id, 'ours');
  assert.equal(restarted.getOrder(f.order.id).status, 'cancelled');
  assert.throws(() => restarted.deleteOrder(f.order.id, f.userId), { code: 'ORDER_NOT_DELETABLE' });
});

test('retry preparation recovers a zone receipt when the order checkpoint was lost', async () => {
  const f = fixture(); const t = transports(f);
  const update = f.repo.updateOrder.bind(f.repo);
  let interrupted = false;
  f.repo.updateOrder = (id, values, token) => {
    if (values.cloudflare_zone_id && !interrupted) { interrupted = true; throw Object.assign(new Error('interrupted'), { code: 'DNS_UNAVAILABLE' }); }
    return update(id, values, token);
  };
  await createSmtpProcessor(t.deps).prepareOrder(f.order.id);
  assert.equal(f.repo.getOrder(f.order.id).cloudflare_zone_id, null);
  assert.ok(f.repo.getResourceClaim(f.order.id, 'zone', f.order.domain).remote_id);
  await createSmtpProcessor(t.deps).prepareOrder(f.order.id);
  assert.equal(f.repo.getOrder(f.order.id).status, 'pending_nameservers');
  assert.equal(t.counts.zones, 1);
});

test('processor rejects a shared mail domain created between discovery and ensure', async () => {
  const f = fixture(); ready(f); const t = transports(f);
  t.mailInfrastructure.ensureDomain = async () => ({ id: 'foreign', name: f.order.domain, created: false });
  await createSmtpProcessor(t.deps).processOrder(f.order.id);
  assert.equal(f.repo.getOrder(f.order.id).error_code, 'DOMAIN_UNAVAILABLE');
  assert.equal(f.repo.getOrder(f.order.id).mail_domain_owned, 0);
  assert.equal(t.counts.mailboxes, 0);
});

test('restart recovers mailbox receipt, verifies it again, and charges completion once', async () => {
  const f = fixture(); ready(f); const t = transports(f);
  f.repo.updateOrder(f.order.id, { resend_domain_id: 'resend-domain', cloudflare_ns: '["ns1.example.test","ns2.example.test"]' });
  const checkpoint = f.repo.checkpointMailbox.bind(f.repo);
  let interrupted = false;
  f.repo.checkpointMailbox = (id, local, values, token) => {
    if (values.credential_ref && !interrupted) { interrupted = true; throw Object.assign(new Error('interrupted'), { code: 'SERVICE_UNAVAILABLE' }); }
    return checkpoint(id, local, values, token);
  };
  const complete = f.repo.completeOrder.bind(f.repo);
  f.repo.completeOrder = (id, token) => {
    const result = complete(id, token);
    assert.equal(complete(id, token).charged_inboxes, 1);
    return result;
  };
  await createSmtpProcessor(t.deps).processOrder(f.order.id);
  assert.equal(f.repo.getMailboxes(f.order.id)[0].credential_ref, null);
  await createSmtpProcessor(t.deps).processOrder(f.order.id);
  assert.equal(f.repo.getOrder(f.order.id).status, 'completed');
  assert.equal(t.counts.mailboxes, 1);
  assert.equal(f.repo.getUser(f.userId).inboxes_used, 1);
  await createSmtpProcessor(t.deps).processOrder(f.order.id);
  assert.equal(f.repo.getUser(f.userId).inboxes_used, 1);
});

test('an ambiguous orphan with only creation intent is blocked on restart', async () => {
  const f = fixture(); ready(f); const t = transports(f);
  f.repo.acquireLease(f.order.id, 'old');
  f.repo.beginResourceCreation(f.order.id, 'domain', f.order.domain, 'old');
  f.repo.releaseLease(f.order.id, 'old');
  t.domains.set(f.order.domain, { id: 'unknown', name: f.order.domain });
  await createSmtpProcessor(t.deps).processOrder(f.order.id);
  assert.equal(f.repo.getOrder(f.order.id).error_code, 'DOMAIN_UNAVAILABLE');
  assert.equal(t.counts.mailboxes, 0);
});

test('plan downgrade stops provisioning before new provider side effects', async () => {
  const f = fixture(); ready(f); const t = transports(f);
  db.prepare('UPDATE users SET inboxes_used=100 WHERE id=?').run(f.userId);
  await createSmtpProcessor(t.deps).processOrder(f.order.id);
  assert.equal(f.repo.getOrder(f.order.id).error_code, 'INBOX_LIMIT_REACHED');
  assert.equal(t.counts.domains, 0);
});

test('same owner draft creation is idempotent, foreign owners and Microsoft claims are rejected', () => {
  const f = fixture(); const other = fixture();
  assert.equal(f.repo.createDraft(f.userId, `${f.order.domain.toUpperCase()}.`).id, f.order.id);
  assert.throws(() => f.repo.createDraft(other.userId, f.order.domain), { code: 'DOMAIN_UNAVAILABLE' });
  const domain = `existing-${f.userId}.example.test`;
  db.prepare(`INSERT INTO tenants(user_id,name,domain,admin_email,admin_password)
    VALUES(?,'Test',?,'admin@example.test','x')`).run(f.userId, `${domain.toUpperCase()}.`);
  assert.throws(() => f.repo.createDraft(f.userId, domain), { code: 'DOMAIN_UNAVAILABLE' });
});

test('draft leases and cancelled in-flight leases block connection replacement and deletion', () => {
  const f = fixture();
  f.repo.acquireLease(f.order.id, 'worker');
  const replacement = { secret_ref: 'new-key', validated_at: Date.now(), connected_domain_count: 0 };
  assert.throws(() => f.repo.swapConnection(f.userId, replacement, `resend:${f.userId}`), { code: 'CONNECTION_BUSY' });
  f.repo.cancelOrder(f.order.id, f.userId);
  assert.equal(f.repo.busyConnection(f.userId), true);
  assert.throws(() => f.repo.disconnectConnection(f.userId, `resend:${f.userId}`), { code: 'CONNECTION_BUSY' });
  assert.equal(f.repo.heartbeat(f.order.id, 'worker'), false);
  assert.throws(() => f.repo.updateOrder(f.order.id, { status: 'processing' }, 'worker'), { code: 'LEASE_LOST' });
  f.repo.releaseLease(f.order.id, 'worker');
  assert.equal(f.repo.disconnectConnection(f.userId, `resend:${f.userId}`), true);
});

test('cancellation during provider creation preserves positive receipt without stale lifecycle writes', async () => {
  const f = fixture(); ready(f); const t = transports(f);
  const ensure = t.mailInfrastructure.ensureDomain;
  t.mailInfrastructure.ensureDomain = async name => {
    const result = await ensure(name);
    f.repo.cancelOrder(f.order.id, f.userId);
    return result;
  };
  await createSmtpProcessor(t.deps).processOrder(f.order.id);
  const order = f.repo.getOrder(f.order.id);
  assert.equal(order.status, 'cancelled');
  assert.equal(order.mail_domain_owned, 0);
  assert.equal(order.charged_inboxes, 0);
  assert.equal(f.repo.getResourceClaim(order.id, 'domain', order.domain).remote_id, `mail-${order.id}`);
  assert.equal(t.counts.mailboxes, 0);
});

test('lease expiry during provider creation preserves receipt; a new lease keeps the immutable intent', async () => {
  const f = fixture(); ready(f); const t = transports(f);
  const ensure = t.mailInfrastructure.ensureDomain;
  let originalIntent;
  t.mailInfrastructure.ensureDomain = async name => {
    originalIntent = f.repo.getResourceClaim(f.order.id, 'domain', name).operation_token;
    const result = await ensure(name);
    db.prepare('UPDATE smtp_orders SET lease_until=0 WHERE id=?').run(f.order.id);
    f.repo.acquireLease(f.order.id, 'replacement');
    assert.equal(f.repo.beginResourceCreation(f.order.id, 'domain', name, 'replacement').operation_token, originalIntent);
    return result;
  };
  await createSmtpProcessor(t.deps).processOrder(f.order.id);
  assert.equal(f.repo.getOrder(f.order.id).mail_domain_owned, 0);
  assert.equal(f.repo.getOrder(f.order.id).processing_token, 'replacement');
  assert.equal(f.repo.getResourceClaim(f.order.id, 'domain', f.order.domain).remote_id, `mail-${f.order.id}`);
  f.repo.releaseLease(f.order.id, 'replacement');
});

test('billing revocation blocks the processor and completion', async () => {
  const f = fixture(); ready(f); const t = transports(f);
  db.prepare("UPDATE users SET xpay_subscription_status='CANCELLED' WHERE id=?").run(f.userId);
  await createSmtpProcessor(t.deps).processOrder(f.order.id);
  assert.equal(f.repo.getOrder(f.order.id).error_code, 'BILLING_REQUIRED');
  assert.equal(t.counts.domains, 0);
  f.repo.acquireLease(f.order.id, 'complete');
  f.repo.updateOrder(f.order.id, { status: 'processing' }, 'complete');
  assert.throws(() => f.repo.completeOrder(f.order.id, 'complete'), { code: 'BILLING_REQUIRED' });
  assert.equal(f.repo.getUser(f.userId).inboxes_used, 0);
});

test('download allowance shares Microsoft and SMTP ledger and does not reset on repeat or new order', () => {
  const f = fixture();
  const access = { canAccessApp: true, canDownloadAll: false, downloadAllowance: 10 };
  const microsoft = Array.from({ length: 8 }, (_, i) => ({ email: `ms${i}@example.test`, password: 'synthetic' }));
  const smtp = Array.from({ length: 4 }, (_, i) => ({ email: `smtp${i}@example.test`, password: 'synthetic' }));
  assert.equal(f.repo.selectCredentialRowsForAllowance(f.userId, 'microsoft', microsoft, access).length, 8);
  const allowed = f.repo.selectCredentialRowsForAllowance(f.userId, 'smtp', smtp, access);
  assert.equal(allowed.length, 2);
  assert.deepEqual(f.repo.selectCredentialRowsForAllowance(f.userId, 'smtp', smtp, access), allowed);
  f.repo.createDraft(f.userId, `another-${f.userId}.example.test`);
  assert.equal(f.repo.selectCredentialRowsForAllowance(f.userId, 'smtp', [{ email: 'new@example.test' }], access).length, 0);
  assert.equal(f.repo.selectCredentialRowsForAllowance(f.userId, 'smtp', smtp, { ...access, canAccessApp: false }).length, 0);
});

test('mailbox creation race cannot be adopted even when the adapter returns a saved credential', async () => {
  const f = fixture(); ready(f); const t = transports(f);
  f.repo.updateOrder(f.order.id, { resend_domain_id: 'resend-domain' });
  t.mailInfrastructure.ensureMailbox = async email => ({ id: 'foreign', created: false, credentialRef: `mailbox:${email}` });
  await createSmtpProcessor(t.deps).processOrder(f.order.id);
  assert.equal(f.repo.getOrder(f.order.id).error_code, 'DOMAIN_UNAVAILABLE');
  assert.equal(f.repo.getMailboxes(f.order.id)[0].credential_ref, null);
  assert.equal(f.repo.getUser(f.userId).inboxes_used, 0);
});

test('a resource receipt cannot bind credentials from another mailbox', () => {
  const f = fixture(); ready(f);
  f.repo.acquireLease(f.order.id, 'worker');
  const email = `alice@${f.order.domain}`;
  f.repo.beginResourceCreation(f.order.id, 'mailbox', email, 'worker');
  assert.throws(() => f.repo.recordResourceCreation(f.order.id, 'mailbox', email, 'worker', {
    created: true, remoteId: 'ours', credentialRef: 'mailbox:other@example.test',
  }), { code: 'DOMAIN_UNAVAILABLE' });
});

test('rate-limited preparation is scheduled and resumes after restart', async () => {
  const f = fixture(); const t = transports(f);
  const factory = t.deps.resendFactory;
  let limited = true;
  t.deps.resendFactory = key => ({ ...factory(key), ensureDomain: async () => {
    if (limited) { limited = false; throw Object.assign(new Error('limited'), { code: 'RESEND_RATE_LIMIT', retryAfterMs: 120000 }); }
    return factory(key).ensureDomain();
  } });
  const before = Date.now();
  await createSmtpProcessor(t.deps).prepareOrder(f.order.id);
  const paused = f.repo.getOrder(f.order.id);
  assert.equal(paused.status, 'draft');
  assert.equal(paused.error_code, 'RESEND_RATE_LIMITED');
  assert.ok(paused.due_at >= before + 120000);
  db.prepare('UPDATE smtp_orders SET due_at=0 WHERE id=?').run(f.order.id);
  await createSmtpProcessor(t.deps).tick();
  assert.equal(f.repo.getOrder(f.order.id).status, 'pending_nameservers');
  assert.equal(f.repo.getOrder(f.order.id).attempt_count, 0);
});

test('SMTP start shares the concurrency limit with a processing Microsoft order', () => {
  const f = fixture();
  f.repo.reserveMailboxes(f.order.id, f.userId, ['alice']);
  f.repo.updateOrder(f.order.id, { status: 'ready', nameservers_connected: 1, cloudflare_zone_id: 'zone' });
  const tenant = Number(db.prepare(`INSERT INTO tenants(user_id,name,domain,admin_email,admin_password)
    VALUES(?,'Test',?,'admin@example.test','x')`).run(f.userId, `busy-${f.userId}.example.test`).lastInsertRowid);
  db.prepare("INSERT INTO orders(tenant_id,user_id,total_mailboxes,status) VALUES(?,?,1,'processing')").run(tenant, f.userId);
  assert.throws(() => f.repo.startOrder(f.order.id, f.userId, { maxConcurrentOrders: Infinity }), { code: 'ORDER_CONCURRENCY_LIMIT' });
});

function expireClaim(order) {
  db.prepare("UPDATE smtp_domain_claims SET created_at=datetime('now','-25 hours') WHERE order_id=?").run(order.id);
}

test('expired unverified owners cannot renew, reserve, start, prepare, or mark nameservers ready', async () => {
  const f = fixture(); const t = transports(f);
  f.repo.reserveMailboxes(f.order.id, f.userId, ['alice']);
  await createSmtpProcessor(t.deps).prepareOrder(f.order.id);
  expireClaim(f.order);
  const deadline = f.repo.getDomainClaim(f.order.domain).created_at;
  assert.throws(() => f.repo.createDraft(f.userId, f.order.domain), { code: 'DOMAIN_UNAVAILABLE' });
  assert.equal(f.repo.getDomainClaim(f.order.domain).created_at, deadline);
  assert.throws(() => f.repo.reserveMailboxes(f.order.id, f.userId, ['bob']), { code: 'DOMAIN_UNAVAILABLE' });
  assert.throws(() => f.repo.startOrder(f.order.id, f.userId, {}), { code: 'DOMAIN_UNAVAILABLE' });
  assert.throws(() => f.repo.updateOrder(f.order.id, { nameservers_connected: 1, status: 'ready' }), { code: 'DOMAIN_UNAVAILABLE' });
  f.repo.acquireLease(f.order.id, 'check');
  assert.throws(() => f.repo.assertOwnership(f.order.id, 'check'), { code: 'DOMAIN_UNAVAILABLE' });
  f.repo.releaseLease(f.order.id, 'check');
  const counts = { ...t.counts };
  await createSmtpProcessor(t.deps).prepareOrder(f.order.id);
  assert.deepEqual(t.counts, counts);
  assert.equal(f.repo.getOrder(f.order.id).nameservers_connected, 0);
});

test('expired prepared draft transfers only positive app zone receipt and isolates customer Resend state', async () => {
  const old = fixture(); const replacement = fixture(); const t = transports(old);
  old.repo.reserveMailboxes(old.order.id, old.userId, ['alice']);
  await createSmtpProcessor(t.deps).prepareOrder(old.order.id);
  old.repo.updateOrder(old.order.id, { resend_domain_id: 'old-customer-resend' });
  expireClaim(old.order);
  const fresh = old.repo.createDraft(replacement.userId, old.order.domain);
  assert.notEqual(fresh.id, old.order.id);
  assert.equal(fresh.cloudflare_zone_id, `zone-${old.order.id}`);
  assert.equal(fresh.resend_domain_id, null);
  assert.equal(fresh.required_dns, '[]');
  assert.equal(fresh.nameservers_connected, 0);
  assert.equal(old.repo.getResourceClaim(old.order.id, 'zone', old.order.domain), undefined);
  assert.equal(old.repo.getResourceClaim(fresh.id, 'zone', old.order.domain).remote_id, `zone-${old.order.id}`);
  assert.equal(old.repo.getOrder(old.order.id).status, 'cancelled');
  assert.equal(old.repo.getOrder(old.order.id).reserved_inboxes, 0);
  assert.equal(old.repo.getOrder(old.order.id).resend_domain_id, 'old-customer-resend');
  assert.throws(() => old.repo.startOrder(old.order.id, old.userId, {}), { code: 'DOMAIN_UNAVAILABLE' });
  const deps = { ...t.deps, resendFactory: () => ({
    ensureDomain: async domain => ({ id: 'new-customer-resend', name: domain, status: 'verified', records: [] }),
    getDomain: async () => { throw new Error('Must not read the old customer Resend domain'); },
  }) };
  await createSmtpProcessor(deps).prepareOrder(fresh.id);
  assert.equal(old.repo.getOrder(fresh.id).resend_domain_id, 'new-customer-resend');
  assert.equal(t.counts.zones, 1);
  old.repo.reserveMailboxes(fresh.id, replacement.userId, ['alice']);
  assert.equal(old.repo.getMailboxes(fresh.id)[0].email, `alice@${old.order.domain}`);
});

test('unknown zone intent and live draft lease block reclaim; late positive receipt can be reclaimed', () => {
  const old = fixture(); const replacement = fixture();
  old.repo.acquireLease(old.order.id, 'old-worker');
  old.repo.beginResourceCreation(old.order.id, 'zone', old.order.domain, 'old-worker');
  expireClaim(old.order);
  assert.throws(() => old.repo.createDraft(replacement.userId, old.order.domain), { code: 'DOMAIN_UNAVAILABLE' });
  old.repo.releaseLease(old.order.id, 'old-worker');
  assert.throws(() => old.repo.createDraft(replacement.userId, old.order.domain), { code: 'DOMAIN_UNAVAILABLE' });
  assert.equal(old.repo.getDomainClaim(old.order.domain).order_id, old.order.id);
  old.repo.recordResourceCreation(old.order.id, 'zone', old.order.domain, 'old-worker', { created: true, remoteId: 'confirmed-zone' });
  const fresh = old.repo.createDraft(replacement.userId, old.order.domain);
  assert.equal(fresh.cloudflare_zone_id, 'confirmed-zone');
  assert.equal(old.repo.getResourceClaim(fresh.id, 'zone', old.order.domain).operation_token, 'old-worker');
});

test('verified, started, and mail-resource-bearing orders cannot be reclaimed by another owner', () => {
  for (const kind of ['verified','started','domain','mailbox']) {
    const old = fixture(); const replacement = fixture();
    old.repo.reserveMailboxes(old.order.id, old.userId, ['alice']);
    if (kind === 'verified') old.repo.updateOrder(old.order.id, { nameservers_connected: 1 });
    if (kind === 'started') old.repo.updateOrder(old.order.id, { started_at: '2026-01-01' });
    if (kind === 'domain' || kind === 'mailbox') {
      old.repo.acquireLease(old.order.id, 'intent');
      old.repo.beginResourceCreation(old.order.id, kind, kind === 'mailbox' ? `alice@${old.order.domain}` : old.order.domain, 'intent');
      old.repo.releaseLease(old.order.id, 'intent');
    }
    expireClaim(old.order);
    assert.throws(() => old.repo.createDraft(replacement.userId, old.order.domain), { code: 'DOMAIN_UNAVAILABLE' });
    assert.equal(old.repo.getDomainClaim(old.order.domain).order_id, old.order.id);
  }
});

test('expired lease blocks stale readiness and positive zone response still persists its receipt', async () => {
  const f = fixture(); const t = transports(f);
  const ensure = t.dns.ensureSmtpZone;
  t.dns.ensureSmtpZone = async () => {
    const result = await ensure();
    expireClaim(f.order);
    return result;
  };
  await createSmtpProcessor(t.deps).prepareOrder(f.order.id);
  assert.equal(f.repo.getOrder(f.order.id).nameservers_connected, 0);
  assert.equal(f.repo.getOrder(f.order.id).status, 'failed');
  assert.ok(f.repo.getResourceClaim(f.order.id, 'zone', f.order.domain).remote_id);
});

test('stopped orders with no mailbox attempts release all quota even after DNS/domain side effects', () => {
  const f = fixture(); ready(f, ['alice','bob','carol']);
  f.repo.acquireLease(f.order.id, 'worker');
  f.repo.beginResourceCreation(f.order.id, 'domain', f.order.domain, 'worker');
  f.repo.recordResourceCreation(f.order.id, 'domain', f.order.domain, 'worker', { created: true, remoteId: 'domain' });
  f.repo.cancelOrder(f.order.id, f.userId);
  assert.equal(f.repo.getOrder(f.order.id).reserved_inboxes, 3);
  f.repo.releaseLease(f.order.id, 'worker');
  assert.equal(f.repo.getOrder(f.order.id).reserved_inboxes, 0);
  assert.equal(f.repo.getMailboxes(f.order.id).length, 3);
  db.prepare('UPDATE users SET inboxes_used=98 WHERE id=?').run(f.userId);
  assert.throws(() => f.repo.startOrder(f.order.id, f.userId, {}), { code: 'INBOX_LIMIT_REACHED' });
  assert.equal(f.repo.getOrder(f.order.id).reserved_inboxes, 0);
  db.prepare('UPDATE users SET inboxes_used=97 WHERE id=?').run(f.userId);
  assert.equal(f.repo.startOrder(f.order.id, f.userId, {}).reserved_inboxes, 3);
});

test('cancelled lease drain keeps confirmed and ambiguous mailbox attempts but releases untouched rows', () => {
  const f = fixture(); ready(f, ['confirmed','unknown','untouched']);
  f.repo.acquireLease(f.order.id, 'worker');
  for (const name of ['confirmed','unknown']) f.repo.beginResourceCreation(f.order.id, 'mailbox', `${name}@${f.order.domain}`, 'worker');
  f.repo.recordResourceCreation(f.order.id, 'mailbox', `confirmed@${f.order.domain}`, 'worker', {
    created: true, remoteId: 'mailbox', credentialRef: `mailbox:confirmed@${f.order.domain}`,
  });
  f.repo.cancelOrder(f.order.id, f.userId);
  assert.equal(f.repo.getOrder(f.order.id).reserved_inboxes, 3);
  assert.equal(f.repo.releaseLease(f.order.id, 'wrong-token'), false);
  assert.equal(f.repo.getOrder(f.order.id).reserved_inboxes, 3);
  f.repo.releaseLease(f.order.id, 'worker');
  assert.equal(f.repo.getOrder(f.order.id).reserved_inboxes, 2);
  assert.equal(f.repo.getMailboxes(f.order.id).length, 3);
  db.prepare('UPDATE users SET inboxes_used=98 WHERE id=?').run(f.userId);
  assert.throws(() => f.repo.startOrder(f.order.id, f.userId, {}), { code: 'INBOX_LIMIT_REACHED' });
});

test('worker restart releases never-created quota after a cancelled lease expires', async () => {
  const f = fixture(); ready(f, ['alice','bob']);
  f.repo.acquireLease(f.order.id, 'crashed');
  f.repo.cancelOrder(f.order.id, f.userId);
  assert.equal(f.repo.getOrder(f.order.id).reserved_inboxes, 2);
  db.prepare('UPDATE smtp_orders SET lease_until=0 WHERE id=?').run(f.order.id);
  const t = transports(f);
  await createSmtpProcessor(t.deps).tick();
  assert.equal(f.repo.getOrder(f.order.id).reserved_inboxes, 0);
  assert.equal(f.repo.getOrder(f.order.id).status, 'cancelled');
});

test('restart of an expired cancelled lease cannot undercount a later Microsoft reservation', () => {
  const f = fixture(); ready(f, ['alice','bob']);
  f.repo.acquireLease(f.order.id, 'crashed');
  f.repo.cancelOrder(f.order.id, f.userId);
  db.prepare('UPDATE smtp_orders SET lease_until=0 WHERE id=?').run(f.order.id);
  const tenant = Number(db.prepare(`INSERT INTO tenants(user_id,name,domain,admin_email,admin_password)
    VALUES(?,'Test',?,'admin@example.test','x')`).run(f.userId, `retry-ms-${f.userId}.example.test`).lastInsertRowid);
  const microsoftId = Number(db.prepare("INSERT INTO orders(tenant_id,user_id,total_mailboxes,status) VALUES(?,?,99,'pending')")
    .run(tenant, f.userId).lastInsertRowid);
  assert.equal(f.repo.getOrder(f.order.id).reserved_inboxes, 2);
  assert.throws(() => f.repo.startOrder(f.order.id, f.userId, {}), { code: 'INBOX_LIMIT_REACHED' });
  assert.equal(f.repo.getOrder(f.order.id).status, 'cancelled');
  db.prepare('UPDATE orders SET total_mailboxes=98 WHERE id=?').run(microsoftId);
  assert.equal(f.repo.startOrder(f.order.id, f.userId, {}).reserved_inboxes, 2);
});

test('Microsoft onboarding reclaims an expired prepared draft but protects live and verified claims', () => {
  const old = fixture();
  old.repo.reserveMailboxes(old.order.id, old.userId, ['alice']);
  old.repo.acquireLease(old.order.id, 'setup');
  old.repo.beginResourceCreation(old.order.id, 'zone', old.order.domain, 'setup');
  old.repo.recordResourceCreation(old.order.id, 'zone', old.order.domain, 'setup', { created: true, remoteId: 'shared-zone' });
  old.repo.releaseLease(old.order.id, 'setup');
  old.repo.updateOrder(old.order.id, { cloudflare_zone_id: 'shared-zone', status: 'pending_nameservers', resend_domain_id: 'old-resend' });
  expireClaim(old.order);
  const tenant = { user_id: old.userId, name: 'Microsoft', domain: old.order.domain,
    admin_email: `admin@${old.order.domain}`, admin_password: 'SyntheticPassword!' };
  assert.ok(createTenant(tenant).lastInsertRowid);
  assert.equal(old.repo.getDomainClaim(old.order.domain), undefined);
  assert.equal(old.repo.getOrder(old.order.id).status, 'cancelled');
  assert.equal(old.repo.getOrder(old.order.id).reserved_inboxes, 0);
  assert.equal(old.repo.getOrder(old.order.id).resend_domain_id, 'old-resend');
  assert.equal(old.repo.getResourceClaim(old.order.id, 'zone', old.order.domain).remote_id, 'shared-zone');
  assert.equal(old.repo.getMailboxes(old.order.id).length, 0);
  for (const protection of ['unexpired', 'live-lease', 'verified']) {
    const f = fixture();
    if (protection === 'live-lease') { f.repo.acquireLease(f.order.id, 'live'); expireClaim(f.order); }
    if (protection === 'verified') { f.repo.updateOrder(f.order.id, { nameservers_connected: 1 }); expireClaim(f.order); }
    assert.throws(() => createTenant({ ...tenant, user_id: f.userId, domain: f.order.domain }), { code: 'DOMAIN_UNAVAILABLE' });
    assert.equal(f.repo.getDomainClaim(f.order.domain).order_id, f.order.id);
  }
});

test('cancelled mailbox creation saves late receipt and reserves just that mailbox', async () => {
  const f = fixture(); ready(f, ['alice','bob']); const t = transports(f);
  f.repo.updateOrder(f.order.id, { resend_domain_id: 'resend-domain' });
  const ensure = t.mailInfrastructure.ensureMailbox;
  t.mailInfrastructure.ensureMailbox = async email => {
    const result = await ensure(email);
    f.repo.cancelOrder(f.order.id, f.userId);
    return result;
  };
  await createSmtpProcessor(t.deps).processOrder(f.order.id);
  assert.equal(f.repo.getOrder(f.order.id).status, 'cancelled');
  assert.equal(f.repo.getOrder(f.order.id).reserved_inboxes, 1);
  assert.ok(f.repo.getResourceClaim(f.order.id, 'mailbox', `alice@${f.order.domain}`).remote_id);
  assert.equal(f.repo.getMailboxes(f.order.id).length, 2);
});

test('SMTP connection secrets are isolated by user and stored with restrictive permissions', async () => {
  const location = join(directory, 'isolated-secrets');
  const store = new FileSecretStore(location);
  const aliceKey = 'resend:user:101:api-key';
  const bobKey = 'resend:user:102:api-key';
  await store.set(aliceKey, 'synthetic-alice-key');
  await store.set(bobKey, 'synthetic-bob-key');
  assert.equal(await store.get(aliceKey), 'synthetic-alice-key');
  assert.equal(await store.get(bobKey), 'synthetic-bob-key');
  assert.equal((await stat(location)).mode & 0o777, 0o700);
  const files = await readdir(location);
  assert.equal(files.length, 2);
  for (const filename of files) {
    assert.match(filename, /^[a-f0-9]{64}$/);
    assert.equal((await stat(join(location, filename))).mode & 0o777, 0o600);
  }
});

test('disconnect deletes only the requested user secret and deletion is idempotent', async () => {
  const store = new FileSecretStore(join(directory, 'disconnect-secrets'));
  await store.set('resend:user:201:api-key', 'synthetic-alice-key');
  await store.set('resend:user:202:api-key', 'synthetic-bob-key');
  await store.delete('resend:user:201:api-key');
  await store.delete('resend:user:201:api-key');
  assert.equal(await store.get('resend:user:201:api-key'), null);
  assert.equal(await store.get('resend:user:202:api-key'), 'synthetic-bob-key');
});

test('secret reads and deletes never follow a substituted symlink', async () => {
  const store = new FileSecretStore(join(directory, 'symlink-secrets'));
  await store.prepare();
  const sentinel = join(directory, 'unrelated-file');
  await writeFile(sentinel, 'unrelated-content', { mode: 0o600 });
  await symlink(sentinel, store.filePath('resend:user:301:api-key'));
  await assert.rejects(store.get('resend:user:301:api-key'));
  try { await store.delete('resend:user:301:api-key'); } catch { /* Refusing a symlink is also safe. */ }
  assert.equal(await readFile(sentinel, 'utf8'), 'unrelated-content');
});
