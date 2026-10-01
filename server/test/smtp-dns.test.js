import assert from 'node:assert/strict';
import test from 'node:test';
import { createSmtpDnsService, SmtpDnsError } from '../services/smtpDns.js';

const domain = 'example.test';
const zoneId = 'zone_test';
const nameServers = ['one.ns.cloudflare.com', 'two.ns.cloudflare.com'];
const spf = { type: 'TXT', name: '@', content: 'v=spf1 include:amazonses.com ~all' };
const diagnostic = 'PRIVATE_PROVIDER_BODY Authorization: Bearer synthetic-secret /opt/private';

// Stateful Cloudflare transport: verification reads see the actual effects of writes.
function fixture(initial = [], overrides = {}) {
  const records = structuredClone(initial);
  const writes = [];
  const reads = [];
  let nextId = 0;
  const cloudflare = {
    findZone: async () => ({ id: zoneId, name_servers: nameServers }),
    createZone: async () => ({ id: zoneId, name_servers: nameServers }),
    listDnsRecords: async (zone, options) => {
      assert.equal(zone, zoneId);
      reads.push(options);
      return structuredClone(records.filter(record => record.name === options.name)
        .slice((options.page - 1) * options.per_page, options.page * options.per_page));
    },
    addDnsRecord: async (zone, type, name, content, priority) => {
      assert.equal(zone, zoneId);
      const record = { id: `new_${++nextId}`, type, name, content, ...(priority === undefined ? {} : { priority }) };
      writes.push({ kind: 'add', record: structuredClone(record) });
      records.push(record);
    },
    updateDnsRecord: async (zone, id, record) => {
      assert.equal(zone, zoneId);
      const index = records.findIndex(item => item.id === id);
      assert.notEqual(index, -1);
      writes.push({ kind: 'update', id, record: structuredClone(record) });
      records[index] = { ...records[index], ...record };
    },
    ...overrides,
  };
  const service = createSmtpDnsService({ cloudflare, resolver: {}, fetchImpl: async () => { throw new Error('Unexpected public DNS lookup'); } });
  return { service, records, writes, reads, reconcile: records => service.reconcileSmtpDns({ domain, zoneId, records }) };
}

function safeError(code, status = 409) {
  return error => {
    assert.ok(error instanceof SmtpDnsError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.equal(error.message, error.publicMessage);
    assert.doesNotMatch(JSON.stringify({ ...error, message: error.message, stack: error.stack }), /PRIVATE_PROVIDER_BODY|synthetic-secret|\/opt\/private/);
    assert.equal(error.cause, undefined);
    assert.equal(error.response, undefined);
    return true;
  };
}

test('reconciliation preserves unrelated DNS and merges exactly one SPF in place, idempotently', async () => {
  const unrelated = [
    { id: 'web', type: 'A', name: domain, content: '192.0.2.10', ttl: 300 },
    { id: 'verification', type: 'TXT', name: domain, content: 'google-site-verification=keep-me' },
    { id: 'www', type: 'CNAME', name: `www.${domain}`, content: domain },
    { id: 'mx', type: 'MX', name: domain, content: 'mail.example.test', priority: 10 },
  ];
  const f = fixture([...unrelated, { id: 'spf', type: 'TXT', name: domain, content: '"v=spf1 " "include:legacy.example.test -all"' }]);
  const final = await f.reconcile([spf]);
  assert.deepEqual(f.records.filter(record => unrelated.some(item => item.id === record.id)), unrelated);
  const actualSpf = f.records.filter(record => /^v=spf1/.test(record.content));
  assert.equal(actualSpf.length, 1);
  assert.equal(actualSpf[0].id, 'spf');
  assert.equal(actualSpf[0].content, 'v=spf1 include:legacy.example.test include:amazonses.com -all');
  assert.equal(f.writes.filter(write => write.kind === 'update').length, 1);
  assert.ok(final.some(record => record.name === `_dmarc.${domain}`));
  const before = structuredClone(f.writes);
  await f.reconcile([spf]);
  assert.deepEqual(f.writes, before);
});

test('duplicate existing or requested SPF is rejected before any planned DNS write', async () => {
  for (const duplicateExisting of [true, false]) {
    const f = fixture(duplicateExisting ? [
      { id: 'spf1', type: 'TXT', name: domain, content: 'v=spf1 include:one.example.test ~all' },
      { id: 'spf2', type: 'TXT', name: domain, content: '"v=spf1 include:two.example.test -all"' },
    ] : []);
    await assert.rejects(f.reconcile([
      { type: 'TXT', name: 'resend._domainkey', content: 'p=synthetic-key' },
      spf,
      ...(duplicateExisting ? [] : [{ ...spf, content: 'v=spf1 include:other.example.test ~all' }]),
    ]), safeError('DNS_CONFLICT'));
    assert.deepEqual(f.writes, []);
  }
});

test('post-write duplicate SPF from a provider race cannot report success', async () => {
  const f = fixture();
  // Inject a competing provider write as soon as our SPF is stored.
  const original = f.records.push.bind(f.records);
  f.records.push = record => {
    const result = original(record);
    if (/^v=spf1/.test(record.content)) original({ ...record, id: 'competing-spf', content: 'v=spf1 -all' });
    return result;
  };
  await assert.rejects(f.reconcile([spf]), safeError('DNS_CONFLICT'));
});

test('stronger existing DMARC and reporting tags survive provisioning without a write', async () => {
  for (const policy of ['quarantine', 'reject']) {
    const record = { id: 'dmarc', type: 'TXT', name: `_dmarc.${domain}`, content: `v=DMARC1; p=${policy}; rua=mailto:reports@example.test; adkim=s; pct=100;` };
    const f = fixture([record]);
    assert.deepEqual(await f.reconcile([]), [{ type: 'TXT', name: record.name, content: record.content }]);
    assert.deepEqual(f.records, [record]);
    assert.deepEqual(f.writes, []);
  }
});

test('unsafe SPF merges, malformed DMARC, and conflicting MX or DKIM fail without writes', async () => {
  const cases = [
    [{ id: 'spf', type: 'TXT', name: domain, content: 'v=spf1 redirect=other.example.test' }, spf],
    [{ id: 'spf', type: 'TXT', name: domain, content: 'v=spf1 +all' }, spf],
    [{ id: 'dmarc', type: 'TXT', name: `_dmarc.${domain}`, content: 'v=DMARC1; p=reject; p=none;' }, spf],
    [{ id: 'mx', type: 'MX', name: domain, content: 'old.example.test', priority: 10 }, { type: 'MX', name: '@', content: 'new.example.test', priority: 10 }],
    [{ id: 'dkim', type: 'TXT', name: `resend._domainkey.${domain}`, content: 'p=old-key' }, { type: 'TXT', name: 'resend._domainkey', content: 'p=new-key' }],
    [{ id: 'alias', type: 'CNAME', name: `send.${domain}`, content: 'old.example.test' }, { type: 'TXT', name: 'send', content: 'v=spf1 ~all' }],
  ];
  for (const [existing, required] of cases) {
    const f = fixture([existing]);
    await assert.rejects(f.reconcile([{ type: 'TXT', name: 'early', content: 'would-be-added' }, required]), safeError('DNS_CONFLICT'));
    assert.deepEqual(f.writes, []);
  }
});

test('Resend DKIM, send-subdomain SPF and feedback MX reconcile and verify through injected public DNS', async () => {
  const f = fixture();
  const final = await f.reconcile([
    { type: 'TXT', name: 'resend._domainkey', value: 'p=synthetic-public-key' },
    { type: 'TXT', name: 'send', value: 'v=spf1 include:amazonses.com ~all' },
    { type: 'MX', name: 'send', value: 'feedback-smtp.us-east-1.amazonses.com.', priority: 10 },
  ]);
  assert.equal(final.length, 4);
  assert.equal(f.records.find(record => record.type === 'MX').priority, 10);
  const resolver = {
    resolveNs: async name => { assert.equal(name, domain); return [...nameServers].reverse().map(value => `${value.toUpperCase()}.`); },
    resolveTxt: async name => f.records.filter(record => record.name === name && record.type === 'TXT').map(record => [record.content.slice(0, 5), record.content.slice(5)]),
    resolveMx: async name => f.records.filter(record => record.name === name && record.type === 'MX').map(record => ({ exchange: `${record.content.toUpperCase()}.`, priority: record.priority })),
  };
  const service = createSmtpDnsService({ resolver, fetchImpl: async () => { throw new Error('Unexpected fallback'); } });
  assert.deepEqual(await service.verifySmtpDns({ domain, nameServers, records: final }), { ready: true, missing: [] });
  f.records.find(record => record.type === 'MX').priority = 20;
  f.records.push({ type: 'TXT', name: `send.${domain}`, content: 'v=spf1 -all' });
  assert.deepEqual(await service.verifySmtpDns({ domain, nameServers, records: final }), {
    ready: false, missing: [{ type: 'TXT', name: `send.${domain}` }, { type: 'MX', name: `send.${domain}` }],
  });
});

test('nameserver connection requires the actual exact delegation, not merely Cloudflare suffixes', async () => {
  for (const [actual, connected] of [
    [[`${nameServers[1].toUpperCase()}.`, `${nameServers[0]}.`], true],
    [['different.ns.cloudflare.com', nameServers[1]], false],
    [[nameServers[0]], false],
    [[...nameServers, 'extra.ns.cloudflare.com'], false],
    [['192.0.2.1', nameServers[1]], false],
  ]) {
    const service = createSmtpDnsService({ resolver: { resolveNs: async () => actual } });
    assert.equal((await service.checkSmtpNameservers({ domain, nameServers })).connected, connected);
  }
});

test('DoH fallback filters answer types and fails closed with safe output on upstream errors', async () => {
  let fail = false;
  const service = createSmtpDnsService({
    resolver: { resolveNs: async () => { throw new Error(diagnostic); } },
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).searchParams.get('type'), 'NS');
      assert.equal(options.redirect, 'error');
      if (fail) throw new Error(diagnostic);
      return { ok: true, json: async () => ({ Status: 0, Answer: [
        ...nameServers.map(data => ({ type: 2, data: `${data}.` })), { type: 5, data: 'unrelated.example.test' },
      ] }) };
    },
  });
  assert.equal((await service.checkSmtpNameservers({ domain, nameServers })).connected, true);
  fail = true;
  const result = await service.checkSmtpNameservers({ domain, nameServers });
  assert.equal(result.connected, false);
  assert.deepEqual(result.name_servers, []);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROVIDER_BODY|synthetic-secret/);
});

test('Cloudflare failures are sanitized and existing zones require an ownership match', async () => {
  const f = fixture();
  await assert.rejects(f.service.ensureSmtpZone(domain), safeError('DNS_ZONE_UNCLAIMED'));
  await assert.rejects(f.service.ensureSmtpZone(domain, { ownedZoneId: 'wrong' }), safeError('DNS_ZONE_UNCLAIMED'));
  assert.deepEqual(await f.service.ensureSmtpZone(domain, { ownedZoneId: zoneId }), { zoneId, nameServers, created: false, reused: true });
  for (const operation of ['findZone', 'listDnsRecords', 'addDnsRecord']) {
    const broken = fixture([], { [operation]: async () => { throw Object.assign(new Error(diagnostic), { response: { data: diagnostic } }); } });
    await assert.rejects(operation === 'findZone' ? broken.service.findSmtpZone(domain) : broken.reconcile([spf]), safeError('DNS_UNAVAILABLE', 502));
  }
});

test('pagination preserves all TXT records and a provider that drops writes fails verification', async () => {
  const unrelated = Array.from({ length: 100 }, (_, index) => ({ id: `txt_${index}`, type: 'TXT', name: domain, content: `verification-${index}` }));
  const f = fixture(unrelated);
  await f.reconcile([spf]);
  assert.deepEqual(f.records.slice(0, 100), unrelated);
  assert.ok(f.reads.some(read => read.name === domain && read.page === 2));
  const broken = fixture([], { addDnsRecord: async () => {} });
  await assert.rejects(broken.reconcile([spf]), safeError('DNS_UNAVAILABLE', 502));
});
