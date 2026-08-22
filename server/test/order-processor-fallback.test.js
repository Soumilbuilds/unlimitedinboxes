import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRandomMailboxPlan,
  isExternalDirectoryMemberCreationError,
  isRecoverableExchangeProvisioningError,
  validatePlannedMailboxIdentities,
} from '../services/orderProcessor.js';

test('detects the Exchange ExternalDirectoryObjectId member-creation failure', () => {
  assert.equal(isExternalDirectoryMemberCreationError(new Error(
    'Required field ExternalDirectoryObjectId is missing in input for Member Creation.',
  )), true);
  assert.equal(isExternalDirectoryMemberCreationError(
    'member creation failed because EXTERNALDIRECTORYOBJECTID was unavailable',
  ), true);
});

test('does not activate mailbox recovery for unrelated Exchange failures', () => {
  assert.equal(isExternalDirectoryMemberCreationError(new Error('Access denied')), false);
  assert.equal(isExternalDirectoryMemberCreationError(new Error(
    'ExternalDirectoryObjectId was returned while reading a mailbox',
  )), false);
  assert.equal(isExternalDirectoryMemberCreationError(null), false);
});

test('random retry plans preserve checkpointed aliases and fill the exact order total', () => {
  const plan = buildRandomMailboxPlan(4, [
    { name: 'Taylor Morgan', email: 'taylormorgan@example.com' },
    { name: 'Jordan Lee', email: 'jordanlee@example.com' },
  ]);
  assert.equal(plan.length, 4);
  assert.deepEqual(plan.slice(0, 2), [
    { fullName: 'Taylor Morgan', alias: 'taylormorgan' },
    { fullName: 'Jordan Lee', alias: 'jordanlee' },
  ]);
  assert.equal(new Set(plan.map(identity => identity.alias)).size, 4);
});

test('persisted plans reject wrong totals, invalid aliases, and duplicate aliases', () => {
  assert.throws(() => validatePlannedMailboxIdentities([], 1), /exactly 1/i);
  assert.throws(() => validatePlannedMailboxIdentities([
    { fullName: 'Valid Name', alias: 'not@valid' },
  ], 1), /item 1 is invalid/i);
  assert.throws(() => validatePlannedMailboxIdentities([
    { fullName: 'First Name', alias: 'duplicate' },
    { fullName: 'Second Name', alias: 'DUPLICATE' },
  ], 2), /duplicate alias/i);
});

test('activates mailbox recovery when the app-only Exchange command times out', () => {
  assert.equal(isRecoverableExchangeProvisioningError(new Error(
    'Exchange Online PowerShell command timed out after 5 minutes',
  )), true);
  assert.equal(isRecoverableExchangeProvisioningError(
    'SMTP AUTH remains disabled for shared mailbox user@example.com',
  ), true);
  assert.equal(isRecoverableExchangeProvisioningError(new Error('Access denied')), false);
});
