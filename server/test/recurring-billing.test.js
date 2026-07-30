import assert from 'node:assert/strict';
import test from 'node:test';

import {
 buildManagedChargePayload,
 isSuccessfulTokenizedCharge,
 processManagedBillingCycle,
} from '../services/recurringBilling.js';

function cycle(overrides = {}) {
 return {
  id: 9,
  user_id: 42,
  cycle_number: 1,
  due_at: '2026-08-06T12:00:00.000Z',
  amount_cents: 4999,
  currency: 'USD',
  receipt_id: 'starter_u42_c1',
  idempotency_key: 'starter.u42.c1',
  attempt_count: 0,
  xpay_customer_id: 'cus_test',
  xpay_default_payment_method_id: 'pmt_test',
  xpay_recurring_enabled: 1,
  xpay_cancel_at_period_end: 0,
  ...overrides,
 };
}

test('builds the exact xPay saved-card recurring payload', () => {
 assert.deepEqual(buildManagedChargePayload(cycle()), {
  pmId: 'pmt_test',
  customerId: 'cus_test',
  currency: 'USD',
  amount: 4999,
  receiptId: 'starter_u42_c1',
  metadata: {
   purpose: 'starter_recurring_charge',
   user_id: '42',
   cycle_number: '1',
  },
 });
});

test('accepts only the explicit xPay SUCCESS status', () => {
 assert.equal(isSuccessfulTokenizedCharge({ status: 'SUCCESS' }), true);
 assert.equal(isSuccessfulTokenizedCharge({ status: 'FAILED', intentId: 'in_bad' }), false);
 assert.equal(isSuccessfulTokenizedCharge({ intentId: 'in_unknown' }), false);
});

test('charges once with a stable idempotency key and advances exactly 28 days', async () => {
 const calls = [];
 const completions = [];
 const client = {
  configured: true,
  async request(...args) {
   calls.push(args);
   return { intentId: 'in_paid', status: 'SUCCESS' };
  },
 };

 const result = await processManagedBillingCycle(cycle(), {
  client,
  now: new Date('2026-08-06T12:00:05.000Z'),
  complete: (...args) => completions.push(args),
  retry: () => assert.fail('success must not be retried'),
  getLatestUser: () => cycle(),
 });

 assert.equal(result.success, true);
 assert.equal(calls.length, 1);
 assert.equal(calls[0][1], '/payments/charge-tokenised-pm');
 assert.equal(calls[0][3], 'starter.u42.c1');
 assert.equal(completions.length, 1);
 assert.equal(completions[0][1].nextDueAt.toISOString(), '2026-09-03T12:00:00.000Z');
});

test('a cancelled schedule never calls xPay', async () => {
 let charged = false;
 const result = await processManagedBillingCycle(cycle({ xpay_cancel_at_period_end: 1 }), {
  client: { async request() { charged = true; } },
 });
 assert.equal(charged, false);
 assert.deepEqual(result, { skipped: true, reason: 'recurring_disabled' });
});

test('uppercase FAILED is retried and never activates the plan', async () => {
 const retries = [];
 const result = await processManagedBillingCycle(cycle(), {
  client: {
   async request() {
    return { intentId: 'in_declined', status: 'FAILED', errorCode: 'card_declined' };
   },
  },
  now: new Date('2026-08-06T12:00:00.000Z'),
  complete: () => assert.fail('failed payment must not complete'),
  retry: (...args) => retries.push(args),
  getLatestUser: () => cycle(),
 });

 assert.equal(result.success, false);
 assert.equal(retries.length, 1);
 assert.equal(retries[0][1].providerIntentId, 'in_declined');
 assert.match(retries[0][1].error, /card_declined/);
});
