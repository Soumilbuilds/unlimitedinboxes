import assert from 'node:assert/strict';
import test from 'node:test';

import { isExternalDirectoryMemberCreationError } from '../services/orderProcessor.js';

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
