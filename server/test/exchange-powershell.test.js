import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExchangeAlias,
  ensureSharedMailboxes,
} from '../services/exchangePowerShell.js';

test('Exchange aliases are stable and scoped to the complete SMTP address', () => {
  const first = buildExchangeAlias('sales', 'example.com');
  assert.equal(first, buildExchangeAlias(' SALES ', 'EXAMPLE.COM'));
  assert.notEqual(first, buildExchangeAlias('sales', 'another.example'));
  assert.match(first, /^sales-[a-f0-9]{12}$/);
});

test('Exchange aliases sanitize unsafe local parts and stay within Exchange limits', () => {
  const alias = buildExchangeAlias('  Téam+Really Long Local Part '.repeat(4), 'example.com');
  assert.match(alias, /^[a-z0-9._-]+$/);
  assert.ok(alias.length <= 64);
  assert.match(alias, /-[a-f0-9]{12}$/);
});

test('mailbox batches reject duplicate SMTP recipients before connecting to Exchange', async () => {
  await assert.rejects(
    ensureSharedMailboxes({
      orgDomain: 'tenant.onmicrosoft.com',
      domain: 'example.com',
      mailboxes: [
        { alias: 'sales', displayName: 'Sales One' },
        { alias: 'SALES', displayName: 'Sales Two' },
      ],
    }),
    /duplicate recipient addresses/i,
  );
});
