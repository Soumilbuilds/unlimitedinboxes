import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPublicKey } from 'node:crypto';
import { FileSecretStore } from '../services/fileSecretStore.js';
import { StalwartMailboxProvider } from '../services/stalwartMailboxProvider.js';
import { createMailInfrastructure } from '../services/mailInfrastructure.js';
import { buildSmtpCsv } from '../services/smtpCsv.js';

function memoryStore() {
  const values = new Map();
  return { values, get: async key => values.get(key) ?? null, set: async (key, value) => { values.set(key, value); } };
}

function fixture({ lost = false, fail = false } = {}) {
  const secretStore = memoryStore();
  const objects = { Domain: new Map(), Account: new Map(), DkimSignature: new Map() };
  let nextId = 1;
  let interrupted = false;
  const calls = [];
  const provider = new StalwartMailboxProvider({
    baseUrl: 'http://127.0.0.1:18080', token: 'synthetic-token', secretStore,
    fetchImpl: async (_url, options) => {
      const [method, args, tag] = JSON.parse(options.body).methodCalls[0];
      calls.push({ method, args });
      const type = method.split(':')[1].split('/')[0];
      const db = objects[type];
      let result;
      if (method.endsWith('/query')) {
        const all = [...db.values()].filter(item => Object.entries(args.filter).every(([k,v]) => item[k] === v));
        result = { total: all.length, ids: all.slice(args.position, args.position + args.limit).map(item => item.id) };
      } else if (method.endsWith('/get')) {
        result = { list: args.ids.map(id => db.get(id)).filter(Boolean) };
      } else if (method.endsWith('/set')) {
        if (fail && type === 'DkimSignature') return { ok: false, status: 403 };
        const id = String(nextId++);
        const item = { ...args.create.new1, id };
        if (type === 'DkimSignature') {
          const staged = JSON.parse(await secretStore.get(`smtp:dkim:example.test:key`));
          assert.deepEqual(item.privateKey, { '@type': 'Text', secret: staged.privateKey });
          item.publicKey = createPublicKey(item.privateKey.secret).export({ type: 'spki', format: 'der' }).toString('base64');
        }
        db.set(id, item);
        result = { created: { new1: { id } } };
        if (lost && type === 'DkimSignature' && !interrupted) { interrupted = true; throw new Error('Lost provider response'); }
      }
      return { ok: true, json: async () => ({ methodResponses: [[method,result,tag]] }) };
    },
  });
  return { provider, secretStore, objects, calls };
}

const config = { publicHost: 'mail.example.test', outboundSpf: 'v=spf1 ip4:192.0.2.5 ~all' };

test('domain authentication creates a persisted unique key, reuses it, and returns public records only', async () => {
  const { provider, secretStore, calls, objects } = fixture();
  const first = await provider.ensureDomainAuthentication('EXAMPLE.TEST');
  const saved = await secretStore.get('smtp:dkim:example.test:key');
  const second = await provider.ensureDomainAuthentication('example.test');
  assert.deepEqual(first, second);
  assert.equal(calls.filter(item => item.method === 'x:DkimSignature/set').length, 1);
  assert.equal([...objects.Domain.values()][0].dkimManagement['@type'], 'Manual');
  assert.equal(first.records[0].content.startsWith('v=DKIM1; k=rsa; p='), true);
  assert.equal(first.records[0].name.endsWith('._domainkey.example.test'), true);
  assert.equal(JSON.stringify(first).includes('PRIVATE KEY'), false);
  assert.equal(await secretStore.get('smtp:dkim:example.test:key'), saved);
});

test('lost DKIM create response resumes without creating another signing key', async () => {
  const { provider, calls } = fixture({ lost: true });
  await assert.rejects(provider.ensureDomainAuthentication('example.test'));
  const result = await provider.ensureDomainAuthentication('example.test');
  assert.equal(result.records.length, 1);
  assert.equal(calls.filter(item => item.method === 'x:DkimSignature/set').length, 1);
});

test('pending signing keys are never rotated or silently replaced', async () => {
  const { provider, objects, calls } = fixture();
  const domain = await provider.ensureDomain('example.test', { manualDkim: true });
  objects.DkimSignature.set('pending', { id: 'pending', domainId: domain.id, stage: 'pending' });
  await assert.rejects(provider.ensureDomainAuthentication('example.test'), /not active/);
  assert.equal(calls.some(item => item.method === 'x:DkimSignature/set'), false);
});

test('adapter discovery has no credentials, DNS is configured, and mailbox credentials are unique and persistent', async () => {
  const { provider, secretStore, calls } = fixture();
  const connectivity = {
    verifyMailbox: async item => { assert.equal(Boolean(item.password), true); return { smtp: true, imap: true }; },
    verifyRelaySecurity: async () => true,
  };
  const adapter = createMailInfrastructure({ ...config, provider, secretStore, connectivity });
  assert.equal(await adapter.getDomain('example.test'), null);
  await adapter.ensureDomain('example.test');
  assert.deepEqual(Object.keys(await adapter.getDomain('example.test')).sort(), ['id','name']);
  const records = await adapter.getRequiredDnsRecords('example.test');
  assert.equal(records.filter(item => item.name === 'example.test' && item.content.startsWith('v=spf1')).length, 1);
  assert.deepEqual(records.find(item => item.type === 'MX'), { type: 'MX', name: 'example.test', content: config.publicHost, priority: 10 });
  const first = await adapter.ensureMailbox('alice@example.test');
  const second = await adapter.ensureMailbox('bob@example.test');
  assert.equal(typeof first.id, 'string');
  assert.deepEqual(first, { id: first.id, credentialRef: 'mailbox:alice@example.test', created: true });
  assert.notEqual(await secretStore.get(first.credentialRef), await secretStore.get(second.credentialRef));
  assert.deepEqual(await adapter.ensureMailbox('alice@example.test'), { ...first, created: false });
  const publicMailbox = await adapter.getMailbox('alice@example.test');
  assert.deepEqual(Object.keys(publicMailbox).sort(), ['email','id']);
  assert.deepEqual(await adapter.verifyMailbox('alice@example.test'), { smtp:true, imap:true });
  assert.equal(await adapter.verifyRelaySecurity(), true);
  assert.deepEqual(await adapter.getMailboxCredentials('alice@example.test'), { email: 'alice@example.test', password: await secretStore.get(first.credentialRef) });
  assert.equal(calls.some(item => item.args.destroy || item.args.update), false);
});

test('foreign mailbox without a stored credential is never adopted or rotated', async () => {
  const { provider, secretStore, objects, calls } = fixture();
  const domain = await provider.ensureDomain('example.test');
  objects.Account.set('foreign', { id: 'foreign', name: 'alice', domainId: domain.id, '@type':'User', roles:{'@type':'User'} });
  const adapter = createMailInfrastructure({ ...config, provider, secretStore });
  await assert.rejects(adapter.ensureMailbox('alice@example.test'), error => error.code === 'MAIL_INBOX_SETUP');
  await assert.rejects(adapter.getMailboxCredentials('alice@example.test'), /credentials are unavailable/);
  assert.equal(calls.some(item => item.method === 'x:Account/set'), false);
});

test('adapter errors cannot expose upstream diagnostics or secrets', async () => {
  const secretStore = memoryStore();
  const adapter = createMailInfrastructure({ ...config, secretStore, provider: {
    getDomain: async () => { throw new Error('Stalwart JMAP Contabo /opt/private token=synthetic-secret'); },
  } });
  await assert.rejects(adapter.getDomain('example.test'), error => {
    assert.equal(/stalwart|jmap|contabo|private|token|synthetic/i.test(error.message), false);
    assert.equal(error.code, 'MAIL_DOMAIN_DISCOVERY');
    return true;
  });
});

test('CSV uses standard fields, configured hosts, and correct escaping with no provider metadata', () => {
  const csv = buildSmtpCsv([{ email:'alice@example.test', password:'Munique,"credential' }], config);
  assert.equal(csv.startsWith('\uFEFFemail,password,smtp_host,smtp_port,smtp_username,smtp_password,smtp_security,imap_host,imap_port,imap_username,imap_password,imap_security\r\n'), true);
  assert.equal(csv.includes('"Munique,""credential"'), true);
  assert.equal(csv.includes('"465"'), true);
  assert.equal(csv.includes('"993"'), true);
  assert.equal(/stalwart|jmap|contabo|manyreach|plusvibe|management/i.test(csv), false);
  assert.throws(() => buildSmtpCsv([{email:'alice@example.test',password:'=HYPERLINK("secret")'}],config), /could not be exported/);
  assert.throws(() => buildSmtpCsv([{email:'alice@example.test',password:'bad\nsecret'}],config), /could not be exported/);
});

test('safe secret deletion isolates users, is idempotent and refuses symlinks', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(),'smtp-secret-test-'));
  try {
    const store = new FileSecretStore(directory);
    await store.set('resend:user:1:api-key','synthetic-one');
    await store.set('resend:user:2:api-key','synthetic-two');
    assert.equal(await store.delete('resend:user:1:api-key'),true);
    assert.equal(await store.delete('resend:user:1:api-key'),false);
    assert.equal(await store.get('resend:user:2:api-key'),'synthetic-two');
    assert.equal((await stat(store.filePath('resend:user:2:api-key'))).mode & 0o777,0o600);
    const target = path.join(directory,'target');
    await writeFile(target,'synthetic-protected',{mode:0o600});
    await symlink(target,store.filePath('unsafe'));
    await assert.rejects(store.delete('unsafe'),/Unable to delete secret/);
    assert.equal((await stat(directory)).mode & 0o777,0o700);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
