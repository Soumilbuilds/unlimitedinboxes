import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileSecretStore } from '../services/fileSecretStore.js';
import { StalwartMailboxProvider } from '../services/stalwartMailboxProvider.js';
import { parseOptions, provision } from '../../ops/stalwart/provision-mailboxes.mjs';
import {
  buildManyreachSenderPayload, buildManyreachSenderCsv, writeManyreachSenderCsvFile,
} from '../services/manyreachSenderExport.js';

function fakeStalwart(pageCap = 100) {
  const domains = new Map();
  const accounts = new Map();
  const calls = [];
  let nextId = 1;
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://mail.example.test/jmap/');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.using, ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap']);
    const [method, args, callId] = body.methodCalls[0];
    calls.push({ method, args });
    const objects = method.includes('Domain') ? domains : accounts;
    let result;
    if (method.endsWith('/query')) {
      const matching = [...objects.values()].filter(item =>
        Object.entries(args.filter || {}).every(([key, value]) => item[key] === value));
      result = { ids: matching.slice(args.position, args.position + Math.min(args.limit, pageCap)).map(item => item.id), total: matching.length };
    } else if (method.endsWith('/get')) {
      result = { list: args.ids.map(id => objects.get(id)).filter(Boolean) };
    } else if (method.endsWith('/set') && args.create) {
      const data = args.create.new1;
      const id = String(nextId++);
      const domain = [...domains.values()].find(item => item.id === data.domainId)?.name;
      objects.set(id, { id, ...data, ...(method.includes('Account') ? { emailAddress: `${data.name}@${domain}` } : {}) });
      result = { created: { new1: { id } } };
    } else if (method.endsWith('/set') && args.update) {
      const id = Object.keys(args.update)[0];
      const prior = objects.get(id);
      if (prior) {
        const patch = args.update[id];
        const passwordPatch = Object.entries(patch).find(([key]) => /^credentials\/\d+\/secret$/.test(key));
        if (passwordPatch) {
          const credentialId = passwordPatch[0].split('/')[1];
          prior.credentials[credentialId].secret = passwordPatch[1];
        } else {
          objects.set(id, { ...prior, ...patch });
        }
      }
      result = prior ? { updated: { [id]: null } } : { notUpdated: { [id]: { type: 'notFound' } } };
    } else {
      throw new Error('Unexpected operation in test');
    }
    return { ok: true, json: async () => ({ methodResponses: [[method, result, callId]] }) };
  };
  return { domains, accounts, calls, fetchImpl };
}

async function fixture(fn, pageCap) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'stalwart-test-'));
  try {
    const secretStore = new FileSecretStore(directory);
    const fake = fakeStalwart(pageCap);
    const provider = new StalwartMailboxProvider({
      baseUrl: 'https://mail.example.test', token: 'test-token', secretStore,
      fetchImpl: fake.fetchImpl,
    });
    await fn({ directory, secretStore, provider, ...fake });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('ensures domains and mailboxes once and excludes the bootstrap administrator', async () => fixture(async ({ provider, calls, accounts, secretStore }) => {
  const first = await provider.ensureMailbox('  Alice@Example.Test  ');
  const second = await provider.ensureMailbox('alice@example.test');
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.id, second.id);
  assert.deepEqual(await provider.listDomains(), [{ id: '1', name: 'example.test', isEnabled: true }]);
  assert.deepEqual(await provider.getDomain('other.example.test'), null);
  accounts.set('admin', { id: 'admin', '@type': 'User', name: 'admin', domainId: '1',
    emailAddress: 'admin@example.test', roles: { '@type': 'Admin' } });
  assert.equal((await provider.listMailboxes('example.test')).length, 1);
  assert.equal((await provider.getMailbox('alice@example.test')).id, first.id);
  assert.equal(await provider.getMailbox('bob@example.test'), null);
  await assert.rejects(provider.getMailbox('admin@example.test'), /not a managed mailbox/);
  await assert.rejects(provider.ensureMailbox('admin@example.test'), /not a managed mailbox/);
  assert.equal(calls.filter(call => call.method === 'x:Domain/set').length, 1);
  assert.equal(calls.filter(call => call.method === 'x:Account/set' && call.args.create).length, 1);
  assert.equal(calls.some(call => call.args.destroy), false);
  const stored = await secretStore.get('mailbox:alice@example.test');
  assert.equal(stored.length >= 32, true);
  assert.equal(accounts.get(first.id).credentials['0'].secret === stored, true);
}));

test('provisions two domains with manual DKIM and full email addresses without repeating creates or exposing secrets', async () => fixture(async ({ provider, calls, accounts, secretStore }) => {
  const { domains, localParts } = parseOptions(['--dry-run']);
  const output = [];
  const run = () => provision({ provider, domains, localParts, write: text => output.push(text) });
  await run();
  await run();
  assert.equal(domains.length, 2);
  assert.equal(localParts.length, 5);
  assert.equal(calls.filter(call => call.method === 'x:Domain/set').length, 2);
  assert.equal(calls.filter(call => call.method === 'x:Account/set' && call.args.create).length, 10);
  const expectedEmails = new Set(domains.flatMap(domain => localParts.map(local => `${local}@${domain}`)));
  for (const call of calls.filter(call => call.method === 'x:Domain/set')) {
    assert.deepEqual(call.args.create.new1.dkimManagement, { '@type': 'Manual' });
    assert.deepEqual(call.args.create.new1.dnsManagement, { '@type': 'Manual' });
    assert.deepEqual(call.args.create.new1.certificateManagement, { '@type': 'Manual' });
  }
  for (const account of accounts.values()) {
    assert.equal(expectedEmails.has(account.emailAddress), true);
    assert.equal((await provider.getMailbox(account.emailAddress)).email, account.emailAddress);
    assert.equal(account.name.includes('@'), false);
    assert.equal(output.join('').includes(await secretStore.get(`mailbox:${account.emailAddress}`)), false);
  }
  assert.equal(output.filter(line => line.includes(': Created')).length, 12);
  assert.equal(output.filter(line => line.includes(': Existing')).length, 12);
  assert.equal(output.some(line => line.includes('stacy@taloperations.com')), true);
  assert.equal(output.some(line => line.includes('mia@talcollectiveco.com')), true);
}));

test('keeps the provider default DKIM mode for other callers and validates the override', async () => fixture(async ({ provider, calls }) => {
  await provider.ensureDomain('example.test');
  assert.deepEqual(calls.find(call => call.method === 'x:Domain/set').args.create.new1.dkimManagement, { '@type': 'Automatic' });
  await assert.rejects(provider.ensureDomain('another.test', { dkimManagement: 'Invalid' }), /Invalid DKIM management mode/);
}));

test('persists the mailbox password before Account/set and recovers after a lost response', async () => fixture(async ({
  provider, secretStore, fetchImpl, calls, accounts,
}) => {
  const order = [];
  const trackingStore = {
    get: key => secretStore.get(key),
    set: async (key, value) => {
      order.push('stored');
      await secretStore.set(key, value);
    },
  };
  let interrupt = true;
  const interruptedFetch = async (url, options) => {
    const [method, args] = JSON.parse(options.body).methodCalls[0];
    if (method === 'x:Account/set' && args.create) {
      order.push('remote');
      const staged = await secretStore.get('mailbox:alice@example.test');
      assert.equal(Boolean(staged), true);
      assert.equal(args.create.new1.credentials['0'].secret === staged, true);
      const response = await fetchImpl(url, options);
      if (interrupt) {
        interrupt = false;
        throw new Error('Simulated lost response');
      }
      return response;
    }
    return fetchImpl(url, options);
  };
  const retriedProvider = new StalwartMailboxProvider({
    baseUrl: 'https://mail.example.test', token: 'test-token',
    secretStore: trackingStore, fetchImpl: interruptedFetch,
  });
  await assert.rejects(retriedProvider.ensureMailbox('alice@example.test'), /Stalwart request failed/);
  const retried = await retriedProvider.ensureMailbox('alice@example.test');
  assert.equal(retried.created, false);
  assert.deepEqual(order, ['stored', 'remote']);
  assert.equal(calls.filter(call => call.method === 'x:Account/set' && call.args.create).length, 1);
  assert.equal(accounts.get(retried.id).credentials['0'].secret === await secretStore.get('mailbox:alice@example.test'), true);
  assert.equal((await provider.getMailbox('alice@example.test')).id, retried.id);
}));

test('retries a failed create with the staged password', async () => fixture(async ({
  secretStore, fetchImpl, accounts, calls,
}) => {
  let writes = 0;
  let interrupt = true;
  const provider = new StalwartMailboxProvider({
    baseUrl: 'https://mail.example.test', token: 'test-token',
    secretStore: {
      get: key => secretStore.get(key),
      set: async (key, value) => { writes += 1; await secretStore.set(key, value); },
    },
    fetchImpl: async (url, options) => {
      const [method, args] = JSON.parse(options.body).methodCalls[0];
      if (method === 'x:Account/set' && args.create && interrupt) {
        interrupt = false;
        throw new Error('Simulated interruption before create');
      }
      return fetchImpl(url, options);
    },
  });
  await assert.rejects(provider.ensureMailbox('alice@example.test'), /Stalwart request failed/);
  assert.equal(Boolean(await secretStore.get('mailbox:alice@example.test')), true);
  await assert.rejects(provider.ensureMailbox('alice@example.test', { password: 'DifferentPassword123!' }), /already staged/);
  const created = await provider.ensureMailbox('alice@example.test');
  assert.equal(created.created, true);
  assert.equal(writes, 1);
  assert.equal(calls.filter(call => call.method === 'x:Account/set' && call.args.create).length, 1);
  assert.equal(accounts.get(created.id).credentials['0'].secret === await secretStore.get('mailbox:alice@example.test'), true);
}));

test('an existing mailbox with no stored credential reports unavailable without rotation', async () => fixture(async ({
  directory, provider, fetchImpl, calls,
}) => {
  await provider.ensureMailbox('alice@example.test');
  const otherStore = new FileSecretStore(path.join(directory, 'empty-secrets'));
  const retryProvider = new StalwartMailboxProvider({
    baseUrl: 'https://mail.example.test', token: 'test-token',
    secretStore: otherStore, fetchImpl,
  });
  const writesBefore = calls.filter(call => call.method === 'x:Account/set').length;
  await assert.rejects(retryProvider.ensureMailbox('alice@example.test'), /Mailbox credential is unavailable/);
  assert.equal(calls.filter(call => call.method === 'x:Account/set').length, writesBefore);
}));

test('a failed secret write prevents remote account creation', async () => fixture(async ({ fetchImpl, calls }) => {
  const provider = new StalwartMailboxProvider({
    baseUrl: 'https://mail.example.test', token: 'test-token',
    secretStore: { get: async () => null, set: async () => { throw new Error('Secret store unavailable'); } },
    fetchImpl,
  });
  await assert.rejects(provider.ensureMailbox('alice@example.test'), /Secret store unavailable/);
  assert.equal(calls.some(call => call.method === 'x:Account/set'), false);
}));

test('rotates a password and updates the file-backed secret only after success', async () => fixture(async ({ provider, secretStore, calls, accounts }) => {
  const mailbox = await provider.ensureMailbox('alice@example.test');
  const previous = await secretStore.get('mailbox:alice@example.test');
  accounts.get(mailbox.id).credentials['1'] = { '@type': 'AppPassword', description: 'Existing Client' };
  await provider.rotatePassword('alice@example.test');
  const current = await secretStore.get('mailbox:alice@example.test');
  assert.equal(current !== previous, true);
  assert.equal(accounts.get(mailbox.id).credentials['0'].secret === current, true);
  assert.equal(accounts.get(mailbox.id).credentials['1'].description, 'Existing Client');
  const update = calls.find(call => call.method === 'x:Account/set' && call.args.update);
  assert.equal(update.args.update[mailbox.id]['credentials/0/secret'] === current, true);
  assert.equal(calls.some(call => call.args.destroy), false);
}));

test('rotation patches the actual password credential ID', async () => fixture(async ({ provider, accounts, calls }) => {
  const mailbox = await provider.ensureMailbox('alice@example.test');
  const passwordCredential = accounts.get(mailbox.id).credentials['0'];
  accounts.get(mailbox.id).credentials = {
    '2': passwordCredential,
    '3': { '@type': 'AppPassword', description: 'Existing Client' },
  };
  await provider.rotatePassword('alice@example.test');
  const update = calls.find(call => call.method === 'x:Account/set' && call.args.update);
  assert.deepEqual(Object.keys(update.args.update[mailbox.id]), ['credentials/2/secret']);
  assert.equal(accounts.get(mailbox.id).credentials['3'].description, 'Existing Client');
}));

test('list pagination advances by returned page size', async () => fixture(async ({ provider, domains, calls }) => {
  domains.set('1', { id: '1', name: 'first.test' });
  domains.set('2', { id: '2', name: 'second.test' });
  domains.set('3', { id: '3', name: 'third.test' });
  assert.deepEqual((await provider.listDomains()).map(domain => domain.name), ['first.test', 'second.test', 'third.test']);
  assert.deepEqual(calls.filter(call => call.method === 'x:Domain/query').map(call => call.args.position), [0, 1, 2]);
}, 1));

test('file secrets have private names and permissions', async () => fixture(async ({ directory, secretStore }) => {
  await secretStore.set('mailbox:alice@example.test', 'synthetic-secret');
  assert.equal(await secretStore.get('mailbox:alice@example.test'), 'synthetic-secret');
  assert.equal(await secretStore.get('mailbox:missing@example.test'), null);
  const names = await readdir(directory);
  assert.equal(names.length, 1);
  assert.equal(names[0].includes('alice'), false);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(directory, names[0]))).mode & 0o777, 0o600);
}));

test('loads the Stalwart token through the secret store', async () => fixture(async ({ secretStore, fetchImpl }) => {
  await secretStore.set('stalwart:token', 'test-token');
  const provider = new StalwartMailboxProvider({
    baseUrl: 'https://mail.example.test', tokenSecretKey: 'stalwart:token',
    secretStore, fetchImpl,
  });
  assert.deepEqual(await provider.listDomains(), []);
  await assert.rejects(provider.ensureMailbox('alice@example.test', { password: '=bad-formula-secret' }), /Invalid mailbox password/);
}));

test('Manyreach uses a separate Resend SMTP secret and mailbox IMAP secret', async () => fixture(async ({ directory, provider, secretStore, calls }) => {
  await provider.ensureMailbox('alice@example.test');
  await secretStore.set('resend:api-key', 're_synthetic_test_key');
  const requestCount = calls.length;
  const payload = await buildManyreachSenderPayload({
    email: 'Alice@Example.Test', imapHost: 'mail.example.test', imapPort: 993, dailyLimit: 25,
  }, secretStore);
  assert.equal(payload.customSmtpServer, 'smtp.resend.com');
  assert.equal(payload.customSmtpPort, 465);
  assert.equal(payload.customSmtpUsername, 'resend');
  assert.equal(payload.customSmtpPass === await secretStore.get('resend:api-key'), true);
  assert.equal(payload.customImapPass === await secretStore.get('mailbox:alice@example.test'), true);
  assert.equal(payload.customImapPass !== payload.customSmtpPass, true);
  assert.equal(payload.customImapUsername, 'alice@example.test');
  assert.equal(payload.dailyLimit, 25);
  const csv = buildManyreachSenderCsv([payload]);
  assert.equal(csv.startsWith('email,dailyLimit,customSmtpServer'), true);
  assert.equal(csv.includes('"alice@example.test"'), true);
  const filename = path.join(directory, 'manyreach.credentials.csv');
  assert.equal(await writeManyreachSenderCsvFile(filename, [payload]), filename);
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.equal(await readFile(filename, 'utf8') === csv, true);
  await assert.rejects(writeManyreachSenderCsvFile(filename, [payload]), /already exists/);
  assert.equal(await readFile(filename, 'utf8') === csv, true);
  await assert.rejects(writeManyreachSenderCsvFile(path.join(directory, 'unsafe.csv'), [payload]), /\.credentials\.csv/);
  assert.equal(calls.length, requestCount);
  assert.throws(() => buildManyreachSenderCsv([{ ...payload, customSmtpPass: '=1+1' }]), /Unsafe CSV value/);
}));

test('Manyreach export fails when the separate Resend secret is missing', async () => fixture(async ({ provider, secretStore }) => {
  await provider.ensureMailbox('alice@example.test');
  await assert.rejects(buildManyreachSenderPayload({
    email: 'alice@example.test', imapHost: 'mail.example.test', imapPort: 993,
  }, secretStore), /Resend credential is unavailable/);
}));

test('rejects insecure URLs and hides Stalwart error details', async () => fixture(async ({ secretStore }) => {
  assert.throws(() => new StalwartMailboxProvider({
    baseUrl: 'http://mail.example.test', token: 'test-token', secretStore,
  }), /HTTPS or HTTP on IP loopback/);
  assert.throws(() => new StalwartMailboxProvider({
    baseUrl: 'http://localhost:18080', token: 'test-token', secretStore,
  }), /HTTPS or HTTP on IP loopback/);
  assert.equal(new StalwartMailboxProvider({
    baseUrl: 'http://127.0.0.1:18080', token: 'test-token', secretStore,
  }).endpoint, 'http://127.0.0.1:18080/jmap/');
  const provider = new StalwartMailboxProvider({
    baseUrl: 'https://mail.example.test', token: 'test-token', secretStore,
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ detail: 'sensitive' }) }),
  });
  await assert.rejects(provider.getDomain('example.test'), error =>
    error.message === 'Stalwart request failed (401)');
}));
