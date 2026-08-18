import assert from 'node:assert/strict';
import test from 'node:test';

import { getUserAccessState } from '../services/access.js';
import {
  WHOP_PLAN_IDS,
  buildWhopMembershipUpdates,
  createWhopCheckout,
  selectInitialWhopPlan,
  serializeBillingAddress,
} from '../services/whop.js';

const user = { id: 42, email: 'Customer@Example.com', plan: 'free' };

test('new users get the intro plan and legacy intro users get the no-trial plan', () => {
  assert.equal(selectInitialWhopPlan(user), WHOP_PLAN_IDS.intro);
  assert.equal(selectInitialWhopPlan({ ...user, xpay_intro_offer_used: 1 }), WHOP_PLAN_IDS.basic);
  assert.equal(selectInitialWhopPlan({ ...user, whop_intro_offer_used: 1 }), WHOP_PLAN_IDS.basic);
});

test('a failed intro membership does not consume the one-time trial offer', () => {
  const updates = buildWhopMembershipUpdates({
    id: 'mem_failed',
    status: 'drafted',
    plan: { id: WHOP_PLAN_IDS.intro },
  });
  assert.equal(updates.whop_intro_offer_used, undefined);
  assert.equal(selectInitialWhopPlan({ ...user, ...updates }), WHOP_PLAN_IDS.intro);
});

test('creates a Whop checkout configuration with account-bound metadata', async () => {
  let payload;
  const client = {
    checkoutConfigurations: {
      async create(input) {
        payload = input;
        return {
          id: 'ch_test',
          purchase_url: 'https://whop.com/checkout/test?session=ch_test',
          plan: { id: WHOP_PLAN_IDS.intro },
        };
      },
    },
  };

  const result = await createWhopCheckout(client, {
    user,
    planId: WHOP_PLAN_IDS.intro,
    redirectUrl: 'https://app.example.com/billing?billing=success',
    sourceUrl: 'https://app.example.com/billing',
  });

  assert.equal(payload.plan_id, WHOP_PLAN_IDS.intro);
  assert.equal(payload.metadata.user_id, '42');
  assert.equal(payload.metadata.email, 'customer@example.com');
  assert.equal(payload.mode, undefined);
  assert.equal(result.sessionId, 'ch_test');
});

test('trialing Whop membership grants 100 inboxes but exposes only the first 10', () => {
  const membership = {
    id: 'mem_test',
    status: 'trialing',
    plan: { id: WHOP_PLAN_IDS.intro },
    member: { id: 'mber_test' },
    renewal_period_end: new Date(Date.now() + 5 * 86400000).toISOString(),
    cancel_at_period_end: false,
  };
  const updates = buildWhopMembershipUpdates(membership);
  const access = getUserAccessState({ ...user, ...updates });

  assert.equal(access.canAccessApp, true);
  assert.equal(access.inboxesLimit, 100);
  assert.equal(access.isTrialing, true);
  assert.equal(access.downloadAllowance, 10);
  assert.equal(access.canDownloadAll, false);
});

test('trial limits remain enforced when Whop sends a Unix renewal timestamp', () => {
  const updates = buildWhopMembershipUpdates({
    id: 'mem_unix_trial',
    status: 'trialing',
    plan: { id: WHOP_PLAN_IDS.intro },
    renewal_period_end: String(Math.floor(Date.now() / 1000) + (5 * 86400)),
  });
  const access = getUserAccessState({ ...user, ...updates });

  assert.equal(access.isTrialing, true);
  assert.equal(access.downloadAllowance, 10);
  assert.match(updates.whop_current_period_end, /^\d{4}-\d{2}-\d{2}T/);
});

test('paid basic membership grants all 100 inbox downloads', () => {
  const updates = buildWhopMembershipUpdates({
    id: 'mem_test',
    status: 'active',
    plan: { id: WHOP_PLAN_IDS.basic },
    cancel_at_period_end: false,
  });
  const access = getUserAccessState({ ...user, ...updates });

  assert.equal(access.effectivePlan, 'basic');
  assert.equal(access.inboxesLimit, 100);
  assert.equal(access.canDownloadAll, true);
  assert.equal(access.downloadAllowance, Infinity);
});

test('an expired Whop trial does not retain access while a webhook is delayed', () => {
  const updates = buildWhopMembershipUpdates({
    id: 'mem_expired',
    status: 'trialing',
    plan: { id: WHOP_PLAN_IDS.intro },
    renewal_period_end: new Date(Date.now() - 1000).toISOString(),
    cancel_at_period_end: true,
  });
  const access = getUserAccessState({ ...user, ...updates });

  assert.equal(access.isTrialing, false);
  assert.equal(access.canAccessApp, false);
  assert.equal(access.downloadAllowance, 0);
});

test('a paid intro membership keeps basic access while canceling at period end', () => {
  const updates = buildWhopMembershipUpdates({
    id: 'mem_canceling_basic',
    status: 'canceling',
    plan: { id: WHOP_PLAN_IDS.intro },
    renewal_period_end: String(Math.floor(Date.now() / 1000) + 86400),
    cancel_at_period_end: true,
  });
  const access = getUserAccessState({ ...user, ...updates, plan: 'basic' });

  assert.equal(access.effectivePlan, 'basic');
  assert.equal(access.isTrialing, false);
  assert.equal(access.canAccessApp, true);
  assert.equal(access.downloadAllowance, Infinity);
});

test('billing address persistence keeps only checkout address fields', () => {
  assert.equal(serializeBillingAddress({
    name: 'Test User',
    line1: '1 Main St',
    city: 'Austin',
    country: 'US',
    secret: 'ignored',
  }), JSON.stringify({ name: 'Test User', line1: '1 Main St', city: 'Austin', country: 'US' }));
});
