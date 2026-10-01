import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { ResendService, ResendError } from '../services/resend.js';

const settings = { open_tracking: false, click_tracking: false, capabilities: { sending: 'enabled', receiving: 'disabled' } };
const domain = (overrides = {}) => ({ id: 'domain-1', name: 'example.com', status: 'pending', ...settings, ...overrides });
const list = (data, has_more = false) => ({ data, has_more });
function response(body, status = 200, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body };
}
function client(responses, options = {}) {
  const calls = [];
  const service = new ResendService({
    apiKey: `re_test_${randomUUID()}`,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      assert.equal(new URL(url).origin, 'https://api.resend.com');
      assert.equal(options.redirect, 'error');
      const next = responses.shift();
      assert.ok(next, 'Unexpected provider request');
      return typeof next === 'function' ? next(url, options) : next;
    }, ...options
  });
  return { service, calls };
}
function safeError(error, code) {
  assert.ok(error instanceof ResendError);
  assert.equal(error.code, code);
  assert.equal(error.message, error.publicMessage);
  assert.doesNotMatch(JSON.stringify(error) + error.stack, /Stalwart|JMAP|Contabo|Manyreach|PlusVibe|secret-upstream|authorization/i);
  assert.equal(error.cause, undefined);
  return true;
}

test('Full Access key validation uses a harmless domain list and whitelists metadata', async () => {
  const { service, calls } = client([response(list([domain({ secret: 'secret-upstream', provider_private: 'Contabo' })]))]);
  const result = await service.validateKey();
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'example.com');
  assert.deepEqual(result[0].records, []);
  assert.doesNotMatch(JSON.stringify(result), /secret-upstream|Contabo/);
  assert.match(calls[0].url, /\/domains\?limit=100$/);
  assert.equal(calls[0].options.method, 'GET');
});

for (const [description, status, name, message, code] of [
  ['invalid key', 401, 'invalid_api_key', 'secret-upstream', 'RESEND_INVALID_KEY'],
  ['revoked key', 403, 'restricted_api_key', 'API key is not active', 'RESEND_INVALID_KEY'],
  ['suspended key', 403, 'suspended_api_key', 'secret-upstream', 'RESEND_INVALID_KEY'],
  ['Sending Access key', 401, 'restricted_api_key', 'This API key is restricted to only send emails.', 'RESEND_FULL_ACCESS_REQUIRED'],
  ['missing domain scopes', 403, 'invalid_permission', 'secret-upstream', 'RESEND_FULL_ACCESS_REQUIRED'],
  ['forbidden domain management', 403, 'validation_error', 'Full access is required', 'RESEND_FULL_ACCESS_REQUIRED'],
  ['temporary provider error', 503, 'service_unavailable', 'secret-upstream Contabo /root/server', 'RESEND_UNAVAILABLE']
]) {
  test(`${description} returns a sanitized typed error`, async () => {
    const { service } = client([response({ name, message }, status)]);
    await assert.rejects(service.validateKey(), error => safeError(error, code));
  });
}

test('rejects malformed API key without making a request', () => {
  for (const apiKey of ['', null, 're_key\nheader', 'x'.repeat(513)]) {
    assert.throws(() => new ResendService({ apiKey }), error => safeError(error, 'RESEND_INVALID_KEY'));
  }
});

test('domain pagination follows the after cursor and counts unique domain IDs', async () => {
  const { service, calls } = client([
    response(list([domain()], true)),
    response(list([domain(), domain({ id: 'domain-2', name: 'other.example' })], true)),
    response(list([domain({ id: 'domain-3', name: 'last.example' })]))
  ]);
  const domains = await service.listDomains();
  assert.equal(domains.length, 3);
  assert.equal(new URL(calls[1].url).searchParams.get('after'), 'domain-1');
  assert.equal(new URL(calls[2].url).searchParams.get('after'), 'domain-2');
});

test('malformed pagination fails rather than looping', async () => {
  const { service, calls } = client([response(list([domain()], true)), response(list([domain()], true))]);
  await assert.rejects(service.listDomains(), error => safeError(error, 'RESEND_UNAVAILABLE'));
  assert.equal(calls.length, 2);
});

test('reuse configured domain idempotently without creating or updating it', async () => {
  const { service, calls } = client([response(list([domain()])), response(domain())]);
  assert.equal((await service.ensureDomain('Example.COM.')).id, 'domain-1');
  assert.deepEqual(calls.map(call => call.options.method), ['GET', 'GET']);
});

test('new domain defaults capabilities then disables tracking through documented PATCH', async () => {
  const records = [
    { type: 'TXT', name: 'resend._domainkey', value: 'p=public-material' },
    { type: 'MX', name: 'send', value: 'feedback-smtp.region.example', priority: 10 },
    { type: 'TXT', name: 'send', value: 'v=spf1 include:provider.example ~all' }
  ];
  const { service, calls } = client([
    response(list([])), response(domain({ open_tracking: true, records })),
    response({ object: 'domain', id: 'domain-1' }), response(domain({ records }))
  ]);
  const ensured = await service.ensureDomain('example.com');
  assert.deepEqual(JSON.parse(calls[1].options.body), { name: 'example.com', capabilities: settings.capabilities });
  assert.deepEqual(JSON.parse(calls[2].options.body), settings);
  assert.equal(ensured.records[0].name, 'resend._domainkey.example.com');
  assert.equal(ensured.records[1].name, 'send.example.com');
  assert.equal(ensured.records[1].content, 'feedback-smtp.region.example');
  assert.equal(ensured.records[1].priority, 10);
  assert.equal(ensured.capabilities.receiving, 'disabled');
});

test('existing domain updates receiving/tracking settings and fetches fresh DNS', async () => {
  const { service, calls } = client([
    response(list([domain()])), response(domain({ capabilities: { sending: 'disabled', receiving: 'enabled' }, click_tracking: true })),
    response({ id: 'domain-1' }), response(domain())
  ]);
  const result = await service.ensureDomain('example.com');
  assert.equal(calls[2].options.method, 'PATCH');
  assert.deepEqual(result.capabilities, settings.capabilities);
});

test('conflicting domain in another account is never claimed or transferred', async () => {
  const { service, calls } = client([
    response(list([])), response({ name: 'validation_error', message: 'example.com has been registered already. secret-upstream' }, 403),
    response(list([]))
  ]);
  await assert.rejects(service.ensureDomain('example.com'), error => safeError(error, 'RESEND_DOMAIN_CONFLICT'));
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => !/claim|delete/i.test(call.url)));
});

test('same-account creation race discovers the existing domain', async () => {
  const { service } = client([
    response(list([])), response({ name: 'validation_error', message: 'Domain already exists.' }, 409),
    response(list([domain()])), response(domain())
  ]);
  assert.equal((await service.ensureDomain('example.com')).id, 'domain-1');
});

test('domain quota errors are actionable and do not expose provider text', async () => {
  const { service } = client([response(list([])), response({ name: 'validation_error', message: 'Maximum domain limit secret-upstream' }, 422)]);
  await assert.rejects(service.ensureDomain('example.com'), error => safeError(error, 'RESEND_DOMAIN_LIMIT'));
});

test('429 honors Retry-After and blocks follow-up requests without hammering', async () => {
  const { service, calls } = client([response({ message: 'secret-upstream' }, 429, { 'retry-after': '30' })]);
  await assert.rejects(service.listDomains(), error => safeError(error, 'RESEND_RATE_LIMIT') && error.retryAfterMs >= 30000);
  await assert.rejects(service.listDomains(), error => safeError(error, 'RESEND_RATE_LIMIT') && error.retryAfterMs > 29000);
  assert.equal(calls.length, 1);
});

test('non-JSON 429 is still rate limited using its headers', async () => {
  const r = response(null, 429, { 'retry-after': '20' });
  r.json = async () => { throw new SyntaxError('secret-upstream'); };
  const { service, calls } = client([r]);
  await assert.rejects(service.listDomains(), error => safeError(error, 'RESEND_RATE_LIMIT') && error.retryAfterMs >= 20000);
  await assert.rejects(service.listDomains(), error => safeError(error, 'RESEND_RATE_LIMIT'));
  assert.equal(calls.length, 1);
});

test('429 fallback respects ratelimit-reset and HTTP-date Retry-After', async () => {
  const reset = client([response({}, 429, { 'ratelimit-reset': '12' })]);
  await assert.rejects(reset.service.listDomains(), error => safeError(error, 'RESEND_RATE_LIMIT') && error.retryAfterMs >= 12000);
  const date = client([response({}, 429, { 'retry-after': new Date(Date.now() + 15000).toUTCString() })]);
  await assert.rejects(date.service.listDomains(), error => safeError(error, 'RESEND_RATE_LIMIT') && error.retryAfterMs >= 13000);
});

test('exhausted success response headers defer later calls', async () => {
  const { service, calls } = client([response(list([]), 200, { 'ratelimit-remaining': '0', 'ratelimit-reset': '15' })]);
  assert.deepEqual(await service.validateKey(), []);
  await assert.rejects(service.listDomains(), error => safeError(error, 'RESEND_RATE_LIMIT'));
  assert.equal(calls.length, 1);
});

test('transport timeout and raw thrown error never escape', async () => {
  const timeout = client([() => new Promise(() => {})], { requestTimeoutMs: 5 });
  await assert.rejects(timeout.service.listDomains(), error => safeError(error, 'RESEND_UNAVAILABLE'));
  const thrown = client([() => { throw new Error('secret-upstream Stalwart token'); }]);
  await assert.rejects(thrown.service.listDomains(), error => safeError(error, 'RESEND_UNAVAILABLE'));
});

test('request timeout includes reading the response body', async () => {
  const { service } = client([() => ({ ok: true, status: 200, json: () => new Promise(() => {}) })], { requestTimeoutMs: 5 });
  await assert.rejects(service.listDomains(), error => safeError(error, 'RESEND_UNAVAILABLE'));
});

test('domain verification is one explicit trigger followed by a read', async () => {
  const { service, calls } = client([response({ object: 'domain', id: 'domain-1' }), response(domain({ status: 'verified' }))]);
  assert.equal((await service.verifyDomain('domain-1')).status, 'verified');
  assert.deepEqual(calls.map(call => call.options.method), ['POST', 'GET']);
  assert.ok(calls[0].url.endsWith('/domains/domain-1/verify'));
});

test('provider paths cannot be supplied through IDs', async () => {
  const { service, calls } = client([]);
  for (const id of ['../api-keys', 'https://evil.example', 'domain-1?path=x', 'a/b']) {
    await assert.rejects(service.getDomain(id), error => safeError(error, 'RESEND_UNAVAILABLE'));
  }
  assert.equal(calls.length, 0);
});

test('domain inputs reject control characters, URLs and malformed names before requests', async () => {
  const { service, calls } = client([]);
  for (const value of ['https://example.com', 'a@example.com', '-bad.example', 'example', '127.0.0.1', 'exa\nmple.com', 'a..example']) {
    await assert.rejects(service.ensureDomain(value), error => safeError(error, 'INVALID_DOMAIN'));
  }
  assert.equal(calls.length, 0);
});

test('unsafe provider records cannot be passed through to DNS', async () => {
  for (const record of [
    { type: 'TXT', name: 'another.example.', value: 'x' },
    { type: 'TXT', name: 'resend._domainkey', value: 'x\nAuthorization' },
    { type: 'MX', name: 'send', value: 'https://evil.example', priority: 10 },
    { type: 'MX', name: 'send', value: 'mail.example.com', priority: -1 },
    { type: 'NS', name: '@', value: 'ns.example.com' }
  ]) {
    const { service } = client([response(domain({ records: [record] }))]);
    await assert.rejects(service.getDomain('domain-1'));
  }
});

test('service instance serialization and inspect never reveal credentials', async () => {
  const apiKey = `re_test_${randomUUID()}`;
  const { service } = client([response(list([]))], { apiKey });
  await service.validateKey();
  assert.ok(!JSON.stringify(service).includes(apiKey));
  assert.ok(!inspect(service, { showHidden: true }).includes(apiKey));
  assert.deepEqual(Object.keys(service), []);
});
