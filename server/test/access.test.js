import assert from 'node:assert/strict';
import test from 'node:test';

import { hasUsedIntroOffer } from '../services/access.js';

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
