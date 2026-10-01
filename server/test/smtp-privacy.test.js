import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  publicSmtpConnection, publicSmtpError, publicSmtpOrder, safeSmtpLog,
} from '../services/smtpPublic.js';
import { buildSmtpCsv } from '../services/smtpCsv.js';
import { ResendService } from '../services/resend.js';

// Assert only customer output, never provider implementation source. Password
// cells in the authenticated CSV intentionally do not pass through this filter.
const INTERNAL = /\bstalwart\b|\bjmap\b|\bcontabo\b|\bmanyreach\b|\bplusvibe\b|\/jmap\/?|x:Account|x:Domain|127\.0\.0\.1|localhost:\d+|management[_ -]?(?:url|token|port)|\/opt\/|\/root\/|\/secrets\/|credential[_ -]?ref|secret[_ -]?ref/i;
const RAW = 'RAW_UPSTREAM_BODY_SENTINEL';
const KEY = 're_synthetic_privacy_secret';
const PASSWORD = 'SyntheticMailboxPassword-Privacy!';
const diagnostic = `${RAW} Stalwart JMAP Contabo Manyreach PlusVibe http://127.0.0.1:8080/jmap/ /opt/private/secrets/key Authorization: Bearer ${KEY} password=${PASSWORD}`;

function assertPrivate(value, { allowPassword = false } = {}) {
  const output = typeof value === 'string' ? value : JSON.stringify(value);
  assert.doesNotMatch(output, INTERNAL);
  assert.ok(!output.includes(RAW), 'Raw upstream body must not be customer-visible');
  assert.ok(!output.includes(KEY), 'Resend credential must not be customer-visible');
  if (!allowPassword) assert.ok(!output.includes(PASSWORD), 'Password must not be customer-visible');
}

test('SMTP public errors discard raw provider bodies, stack traces, authorization and unknown codes', () => {
  for (const code of ['SERVICE_UNAVAILABLE', 'RESEND_INVALID_KEY', 'RESEND_FULL_ACCESS_REQUIRED', 'RESEND_DOMAIN_CONFLICT', 'MAILBOX_PROVISIONING_FAILED', 'PRIVATE_PROVIDER_CODE']) {
    const error = Object.assign(new Error(diagnostic), {
      code, stack: diagnostic, response: { data: { message: diagnostic } },
      headers: { Authorization: `Bearer ${KEY}` }, publicMessage: diagnostic,
    });
    const output = publicSmtpError(error);
    assertPrivate(output);
    assert.deepEqual(Object.keys(output).sort(), ['code', 'error', 'status']);
    assert.ok(output.error.length > 0);
  }
});

test('SMTP progress is an allowlist and cannot reveal injected diagnostics', () => {
  for (const message of [diagnostic, `Creating Inbox 1 Of 5 ${diagnostic}`, `Preparing Domain\n${diagnostic}`, 'x:Account/set failed']) {
    assertPrivate(safeSmtpLog(message));
    assert.equal(safeSmtpLog(message), 'Provisioning Paused');
  }
  for (const message of ['Preparing Domain', 'Nameservers Connected', 'Applying DNS Records', 'Configuring Email Authentication', 'Creating Inbox 1 Of 5', 'Testing SMTP', 'Testing IMAP', 'Running Final Checks', 'Provisioning Complete']) {
    assert.equal(safeSmtpLog(message), message);
  }
});

test('SMTP order and connection serializers never expose private checkpoints or secrets', () => {
  const output = publicSmtpOrder({
    id: 1, domain: 'example.test', order_name: 'Example', status: 'failed', progress: 20, total_mailboxes: 1,
    cloudflare_ns: '["one.ns.example.test","two.ns.example.test"]', nameservers_connected: 1,
    error_code: diagnostic, error_message: diagnostic, password: PASSWORD, api_key: KEY,
    processing_token: diagnostic, required_dns: diagnostic, cloudflare_zone_id: diagnostic,
    resend_domain_id: diagnostic, credential_ref: diagnostic, secret_ref: diagnostic,
  }, [{ local_part: 'alice', email: 'alice@example.test', status: 'created', password: PASSWORD, credential_ref: diagnostic }]);
  assertPrivate(output);
  assert.equal(output.created_mailboxes_count, 1);
  assert.deepEqual(output.mailbox_names, ['alice']);
  assertPrivate(publicSmtpConnection({ status: 'connected', connected_domain_count: 2, secret_ref: diagnostic, api_key: KEY }));
});

test('generic SMTP CSV metadata stays private while password cells preserve exact credentials and escaping', () => {
  const password = 'Synthetic-Stalwart-JMAP-Password,"quoted"!';
  const csv = buildSmtpCsv([{ email: 'alice@example.test', password }], { publicHost: 'mail.igoutbound.com' });
  const lines = csv.replace(/^\uFEFF/, '').trimEnd().split('\r\n');
  const headers = lines[0].split(',');
  assert.deepEqual(headers, ['email', 'password', 'smtp_host', 'smtp_port', 'smtp_username', 'smtp_password', 'smtp_security', 'imap_host', 'imap_port', 'imap_username', 'imap_password', 'imap_security']);
  const cells = [...lines[1].matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(match => match[1].replace(/""/g, '"'));
  assert.equal(cells.length, headers.length);
  const row = Object.fromEntries(headers.map((name, i) => [name, cells[i]]));
  for (const name of ['password', 'smtp_password', 'imap_password']) {
    assert.equal(row[name], password);
    delete row[name];
  }
  assertPrivate(lines[0]);
  assertPrivate(row);
  assert.equal(row.smtp_host, 'mail.igoutbound.com');
  assert.equal(row.imap_host, 'mail.igoutbound.com');
  assert.equal(row.smtp_port, '465');
  assert.equal(row.imap_port, '993');
});

test('Resend transport failures never retain provider body, credential, headers or cause', async () => {
  for (const status of [401, 403, 429, 500]) {
    const client = new ResendService({
      apiKey: `${KEY}_${status}`,
      fetchImpl: async (url, options) => {
        assert.match(url, /^https:\/\/api\.resend\.com\/domains\?/);
        assert.equal(options.redirect, 'error');
        return { ok: false, status, headers: new Headers({ 'retry-after': '1' }), json: async () => ({ name: 'provider_error', message: diagnostic }) };
      },
    });
    await assert.rejects(client.validateKey(), error => {
      assertPrivate({ message: error.message, ...error });
      assert.equal(error.cause, undefined);
      assert.equal(error.response, undefined);
      return true;
    });
    assertPrivate(JSON.stringify(client));
  }
  const client = new ResendService({ apiKey: `${KEY}_network`, fetchImpl: async () => { throw new Error(diagnostic); } });
  await assert.rejects(client.validateKey(), error => { assertPrivate(error.message); return true; });
});

test('customer SMTP page contains no private implementation copy or browser credential storage', async () => {
  const source = await readFile(new URL('../../client/src/pages/SMTP.jsx', import.meta.url), 'utf8');
  // The page itself is browser-delivered code. Backend source is intentionally
  // excluded; it may name its private implementation.
  assert.doesNotMatch(source, INTERNAL);
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\.(?:log|debug|error)/);
});
