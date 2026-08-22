import assert from 'node:assert/strict';
import test from 'node:test';
import { selectLegacyOrderMailboxes } from '../services/legacyOrderReconciliation.js';

test('legacy reconciliation deterministically selects exact domain mailboxes', () => {
  const result = selectLegacyOrderMailboxes({
    domain: 'example.com',
    totalMailboxes: 2,
    mailboxPassword: 'Password123!',
    mailboxes: [
      { primarySmtpAddress: 'z@example.com', displayName: 'Zed', externalDirectoryObjectId: 'z-id' },
      { primarySmtpAddress: 'a@other.example', displayName: 'Other', externalDirectoryObjectId: 'other-id' },
      { primarySmtpAddress: 'b@example.com', displayName: 'Bee', externalDirectoryObjectId: 'b-id' },
      { primarySmtpAddress: 'a@example.com', displayName: 'Aye', externalDirectoryObjectId: 'a-id' }
    ]
  });
  assert.equal(result.candidateCount, 3);
  assert.deepEqual(result.selected.map(row => row.email), ['a@example.com', 'b@example.com']);
  assert.ok(result.selected.every(row => row.password === 'Password123!' && row.objectId));
});

test('legacy reconciliation refuses incomplete Exchange inventory', () => {
  assert.throws(() => selectLegacyOrderMailboxes({
    domain: 'example.com',
    totalMailboxes: 2,
    mailboxPassword: 'Password123!',
    mailboxes: [
      { primarySmtpAddress: 'a@example.com', displayName: 'Aye', externalDirectoryObjectId: 'a-id' },
      { primarySmtpAddress: 'b@example.com', displayName: 'Bee', externalDirectoryObjectId: null }
    ]
  }), /only 1\/2 usable shared mailboxes/);
});
