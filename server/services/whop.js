import { Whop } from '@whop/sdk';

export const WHOP_COMPANY_ID = process.env.WHOP_COMPANY_ID || 'biz_D0LbQ5wpeG8tff';

export const WHOP_PLAN_IDS = Object.freeze({
  intro: process.env.WHOP_INTRO_PLAN_ID || 'plan_rxQPKoOgjPEUb',
  basic: process.env.WHOP_BASIC_PLAN_ID || 'plan_GsCzwaQhtYIGf',
  starter: process.env.WHOP_500_PLAN_ID || 'plan_zRPfZG7H5OqqP',
  growth: process.env.WHOP_1500_PLAN_ID || 'plan_mwnSu07Zg78Wc',
  unlimited: process.env.WHOP_UNLIMITED_PLAN_ID || 'plan_goBXPy3cRF2jA',
  agency: process.env.WHOP_AGENCY_PLAN_ID || 'plan_LurB2EuRknNzn',
});

export const WHOP_PLAN_DETAILS = Object.freeze({
  [WHOP_PLAN_IDS.intro]: { key: 'basic', inboxesLimit: 100, concurrentOrders: 1, intro: true },
  [WHOP_PLAN_IDS.basic]: { key: 'basic', inboxesLimit: 100, concurrentOrders: 1 },
  [WHOP_PLAN_IDS.starter]: { key: 'starter', inboxesLimit: 500, concurrentOrders: 1 },
  [WHOP_PLAN_IDS.growth]: { key: 'growth', inboxesLimit: 1500, concurrentOrders: 1 },
  [WHOP_PLAN_IDS.unlimited]: { key: 'unlimited', inboxesLimit: Infinity, concurrentOrders: 1 },
  [WHOP_PLAN_IDS.agency]: { key: 'agency', inboxesLimit: Infinity, concurrentOrders: Infinity },
});

const SENDS_PER_INBOX = 150;

export const WHOP_PLAN_CATALOG = Object.freeze([
  {
    key: 'trial', name: 'Free Trial', planId: WHOP_PLAN_IDS.intro, priceCents: 0,
    inboxesLimit: 10, monthlySends: 10 * SENDS_PER_INBOX, concurrentOrders: 1,
    apiAndMcp: false, domainRedirects: false, customNames: false, trial: true,
  },
  {
    key: 'basic', name: 'Tester', planId: WHOP_PLAN_IDS.basic, priceCents: 999,
    inboxesLimit: 100, monthlySends: 100 * SENDS_PER_INBOX, concurrentOrders: 1,
    apiAndMcp: true, domainRedirects: true, customNames: true,
  },
  {
    key: 'starter', name: 'Growth', planId: WHOP_PLAN_IDS.starter, priceCents: 3999,
    inboxesLimit: 500, monthlySends: 500 * SENDS_PER_INBOX, concurrentOrders: 1,
    apiAndMcp: true, domainRedirects: true, customNames: true,
  },
  {
    key: 'growth', name: 'Pro', planId: WHOP_PLAN_IDS.growth, priceCents: 9999,
    inboxesLimit: 1500, monthlySends: 1500 * SENDS_PER_INBOX, concurrentOrders: 1,
    apiAndMcp: true, domainRedirects: true, customNames: true,
  },
  {
    key: 'unlimited', name: 'Scale', planId: WHOP_PLAN_IDS.unlimited, priceCents: 19999,
    inboxesLimit: Infinity, monthlySends: Infinity, concurrentOrders: 1,
    apiAndMcp: true, domainRedirects: true, customNames: true,
  },
  {
    key: 'agency', name: 'Reseller', planId: WHOP_PLAN_IDS.agency, priceCents: 29999,
    inboxesLimit: Infinity, monthlySends: Infinity, concurrentOrders: Infinity,
    apiAndMcp: true, domainRedirects: true, customNames: true,
  },
]);

export const WHOP_PAID_PLAN_CATALOG = Object.freeze(WHOP_PLAN_CATALOG.filter((plan) => !plan.trial));

export function getWhopCatalogPlan(planKeyOrId) {
  const wanted = String(planKeyOrId || '').trim().toLowerCase();
  return WHOP_PLAN_CATALOG.find((plan) => plan.key === wanted || plan.planId.toLowerCase() === wanted) || null;
}

export function serializeWhopPlanCatalog() {
  return WHOP_PLAN_CATALOG.map((plan, index) => ({
    ...plan,
    inboxesLimit: plan.inboxesLimit === Infinity ? null : plan.inboxesLimit,
    monthlySends: plan.monthlySends === Infinity ? null : plan.monthlySends,
    concurrentOrders: plan.concurrentOrders === Infinity ? null : plan.concurrentOrders,
    unlimitedInboxes: plan.inboxesLimit === Infinity,
    unlimitedSends: plan.monthlySends === Infinity,
    unlimitedConcurrentOrders: plan.concurrentOrders === Infinity,
    rank: index,
    currency: 'USD',
    billingIntervalDays: plan.trial ? null : 28,
  }));
}

function sdkOptions() {
  const options = { apiKey: process.env.WHOP_API_KEY || 'not-configured' };
  if (process.env.WHOP_WEBHOOK_SECRET) {
    options.webhookKey = Buffer.from(process.env.WHOP_WEBHOOK_SECRET).toString('base64');
  }
  return options;
}

export const whop = new Whop(sdkOptions());
whop.configured = Boolean(process.env.WHOP_API_KEY);
whop.webhookConfigured = Boolean(process.env.WHOP_WEBHOOK_SECRET);

export function getWhopPlanDetails(planId) {
  return WHOP_PLAN_DETAILS[String(planId || '')] || null;
}

export function selectInitialWhopPlan(user) {
  const usedIntro = Boolean(
    user?.whop_intro_offer_used
    || user?.xpay_intro_offer_used
    || user?.xpay_subscription_id
    || ['trial', 'basic', 'starter', 'growth', 'unlimited', 'agency'].includes(user?.plan)
  );
  return usedIntro ? WHOP_PLAN_IDS.basic : WHOP_PLAN_IDS.intro;
}

export async function createWhopCheckout(client, {
  user,
  planId,
  redirectUrl,
  sourceUrl: _sourceUrl,
  purpose,
  idempotencyKey,
  planChangeId,
}) {
  if (!user?.id || !user?.email) throw new Error('A signed-in user is required.');
  if (!getWhopPlanDetails(planId)) throw new Error('Unknown Whop plan.');

  const checkout = await client.checkoutConfigurations.create({
    plan_id: planId,
    redirect_url: redirectUrl || null,
    metadata: {
      user_id: String(user.id),
      app_user_id: String(user.id),
      email: String(user.email).trim().toLowerCase(),
      purpose: purpose || (planId === WHOP_PLAN_IDS.intro ? 'intro_subscription' : 'subscription'),
      plan_id: planId,
      ...(planChangeId ? { plan_change_id: String(planChangeId) } : {}),
    },
  }, idempotencyKey ? { idempotencyKey } : undefined);

  if (!checkout?.id || !checkout?.purchase_url) {
    throw new Error('Whop did not return a valid checkout configuration.');
  }

  return {
    sessionId: checkout.id,
    purchaseUrl: checkout.purchase_url,
    planId: checkout.plan?.id || planId,
  };
}

export async function listWhopPromoCodes(client, planId) {
  const promos = [];
  for await (const promo of client.promoCodes.list({
    company_id: WHOP_COMPANY_ID,
    status: 'active',
    ...(planId ? { plan_ids: [planId] } : {}),
    first: 100,
  })) promos.push(promo);
  return promos;
}

export async function validateWhopPromoCode(client, { code, planKey }) {
  const wanted = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,64}$/.test(wanted)) throw new Error('Enter a valid coupon code.');
  const target = getWhopCatalogPlan(planKey);
  if (!target || target.trial) throw new Error('Select a paid plan before applying a coupon.');

  const [targetPromos, companyPromos] = await Promise.all([
    listWhopPromoCodes(client, target.planId),
    listWhopPromoCodes(client),
  ]);
  const eligibleIds = new Set(targetPromos.map((promo) => String(promo.id || '')));
  const promo = companyPromos.find((item) => {
    if (String(item.code || '').trim().toUpperCase() !== wanted) return false;
    return eligibleIds.has(String(item.id || '')) || !item.product;
  });
  if (!promo) throw new Error(`This coupon code is invalid or is not available for ${target.name}.`);
  if (promo.expires_at && new Date(promo.expires_at).getTime() <= Date.now()) throw new Error('This coupon code has expired.');
  if (!promo.unlimited_stock && Number(promo.uses || 0) >= Number(promo.stock || 0)) {
    throw new Error('This coupon code has reached its usage limit.');
  }

  const promoType = promo.promo_type === 'flat_amount' ? 'flat_amount' : 'percentage';
  const rawAmountOff = Math.max(0, Number(promo.amount_off || 0));
  const amountOff = promoType === 'percentage' && rawAmountOff <= 1 ? rawAmountOff * 100 : rawAmountOff;
  const savingsCents = Math.min(target.priceCents, promoType === 'percentage'
    ? Math.round(target.priceCents * amountOff / 100)
    : Math.round(amountOff * 100));
  const durationMonths = Math.max(0, Math.floor(Number(promo.promo_duration_months || 0)));
  const duration = promo.duration === 'forever' ? 'forever' : (promo.duration === 'repeating' || durationMonths > 1 ? 'repeating' : 'once');

  return {
    id: String(promo.id), code: wanted, promoType, amountOff,
    savingsCents, priceCents: Math.max(0, target.priceCents - savingsCents),
    duration, durationMonths,
    durationLabel: duration === 'forever' ? 'Every billing period' : (duration === 'repeating' ? `${durationMonths} billing periods` : 'First billing period'),
  };
}

export function isWhopPaymentPaid(payment = {}) {
  return ['paid', 'succeeded'].includes(getWhopStatus(payment.status))
    || getWhopStatus(payment.substatus) === 'succeeded';
}

export function isWhopPaymentFailed(payment = {}) {
  return ['uncollectible', 'unresolved', 'void', 'failed', 'past_due', 'canceled']
    .includes(getWhopStatus(payment.substatus || payment.status));
}

export async function createWhopSavedCardPayment(client, {
  user, planId, promoCodeId, idempotencyKey, planChangeId,
}) {
  if (!user?.whop_member_id || !user?.whop_payment_method_id) {
    throw new Error('A saved Whop payment method is required.');
  }
  if (!getWhopPlanDetails(planId) || planId === WHOP_PLAN_IDS.intro) throw new Error('Unknown paid Whop plan.');
  return client.payments.create({
    company_id: WHOP_COMPANY_ID,
    member_id: String(user.whop_member_id),
    payment_method_id: String(user.whop_payment_method_id),
    plan_id: planId,
    ...(promoCodeId ? { promo_code_id: promoCodeId } : {}),
    metadata: {
      user_id: String(user.id), app_user_id: String(user.id),
      email: String(user.email).trim().toLowerCase(),
      purpose: 'plan_change', plan_id: planId,
      ...(planChangeId ? { plan_change_id: String(planChangeId) } : {}),
    },
  }, { idempotencyKey });
}

export function unwrapWhopWebhook(client, rawBody, headers) {
  if (!rawBody) throw new Error('Missing webhook body.');
  return client.webhooks.unwrap(rawBody, { headers });
}

export function serializeBillingAddress(address) {
  if (!address || typeof address !== 'object') return null;
  const normalized = {
    name: address.name ?? address.fullName ?? address.full_name,
    line1: address.line1 ?? address.addressLine1 ?? address.address_line_1,
    line2: address.line2 ?? address.addressLine2 ?? address.address_line_2,
    city: address.city,
    state: address.state ?? address.region,
    postal_code: address.postal_code ?? address.postalCode ?? address.zip,
    country: address.country ?? address.countryCode ?? address.country_code,
  };
  const clean = Object.fromEntries(
    ['name', 'line1', 'line2', 'city', 'state', 'postal_code', 'country']
      .map((key) => [key, normalized[key] ?? null])
      .filter(([, value]) => value !== null && value !== '')
  );
  return Object.keys(clean).length ? JSON.stringify(clean) : null;
}

export function normalizeWhopDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function getWhopStatus(status) {
  return String(status || '').trim().toLowerCase();
}

export function isWhopMembershipActive(status) {
  return ['trialing', 'active', 'canceling'].includes(getWhopStatus(status));
}

export function getWhopEventTime(value) {
  return normalizeWhopDate(value?.created_at || value?.updated_at || value?.occurred_at || value);
}

export function isWhopEventNewer(incoming, stored) {
  const incomingTime = getWhopEventTime(incoming);
  const storedTime = normalizeWhopDate(stored);
  if (!storedTime) return true;
  if (!incomingTime) return false;
  return new Date(incomingTime).getTime() >= new Date(storedTime).getTime();
}

export function buildWhopMembershipUpdates(membership = {}) {
  const planId = membership.plan?.id || membership.plan_id || null;
  const details = getWhopPlanDetails(planId);
  const status = getWhopStatus(membership.status);
  const active = isWhopMembershipActive(status);
  const updates = {
    whop_membership_id: membership.id ? String(membership.id) : undefined,
    whop_membership_status: status || undefined,
    whop_plan_id: planId ? String(planId) : undefined,
    whop_member_id: membership.member?.id ? String(membership.member.id) : undefined,
    whop_current_period_end: normalizeWhopDate(membership.renewal_period_end) || undefined,
    whop_cancel_at_period_end: membership.cancel_at_period_end ? 1 : 0,
  };

  if (details) {
    updates.plan = active ? (details.intro && status !== 'active' ? 'trial' : details.key) : 'free';
    updates.inboxes_limit = active && Number.isFinite(details.inboxesLimit)
      ? details.inboxesLimit
      : (active ? -1 : 0);
    updates.has_concurrent_orders = active && details.concurrentOrders === Infinity ? 1 : 0;
    if (details.intro && active) updates.whop_intro_offer_used = 1;
  }
  return updates;
}
