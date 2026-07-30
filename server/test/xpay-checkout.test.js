import assert from 'node:assert/strict';
import test from 'node:test';

import {
 buildOneTimeCheckoutPayload,
 createOneTimeCheckout,
} from '../services/xpay.js';

const user = {
 id: 42,
 email: 'customer@example.com',
 name: 'Test Customer',
 phone: '+14155552671',
 country: 'US',
};

test('builds the supported xPay $1 checkout payload', () => {
 const payload = buildOneTimeCheckoutPayload({
 user,
 customerId: 'cus_test',
 amount: 100,
 description: 'Starter Plan Trial - $1 for 100 Inboxes',
 receiptId: 'trial_auth_42_123',
 callbackUrl: 'https://app.example.com/billing?billing=success&intent=starter',
 cancelUrl: 'https://app.example.com/billing?intent=starter',
 metadata: { purpose: 'trial_auth', user_id: '42' },
 });

 assert.equal(payload.amount, 100);
 assert.equal(payload.currency, 'USD');
 assert.equal(payload.customerId, 'cus_test');
 assert.equal(payload.customerDetails.email, user.email);
 assert.equal(payload.callbackUrl, 'https://app.example.com/billing?billing=success&intent=starter');
 assert.equal(payload.tokenise, true);
 assert.deepEqual(payload.paymentMethods, ['CARD', 'APPLE_PAY', 'GOOGLE_PAY']);
});

test('uses /payments/create-intent and normalizes the hosted checkout response', async () => {
 const calls = [];
 const client = {
  async request(...args) {
   calls.push(args);
   return {
    xIntentId: 'in_test',
    fwdUrl: 'https://pay.xpaycheckout.com/?xpay_intent_id=in_test',
   };
  },
 };

 const checkout = await createOneTimeCheckout(client, {
  user,
  customerId: 'cus_test',
  amount: 100,
  description: 'Starter Plan Trial - $1 for 100 Inboxes',
  receiptId: 'trial_auth_42_123',
  callbackUrl: 'https://app.example.com/billing?billing=success&intent=starter',
  cancelUrl: 'https://app.example.com/billing?intent=starter',
  metadata: { purpose: 'trial_auth', user_id: '42' },
 });

 assert.equal(calls.length, 1);
 assert.equal(calls[0][0], 'POST');
 assert.equal(calls[0][1], '/payments/create-intent');
 assert.notEqual(calls[0][1], '/billing/checkout');
 assert.equal(checkout.intentId, 'in_test');
 assert.equal(checkout.redirectUrl, 'https://pay.xpaycheckout.com/?xpay_intent_id=in_test');
});

test('rejects malformed provider responses before returning them to the browser', async () => {
 const client = {
  async request() {
   return { status: 'CREATED' };
  },
 };

 await assert.rejects(
  createOneTimeCheckout(client, {
   user,
   customerId: 'cus_test',
   amount: 100,
   description: 'Starter Plan Trial - $1 for 100 Inboxes',
   receiptId: 'trial_auth_42_123',
   callbackUrl: 'https://app.example.com/billing?billing=success&intent=starter',
   cancelUrl: 'https://app.example.com/billing?intent=starter',
   metadata: { purpose: 'trial_auth', user_id: '42' },
  }),
  /Failed to create payment intent/
 );
});
