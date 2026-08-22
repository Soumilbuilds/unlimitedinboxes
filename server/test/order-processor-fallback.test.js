import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isExternalDirectoryMemberCreationError,
  isRecoverableExchangeProvisioningError,
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

test('activates mailbox recovery when the app-only Exchange command times out', () => {
  assert.equal(isRecoverableExchangeProvisioningError(new Error(
    'Exchange Online PowerShell command timed out after 5 minutes',
  )), true);
  assert.equal(isRecoverableExchangeProvisioningError(new Error('Access denied')), false);
});
