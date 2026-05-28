import Stripe from 'stripe';

const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://app.unlimitedinboxes.com';

const stripe = STRIPE_SECRET ? new Stripe(STRIPE_SECRET) : null;

export const STRIPE_PRICES = {
  intro: process.env.STRIPE_PRICE_STANDARD || 'price_1TbHWaAxRfptSO4wXcE515Wk',
  standard: process.env.STRIPE_PRICE_STANDARD || 'price_1TbHWaAxRfptSO4wXcE515Wk',
  advanced: process.env.STRIPE_PRICE_ADVANCED || 'price_1TbHWvAxRfptSO4wlWaP27vd',
  usTenant: process.env.STRIPE_PRICE_US_TENANT || 'price_1TbHYGAxRfptSO4wUPFKNgvU',
  asiaTenant: process.env.STRIPE_PRICE_ASIA_TENANT || 'price_1TbHXwAxRfptSO4wcYK8gYnI',
};

export const PLAN_PRICES = {
  intro: 0,
  standard: 99.99,
  advanced: 199.99,
  usTenant: 21.99,
  asiaTenant: 16.99,
};

export const PLAN_TRIAL_DAYS = {
  intro: Number(process.env.STRIPE_INTRO_TRIAL_DAYS || 3),
};

export function isStripeConfigured() {
  return Boolean(STRIPE_SECRET && STRIPE_SECRET.startsWith('sk_') && stripe);
}

function client() {
  if (!isStripeConfigured()) {
    throw new Error('Stripe is not configured.');
  }
  return stripe;
}

function baseUrl(opts = {}) {
  return String(opts.appBaseUrl || APP_BASE_URL).replace(/\/+$/, '');
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  );
}

function planForProduct(product, status) {
  if (status === 'trialing') return 'intro';
  if (product === 'advanced') return 'advanced';
  if (product === 'standard' || product === 'intro') return 'standard';
  return 'free';
}

function centsForTenantPurchase(tenantType, quantity) {
  const unit = PLAN_PRICES[tenantType];
  if (!unit) throw new Error(`Unknown tenant type: ${tenantType}`);
  return Math.round(unit * 100) * quantity;
}

function customerParam(user) {
  if (user?.stripe_customer_id) {
    return { customer: user.stripe_customer_id };
  }
  return { customer_email: user.email };
}

export function getTenantPurchaseAmountCents(tenantType, quantity) {
  return centsForTenantPurchase(tenantType, quantity);
}

export async function createStripeCheckoutSession(user, planKey, opts = {}) {
  const priceId = STRIPE_PRICES[planKey];
  if (!priceId) throw new Error(`Unknown plan key: ${planKey}`);

  const isTrial = planKey === 'intro';
  const successUrl = `${baseUrl(opts)}/billing?billing=success&session_id={CHECKOUT_SESSION_ID}&intent=${planKey}`;
  const cancelUrl = opts.cancelUrl || `${baseUrl(opts)}/billing?intent=${planKey}`;

  const sessionParams = compactObject({
    mode: 'subscription',
    ...customerParam(user),
    line_items: [{ price: priceId, quantity: opts.quantity || 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      type: 'subscription',
      user_id: String(user.id),
      user_email: user.email,
      plan_key: planKey,
      ...(opts.metadata || {}),
    },
    subscription_data: compactObject({
      trial_period_days: isTrial ? PLAN_TRIAL_DAYS.intro : undefined,
      metadata: {
        user_id: String(user.id),
        plan_key: planKey,
      },
    }),
    billing_address_collection: 'auto',
    phone_number_collection: { enabled: false },
    payment_method_collection: 'always',
    allow_promotion_codes: false,
  });

  const session = await client().checkout.sessions.create(sessionParams);

  return {
    sessionId: session.id,
    clientSecret: session.client_secret,
    url: session.url,
    customerId: session.customer,
  };
}

export async function createTenantCheckoutSession(user, tenantType, quantity, opts = {}) {
  const priceId = STRIPE_PRICES[tenantType];
  if (!priceId) throw new Error(`Unknown tenant type: ${tenantType}`);

  const successUrl = `${baseUrl(opts)}/tenants?tenant_purchase=success&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = opts.cancelUrl || `${baseUrl(opts)}/tenants`;

  const session = await client().checkout.sessions.create(compactObject({
    mode: 'payment',
    ...customerParam(user),
    customer_creation: user.stripe_customer_id ? undefined : 'always',
    line_items: [{ price: priceId, quantity }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      type: 'tenant_purchase',
      user_id: String(user.id),
      user_email: user.email,
      tenant_type: tenantType,
      quantity: String(quantity),
      ...(opts.metadata || {}),
    },
    payment_intent_data: {
      setup_future_usage: 'off_session',
      metadata: {
        type: 'tenant_purchase',
        user_id: String(user.id),
        tenant_type: tenantType,
        quantity: String(quantity),
      },
    },
    billing_address_collection: 'auto',
    phone_number_collection: { enabled: false },
    allow_promotion_codes: false,
  }));

  return {
    sessionId: session.id,
    url: session.url,
    customerId: session.customer,
  };
}

async function getDefaultPaymentMethodId(user) {
  if (!user?.stripe_customer_id) return null;

  if (user.stripe_subscription_id) {
    try {
      const sub = await client().subscriptions.retrieve(user.stripe_subscription_id, {
        expand: ['default_payment_method'],
      });
      const subPaymentMethod = sub.default_payment_method;
      if (typeof subPaymentMethod === 'string') return subPaymentMethod;
      if (subPaymentMethod?.id) return subPaymentMethod.id;
    } catch {
      // Fall back to customer invoice settings.
    }
  }

  const customer = await client().customers.retrieve(user.stripe_customer_id, {
    expand: ['invoice_settings.default_payment_method'],
  });

  const defaultMethod = customer?.invoice_settings?.default_payment_method;
  if (typeof defaultMethod === 'string') return defaultMethod;
  return defaultMethod?.id || null;
}

export async function chargeSavedPaymentMethodForTenantPurchase(user, tenantType, quantity) {
  if (!user?.stripe_customer_id) {
    return { paid: false, reason: 'no_customer' };
  }

  const paymentMethodId = await getDefaultPaymentMethodId(user);
  if (!paymentMethodId) {
    return { paid: false, reason: 'no_default_payment_method' };
  }

  try {
    const paymentIntent = await client().paymentIntents.create({
      amount: centsForTenantPurchase(tenantType, quantity),
      currency: 'usd',
      customer: user.stripe_customer_id,
      payment_method: paymentMethodId,
      off_session: true,
      confirm: true,
      description: `${quantity} ${tenantType === 'usTenant' ? 'US IP' : 'Asia IP'} tenant${quantity === 1 ? '' : 's'}`,
      metadata: {
        type: 'tenant_purchase',
        user_id: String(user.id),
        tenant_type: tenantType,
        quantity: String(quantity),
      },
    });

    return {
      paid: paymentIntent.status === 'succeeded',
      paymentIntent,
      reason: paymentIntent.status,
    };
  } catch (error) {
    return {
      paid: false,
      reason: error.code || error.type || 'payment_failed',
      error,
    };
  }
}

export async function retrieveCheckoutSession(sessionId) {
  return client().checkout.sessions.retrieve(sessionId, {
    expand: ['subscription', 'customer', 'payment_intent'],
  });
}

export function isCheckoutSessionComplete(session) {
  return session.payment_status === 'paid'
    || session.payment_status === 'no_payment_required'
    || session.status === 'complete';
}

export async function getPendingInvoice(customerId) {
  if (!customerId) return null;
  const invoices = await client().invoices.list({
    customer: customerId,
    status: 'open',
    limit: 1,
  });
  return invoices.data[0] || null;
}

export async function getSubscription(subscriptionId) {
  return client().subscriptions.retrieve(subscriptionId, {
    expand: ['items.data.price', 'customer', 'latest_invoice', 'default_payment_method'],
  });
}

export async function createCustomerPortalSession(_user, stripeCustomerId, opts = {}) {
  if (!stripeCustomerId) {
    throw new Error('No Stripe customer ID for this user.');
  }

  return client().billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: `${baseUrl(opts)}/orders`,
  });
}

export async function cancelSubscription(subscriptionId) {
  return client().subscriptions.update(subscriptionId, {
    cancel_at_period_end: true,
  });
}

export async function cancelSubscriptionNow(subscriptionId) {
  return client().subscriptions.cancel(subscriptionId);
}

export async function getOrCreateStripeCustomer(user) {
  if (user.stripe_customer_id) {
    try {
      const customer = await client().customers.retrieve(user.stripe_customer_id);
      if (!customer.deleted) return customer;
    } catch {
      // Create a replacement customer below.
    }
  }

  return client().customers.create({
    email: user.email,
    name: user.name || user.email,
    metadata: { user_id: String(user.id) },
  });
}

export function verifyStripeWebhookSignature(payload, sig) {
  if (!STRIPE_WEBHOOK_SECRET) {
    console.warn('[stripe] STRIPE_WEBHOOK_SECRET not set - skipping webhook verification');
    return JSON.parse(payload);
  }
  return client().webhooks.constructEvent(payload, sig, STRIPE_WEBHOOK_SECRET);
}

export function serializeStripeBillingState(user) {
  const subStatus = String(user?.stripe_subscription_status || '').toLowerCase();
  const product = String(user?.stripe_product || '').trim();
  const hasActiveSub = subStatus === 'active' || subStatus === 'trialing';
  const isPaid = subStatus === 'active';
  const isTrialing = subStatus === 'trialing';
  const isPastDue = subStatus === 'past_due' || subStatus === 'unpaid';
  const isCanceled = ['canceled', 'incomplete_expired', 'paused'].includes(subStatus);
  const isCancelledAtPeriodEnd = !!user?.stripe_cancel_at_period_end;
  const introOfferUsed = !!user?.stripe_intro_offer_used || !!user?.stripe_subscription_id;

  const effectivePlan = hasActiveSub ? planForProduct(product, subStatus) : 'free';
  const paidTier = isPaid ? planForProduct(product, subStatus) : null;

  let canAccessApp = false;
  let downloadAllowance = 0;
  let maxConcurrentOrders = 0;
  let canUseCustomNames = false;
  let canDownloadAll = false;
  let canCreateMoreThanOneCompletedOrder = false;
  let canOpenInboxesPage = false;
  let unlimitedConcurrency = false;

  if (isTrialing) {
    canAccessApp = true;
    downloadAllowance = 10;
    maxConcurrentOrders = 1;
    canOpenInboxesPage = true;
  } else if (isPaid && paidTier === 'standard') {
    canAccessApp = true;
    downloadAllowance = Infinity;
    maxConcurrentOrders = 1;
    canUseCustomNames = true;
    canOpenInboxesPage = true;
    canDownloadAll = true;
    canCreateMoreThanOneCompletedOrder = true;
  } else if (isPaid && paidTier === 'advanced') {
    canAccessApp = true;
    downloadAllowance = Infinity;
    maxConcurrentOrders = Infinity;
    canUseCustomNames = true;
    canOpenInboxesPage = true;
    canDownloadAll = true;
    canCreateMoreThanOneCompletedOrder = true;
    unlimitedConcurrency = true;
  }

  let blockingReason = null;
  let needsIntroOffer = false;
  let needsPaidSubscription = false;
  let recommendedCheckoutIntent = null;

  if (!canAccessApp) {
    if (isPastDue) {
      blockingReason = 'payment_overdue';
      needsPaidSubscription = true;
      recommendedCheckoutIntent = 'retry';
    } else if (!introOfferUsed) {
      blockingReason = 'needs_intro_offer';
      needsIntroOffer = true;
      recommendedCheckoutIntent = 'intro';
    } else {
      blockingReason = isCanceled ? 'subscription_inactive' : 'needs_paid_subscription';
      needsPaidSubscription = true;
      recommendedCheckoutIntent = 'standard';
    }
  }

  return {
    configured: isStripeConfigured(),
    provider: 'stripe',
    plan: effectivePlan,
    isPaid,
    isTrialing,
    isPastDue,
    isCanceled,
    isCancelledAtPeriodEnd,
    introOfferUsed,
    canAccessApp,
    canUseCustomNames,
    canOpenInboxesPage,
    canDownloadAll,
    canCreateMoreThanOneCompletedOrder,
    completedOrderQuotaReached: false,
    downloadAllowance,
    lifetimeCompletedOrders: user?.lifetime_completed_orders || 0,
    maxConcurrentOrders,
    unlimitedConcurrency,
    subscriptionTier: isTrialing ? 'intro' : paidTier,
    subscriptionStatus: subStatus || null,
    paymentStatus: user?.stripe_last_payment_status || 'unknown',
    invoiceStatus: user?.stripe_last_invoice_status || 'unknown',
    renewalPeriodEnd: user?.stripe_current_period_end || null,
    trialEndsAt: user?.stripe_trial_ends_at || null,
    cancelAtPeriodEnd: isCancelledAtPeriodEnd,
    needsIntroOffer,
    needsPaidSubscription,
    needsPaymentMethodUpdate: isPastDue,
    blockingReason,
    recommendedCheckoutIntent,
    hasBillingPortal: !!user?.stripe_customer_id,
    hasBillingIssue: isPastDue,
    overdueInvoiceId: isPastDue ? user?.stripe_last_invoice_id || null : null,
    overdueInvoiceUrl: isPastDue ? user?.stripe_last_invoice_url || null : null,
  };
}

export default stripe;
