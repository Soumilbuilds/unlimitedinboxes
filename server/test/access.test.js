import assert from 'node:assert/strict';
import test from 'node:test';

import { hasUsedIntroOffer } from '../services/access.js';
import { serializeXpayBillingState } from '../routes/billing.js';

test('creating an xPay customer does not consume the $1 intro offer', () => {
 assert.equal(hasUsedIntroOffer({
  plan: 'free',
  xpay_customer_id: 'cus_checkout_abandoned',
  xpay_intro_offer_used: 0,
 }), false);
});

test('a completed intro checkout consumes the $1 intro offer', () => {
 assert.equal(hasUsedIntroOffer({
  plan: 'trial',
  xpay_customer_id: 'cus_paid',
  xpay_intro_offer_used: 1,
 }), true);
});

test('billing status exposes trial access to the Orders page', () => {
 const trialEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
 const status = serializeXpayBillingState({
  id: 42,
  email: 'customer@example.com',
  plan: 'trial',
  xpay_subscription_plan: 'starter',
  xpay_subscription_status: 'TRIALING',
  xpay_trial_ends_at: trialEnd,
  xpay_intro_offer_used: 1,
  inboxes_used: 0,
 });

 assert.equal(status.canAccessApp, true);
 assert.equal(status.blockingReason, null);
 assert.equal(status.isTrialing, true);
 assert.equal(status.inboxesLimit, 100);
});
