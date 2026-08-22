import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDomain } from '../services/domain.js';

test('normalizes customer-entered domains', () => {
  assert.equal(normalizeDomain('  GuestBookingLounge.Pro.  '), 'guestbookinglounge.pro');
});

test('returns null for an empty domain', () => {
  assert.equal(normalizeDomain('   '), null);
  assert.equal(normalizeDomain(null), null);
});
