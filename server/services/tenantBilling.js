import { WHOP_COMPANY_ID } from './whop.js';

export const WHOP_TENANT_PRODUCT_ID = process.env.WHOP_TENANT_PRODUCT_ID || 'prod_N3Pg3XZojQAQp';

export const TENANT_OFFERS = Object.freeze({
  premium: Object.freeze({
    licenseType: 'premium',
    tenantType: 'usTenant',
    label: 'US IP',
    unitPriceCents: 1649,
  }),
  normal: Object.freeze({
    licenseType: 'normal',
    tenantType: 'asiaTenant',
    label: 'Asian IP',
    unitPriceCents: 1349,
  }),
});

export function normalizeTenantSelection(body = {}) {
  const licenseType = String(body.licenseType || '').trim().toLowerCase();
  const offer = TENANT_OFFERS[licenseType] || null;
  const quantity = Number.parseInt(body.quantity, 10);
  if (!offer || !Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
    throw new Error('Choose A Valid Tenant Type And Quantity.');
  }
  return { ...offer, quantity };
}

export function tenantSubtotalCents(selection) {
  return selection.unitPriceCents * selection.quantity;
}

export function previewTenantPromo(promo, subtotalCents) {
  if (!promo) {
    return { discountCents: 0, totalCents: subtotalCents };
  }
  const promoType = promo.promo_type === 'flat_amount' ? 'flat_amount' : 'percentage';
  const rawAmountOff = Math.max(0, Number(promo.amount_off || 0));
  const amountOff = promoType === 'percentage' && rawAmountOff <= 1 ? rawAmountOff * 100 : rawAmountOff;
  const discountCents = Math.min(
    subtotalCents,
    promoType === 'percentage'
      ? Math.round(subtotalCents * amountOff / 100)
      : Math.round(rawAmountOff * 100),
  );
  return {
    discountCents,
    totalCents: Math.max(0, subtotalCents - discountCents),
    promoType,
    amountOff,
  };
}

export async function validateTenantPromoCode(client, { code, subtotalCents }) {
  if (!WHOP_TENANT_PRODUCT_ID) throw new Error('Tenant Billing Is Not Configured.');
  const wanted = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,64}$/.test(wanted)) throw new Error('Enter A Valid Coupon Code.');

  const list = async (filters) => {
    const values = [];
    for await (const promo of client.promoCodes.list({
      company_id: WHOP_COMPANY_ID, status: 'active', first: 100, ...filters,
    })) values.push(promo);
    return values;
  };
  const [productPromos, companyPromos] = await Promise.all([
    list({ product_ids: [WHOP_TENANT_PRODUCT_ID] }),
    list({}),
  ]);
  const eligibleIds = new Set(productPromos.map((item) => String(item.id || '')));
  const promo = companyPromos.find((item) => {
    if (String(item.code || '').trim().toUpperCase() !== wanted) return false;
    return eligibleIds.has(String(item.id || '')) || !item.product;
  });
  if (!promo) throw new Error('This Coupon Is Invalid For Tenant Purchases.');
  if (promo.expires_at && new Date(promo.expires_at).getTime() <= Date.now()) {
    throw new Error('This Coupon Has Expired.');
  }
  if (!promo.unlimited_stock && Number(promo.uses || 0) >= Number(promo.stock || 0)) {
    throw new Error('This Coupon Has Reached Its Usage Limit.');
  }
  if (promo.promo_type === 'flat_amount' && String(promo.currency || '').toLowerCase() !== 'usd') {
    throw new Error('This Coupon Cannot Be Applied To A USD Purchase.');
  }

  const preview = previewTenantPromo(promo, subtotalCents);
  return {
    id: String(promo.id),
    code: wanted,
    promoType: preview.promoType,
    amountOff: preview.amountOff,
    discountCents: preview.discountCents,
    totalCents: preview.totalCents,
    onePerCustomer: Boolean(promo.one_per_customer),
    newUsersOnly: Boolean(promo.new_users_only),
    churnedUsersOnly: Boolean(promo.churned_users_only),
    existingMembershipsOnly: Boolean(promo.existing_memberships_only),
  };
}

function tenantPlan(selection) {
  if (!WHOP_TENANT_PRODUCT_ID) throw new Error('Tenant Billing Is Not Configured.');
  return {
    currency: 'usd',
    initial_price: tenantSubtotalCents(selection) / 100,
    plan_type: 'one_time',
    product_id: WHOP_TENANT_PRODUCT_ID,
    title: `${selection.quantity} ${selection.label} Tenant${selection.quantity === 1 ? '' : 's'}`,
    description: `Microsoft tenant purchase for ${selection.quantity} ${selection.label} tenant${selection.quantity === 1 ? '' : 's'}.`,
    visibility: 'hidden',
  };
}

function tenantMetadata({ user, purchase, selection }) {
  return {
    purpose: 'tenant_purchase',
    tenant_purchase_id: String(purchase.id),
    user_id: String(user.id),
    app_user_id: String(user.id),
    email: String(user.email).trim().toLowerCase(),
    tenant_type: selection.tenantType,
    license_type: selection.licenseType,
    quantity: String(selection.quantity),
    unit_price_cents: String(selection.unitPriceCents),
    subtotal_cents: String(tenantSubtotalCents(selection)),
  };
}

export async function createTenantSavedCardPayment(client, {
  user,
  purchase,
  selection,
  promoCodeId = null,
}) {
  if (!user?.whop_member_id || !user?.whop_payment_method_id) {
    throw new Error('A Saved Whop Payment Method Is Required.');
  }
  return client.payments.create({
    company_id: WHOP_COMPANY_ID,
    member_id: String(user.whop_member_id),
    payment_method_id: String(user.whop_payment_method_id),
    plan: tenantPlan(selection),
    ...(promoCodeId ? { promo_code_id: promoCodeId } : {}),
    metadata: tenantMetadata({ user, purchase, selection }),
  }, { idempotencyKey: `ui.tenant-purchase.${purchase.id}.payment` });
}

export async function createTenantCheckoutConfiguration(client, {
  user,
  purchase,
  selection,
  redirectUrl,
  promoCode = null,
}) {
  const checkout = await client.checkoutConfigurations.create({
    account_id: WHOP_COMPANY_ID,
    mode: 'payment',
    plan: tenantPlan(selection),
    metadata: tenantMetadata({ user, purchase, selection }),
    redirect_url: redirectUrl,
  }, { idempotencyKey: `ui.tenant-purchase.${purchase.id}.checkout` });
  if (!checkout?.id || !checkout?.purchase_url || !checkout?.plan?.id) {
    throw new Error('Whop Did Not Return A Valid Tenant Checkout.');
  }
  return {
    sessionId: String(checkout.id),
    purchaseUrl: String(checkout.purchase_url),
    planId: String(checkout.plan.id),
    promoCode: promoCode || null,
  };
}

export function isTenantPurchasePayment(payment = {}) {
  return String(payment.metadata?.purpose || '') === 'tenant_purchase'
    && /^\d+$/.test(String(payment.metadata?.tenant_purchase_id || ''));
}

export function validateTenantPaymentForPurchase(payment, purchase) {
  if (!payment?.id || !purchase || !isTenantPurchasePayment(payment)) return false;
  const metadata = payment.metadata || {};
  if (String(metadata.tenant_purchase_id) !== String(purchase.id)) return false;
  if (String(metadata.user_id || metadata.app_user_id) !== String(purchase.user_id)) return false;
  if (String(metadata.tenant_type) !== String(purchase.tenant_type)) return false;
  if (Number(metadata.quantity) !== Number(purchase.quantity)) return false;
  if (Number(metadata.unit_price_cents) !== Number(purchase.unit_price_cents)) return false;
  if (payment.currency && String(payment.currency).toLowerCase() !== 'usd') return false;
  const planPrice = Number(payment.plan?.initial_price);
  if (Number.isFinite(planPrice)
    && Math.round(planPrice * 100) !== Number(purchase.subtotal_cents)) return false;
  if (purchase.whop_plan_id && String(payment.plan?.id || '') !== String(purchase.whop_plan_id)) return false;
  if (purchase.promo_code_id
    && String(payment.promo_code?.id || '') !== String(purchase.promo_code_id)) return false;
  return true;
}
