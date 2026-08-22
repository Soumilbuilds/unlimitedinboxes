import test from 'node:test';
import assert from 'node:assert/strict';

import { isDkimConfigEnabled } from '../services/securityCenterDkim.js';

test('recognizes an enabled DKIM config after an idempotent API failure', () => {
  assert.equal(isDkimConfigEnabled({ success: true, Enabled: true }), true);
  assert.equal(isDkimConfigEnabled({ success: true, Enabled: 'true' }), true);
});

test('does not accept missing, failed, or disabled DKIM configs', () => {
  assert.equal(isDkimConfigEnabled(null), false);
  assert.equal(isDkimConfigEnabled({ success: false, Enabled: true }), false);
  assert.equal(isDkimConfigEnabled({ success: true, Enabled: false }), false);
});
