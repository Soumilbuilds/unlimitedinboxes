import assert from 'node:assert/strict';
import test from 'node:test';

import { getUserAccessState } from '../services/access.js';
import {
  WHOP_PLAN_IDS,
  createWhopSavedCardPayment,
  buildWhopMembershipUpdates,
  createWhopCheckout,
  serializeWhopPlanCatalog,
  selectInitialWhopPlan,
  serializeBillingAddress,
  isWhopEventNewer,
  validateWhopPromoCode,
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

test('serializes the six plan cards with provider-verified prices and feature limits', () => {
  const plans = serializeWhopPlanCatalog();
  assert.equal(plans.length, 6);
  assert.deepEqual(plans.map((plan) => [plan.name, plan.priceCents]), [
    ['Free Trial', 0], ['Tester', 999], ['Growth', 3999],
    ['Pro', 9999], ['Scale', 19999], ['Reseller', 29999],
  ]);
  assert.equal(plans[0].inboxesLimit, 10);
  assert.equal(plans[0].monthlySends, 1500);
  assert.equal(plans[4].unlimitedInboxes, true);
  assert.equal(plans[5].unlimitedConcurrentOrders, true);
});

test('all paid plans grant API, MCP, custom-name, and domain-redirect entitlements', () => {
  const paid = getUserAccessState({
    ...user,
    whop_membership_id: 'mem_paid',
    whop_membership_status: 'active',
    whop_plan_id: WHOP_PLAN_IDS.basic,
  });
  assert.equal(paid.canAccessApi, true);
  assert.equal(paid.canAccessMcp, true);
  assert.equal(paid.canUseCustomNames, true);
  assert.equal(paid.canUseDomainRedirects, true);

  const trial = getUserAccessState({
    ...user,
    whop_membership_id: 'mem_trial',
    whop_membership_status: 'trialing',
    whop_plan_id: WHOP_PLAN_IDS.intro,
    whop_current_period_end: new Date(Date.now() + 86400000).toISOString(),
  });
  assert.equal(trial.canAccessApi, false);
  assert.equal(trial.canAccessMcp, false);
  assert.equal(trial.canUseCustomNames, false);
  assert.equal(trial.canUseDomainRedirects, false);
  assert.equal(trial.inboxesLimit, 100);
  assert.equal(trial.downloadAllowance, 10);
});

test('validates and previews a Whop coupon against the target plan', async () => {
  const promo = {
    id: 'promo_20', code: 'SAVE20', status: 'active', promo_type: 'percentage',
    amount_off: 20, unlimited_stock: true, uses: 0, stock: 0, duration: 'once', product: { id: 'prod_test' },
  };
  const client = {
    promoCodes: {
      list(params) {
        return (async function* list() {
          if (!params.plan_ids || params.plan_ids[0] === WHOP_PLAN_IDS.starter) yield promo;
        }());
      },
    },
  };
  const result = await validateWhopPromoCode(client, { code: 'save20', planKey: 'starter' });
  assert.equal(result.id, 'promo_20');
  assert.equal(result.savingsCents, 800);
  assert.equal(result.priceCents, 3199);
});

test('saved-card plan payments use account-bound metadata and a stable idempotency key', async () => {
  let body;
  let options;
  const client = {
    payments: {
      async create(input, requestOptions) {
        body = input;
        options = requestOptions;
        return { id: 'pay_test', status: 'pending' };
      },
    },
  };
  await createWhopSavedCardPayment(client, {
    user: { ...user, whop_member_id: 'mber_test', whop_payment_method_id: 'pmt_test' },
    planId: WHOP_PLAN_IDS.growth,
    promoCodeId: 'promo_test',
    idempotencyKey: 'stable-plan-change-key',
    planChangeId: 'change_test',
  });
  assert.equal(body.company_id, 'biz_D0LbQ5wpeG8tff');
  assert.equal(body.member_id, 'mber_test');
  assert.equal(body.payment_method_id, 'pmt_test');
  assert.equal(body.plan_id, WHOP_PLAN_IDS.growth);
  assert.equal(body.promo_code_id, 'promo_test');
  assert.equal(body.metadata.user_id, '42');
  assert.equal(body.metadata.purpose, 'plan_change');
  assert.equal(body.metadata.plan_change_id, 'change_test');
  assert.equal(options.idempotencyKey, 'stable-plan-change-key');
});

test('Whop event ordering rejects stale and timestamp-free updates after a stored event', () => {
  assert.equal(isWhopEventNewer('2026-08-18T10:00:01.000Z', '2026-08-18T10:00:00.000Z'), true);
  assert.equal(isWhopEventNewer('2026-08-18T09:59:59.000Z', '2026-08-18T10:00:00.000Z'), false);
  assert.equal(isWhopEventNewer(null, '2026-08-18T10:00:00.000Z'), false);
});

test('only Reseller receives unlimited simultaneous orders', () => {
  const scale = getUserAccessState({
    ...user,
    plan: 'unlimited',
    whop_membership_id: 'mem_scale',
    whop_membership_status: 'active',
    whop_plan_id: WHOP_PLAN_IDS.unlimited,
    has_concurrent_orders: 1,
  });
  const reseller = getUserAccessState({
    ...user,
    plan: 'agency',
    whop_membership_id: 'mem_reseller',
    whop_membership_status: 'active',
    whop_plan_id: WHOP_PLAN_IDS.agency,
  });
  assert.equal(scale.hasConcurrentOrders, false);
  assert.equal(scale.hasUnlimitedOrders, false);
  assert.equal(scale.maxConcurrentOrders, 1);
  assert.equal(reseller.hasConcurrentOrders, true);
  assert.equal(reseller.hasUnlimitedOrders, true);
  assert.equal(reseller.maxConcurrentOrders, Infinity);
});
