import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTenantCheckoutConfiguration,
  createTenantSavedCardPayment,
  normalizeTenantSelection,
  isTenantPurchasePayment,
  previewTenantPromo,
  tenantSubtotalCents,
  validateTenantPaymentForPurchase,
} from '../services/tenantBilling.js';

test('tenant offers charge the exact requested US and Asian prices', () => {
  const us = normalizeTenantSelection({ licenseType: 'premium', quantity: 3 });
  const asia = normalizeTenantSelection({ licenseType: 'normal', quantity: 3 });
  assert.equal(us.unitPriceCents, 1649);
  assert.equal(tenantSubtotalCents(us), 4947);
  assert.equal(asia.unitPriceCents, 1349);
  assert.equal(tenantSubtotalCents(asia), 4047);
});

test('tenant coupon preview handles Whop fractional percentages', () => {
  assert.deepEqual(previewTenantPromo({ promo_type: 'percentage', amount_off: 0.2 }, 1649), {
    discountCents: 330,
    totalCents: 1319,
    promoType: 'percentage',
    amountOff: 20,
  });
});

test('saved-card tenant payments use immutable metadata and a stable idempotency key', async () => {
  let payload;
  let options;
  const client = { payments: { create: async (input, opts) => {
    payload = input;
    options = opts;
    return { id: 'pay_tenant', status: 'pending', plan: { id: 'plan_tenant' } };
  } } };
  const user = { id: 7, email: 'Buyer@Example.com', whop_member_id: 'mber_7', whop_payment_method_id: 'pmt_7' };
  const purchase = { id: 91 };
  const selection = normalizeTenantSelection({ licenseType: 'premium', quantity: 2 });
  await createTenantSavedCardPayment(client, { user, purchase, selection, promoCodeId: 'promo_1' });

  assert.equal(payload.member_id, 'mber_7');
  assert.equal(payload.payment_method_id, 'pmt_7');
  assert.equal(payload.plan.initial_price, 32.98);
  assert.equal(payload.plan.plan_type, 'one_time');
  assert.equal(payload.metadata.tenant_purchase_id, '91');
  assert.equal(payload.metadata.user_id, '7');
  assert.equal(payload.metadata.quantity, '2');
  assert.equal(payload.promo_code_id, 'promo_1');
  assert.equal(options.idempotencyKey, 'ui.tenant-purchase.91.payment');
});

test('tenant fallback checkout is account-bound and returns an embeddable session', async () => {
  let payload;
  const client = { checkoutConfigurations: { create: async (input) => {
    payload = input;
    return { id: 'ch_tenant', purchase_url: 'https://whop.com/checkout/test', plan: { id: 'plan_tenant' } };
  } } };
  const user = { id: 7, email: 'buyer@example.com' };
  const purchase = { id: 91 };
  const selection = normalizeTenantSelection({ licenseType: 'normal', quantity: 1 });
  const result = await createTenantCheckoutConfiguration(client, {
    user, purchase, selection, redirectUrl: 'https://app.example.com/tenants/checkout?purchase=91', promoCode: 'SAVE',
  });

  assert.ok(payload.account_id);
  assert.equal(payload.mode, 'payment');
  assert.equal(payload.plan.initial_price, 13.49);
  assert.equal(payload.metadata.purpose, 'tenant_purchase');
  assert.equal(result.sessionId, 'ch_tenant');
  assert.equal(result.promoCode, 'SAVE');
});

test('tenant payment confirmation rejects metadata from another purchase', () => {
  const purchase = {
    id: 91, user_id: 7, tenant_type: 'usTenant', quantity: 2,
    unit_price_cents: 1649, whop_plan_id: 'plan_tenant', promo_code_id: null,
  };
  const payment = {
    id: 'pay_tenant', plan: { id: 'plan_tenant' },
    metadata: {
      purpose: 'tenant_purchase', tenant_purchase_id: '92', user_id: '7',
      tenant_type: 'usTenant', quantity: '2', unit_price_cents: '1649',
    },
  };
  assert.equal(validateTenantPaymentForPurchase(payment, purchase), false);
  payment.metadata.tenant_purchase_id = '91';
  assert.equal(validateTenantPaymentForPurchase(payment, purchase), true);
});

test('tenant purchase metadata also identifies one-time membership events for webhook isolation', () => {
  assert.equal(isTenantPurchasePayment({
    id: 'mem_one_time',
    metadata: { purpose: 'tenant_purchase', tenant_purchase_id: '91' },
  }), true);
  assert.equal(isTenantPurchasePayment({
    id: 'mem_subscription',
    metadata: { purpose: 'subscription' },
  }), false);
});
