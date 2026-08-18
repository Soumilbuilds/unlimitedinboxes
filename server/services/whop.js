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
      purpose: planId === WHOP_PLAN_IDS.intro ? 'intro_subscription' : 'subscription',
      plan_id: planId,
    },
  });

  if (!checkout?.id || !checkout?.purchase_url) {
    throw new Error('Whop did not return a valid checkout configuration.');
  }

  return {
    sessionId: checkout.id,
    purchaseUrl: checkout.purchase_url,
    planId: checkout.plan?.id || planId,
  };
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
