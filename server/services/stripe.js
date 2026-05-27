import Stripe from 'stripe';

const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://app.unlimitedinboxes.com';

const stripe = new Stripe(STRIPE_SECRET);

// Stripe Price IDs
export const STRIPE_PRICES = {
  intro: 'price_1TbHWaAxRfptSO4wXcE515Wk', // same as standard, but with 3-day trial
  standard: 'price_1TbHWaAxRfptSO4wXcE515Wk',
  advanced: 'price_1TbHWvAxRfptSO4wlWaP27vd',
  usTenant: 'price_1TbHYGAxRfptSO4wUPFKNgvU',
  asiaTenant: 'price_1TbHXwAxRfptSO4wcYK8gYnI',
};

export const PLAN_PRICES = {
  intro: 0,
  standard: 99.99,
  advanced: 199.99,
  usTenant: 21.99,
  asiaTenant: 16.99,
};

export const PLAN_TRIAL_DAYS = {
  intro: 3,
};

export function isStripeConfigured() {
  return !!(STRIPE_SECRET && STRIPE_SECRET.startsWith('sk_'));
}

// --- Checkout Sessions ---

/**
 * Create a Stripe Checkout Session for plan purchase.
 * @param {Object} user - { id, email, name }
 * @param {string} planKey - 'intro' | 'standard' | 'advanced'
 * @param {Object} opts - { quantity, successUrl, cancelUrl, metadata }
 */
export async function createStripeCheckoutSession(user, planKey, opts = {}) {
  const { quantity = 1, metadata = {}, returnUrl } = opts;
  const priceId = STRIPE_PRICES[planKey];
  if (!priceId) throw new Error(`Unknown plan key: ${planKey}`);

  const isTrial = planKey === 'intro';
  const isTenant = planKey === 'usTenant' || planKey === 'asiaTenant';

  // Build line items
  const lineItems = [{
    price: priceId,
    quantity,
  }];

  const sessionParams = {
    mode: 'subscription',
    customer_email: user.email,
    line_items: lineItems,
    success_url: `${APP_BASE_URL}/orders?billing=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: returnUrl || `${APP_BASE_URL}/billing`,
    metadata: {
      user_id: String(user.id),
      user_email: user.email,
      plan_key: planKey,
      ...metadata,
    },
    allow_promotion_codes: false,
    billing_address_collection: 'auto',
    tax_id_collection: false,
    phone_number_collection: { enabled: false },
    submit_type: isTrial ? undefined : 'pay',
  };

  // 3-day trial for intro plan
  if (isTrial) {
    sessionParams.subscription_data = {
      trial_period_days: PLAN_TRIAL_DAYS.intro,
      metadata: {
        user_id: String(user.id),
        plan_key: planKey,
      },
    };
  }

  const session = await stripe.checkout.sessions.create(sessionParams);

  return {
    sessionId: session.id,
    url: session.url,
    customerId: session.customer,
  };
}

/**
 * Create a Stripe Checkout Session for a one-time tenant purchase (no subscription).
 */
export async function createTenantCheckoutSession(user, tenantType, quantity, opts = {}) {
  const priceId = STRIPE_PRICES[tenantType];
  if (!priceId) throw new Error(`Unknown tenant type: ${tenantType}`);

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: user.email,
    line_items: [{
      price: priceId,
      quantity,
    }],
    success_url: `${APP_BASE_URL}/tenants?billing=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: opts.cancelUrl || `${APP_BASE_URL}/tenants`,
    metadata: {
      user_id: String(user.id),
      user_email: user.email,
      tenant_type: tenantType,
      quantity: String(quantity),
    },
    billing_address_collection: 'auto',
    tax_id_collection: false,
    phone_number_collection: { enabled: false },
    allow_promotion_codes: false,
  });

  return {
    sessionId: session.id,
    url: session.url,
    customerId: session.customer,
  };
}

// --- Session & Payment Verification ---

/**
 * Retrieve a checkout session and verify it's complete.
 */
export async function retrieveCheckoutSession(sessionId) {
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['subscription', 'customer'],
  });
  return session;
}

/**
 * Check if a checkout session is paid/complete.
 */
export function isCheckoutSessionComplete(session) {
  return session.payment_status === 'paid' || session.status === 'complete';
}

/**
 * Get pending invoice for a customer (for past_due recovery).
 */
export async function getPendingInvoice(customerId) {
  const invoices = await stripe.invoices.list({
    customer: customerId,
    status: 'open',
    limit: 1,
  });
  return invoices.data[0] || null;
}

// --- Subscriptions ---

/**
 * Retrieve subscription details.
 */
export async function getSubscription(subscriptionId) {
  return stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['items.data.price', 'customer'],
  });
}

/**
 * Create a customer portal session for self-service billing management.
 */
export async function createCustomerPortalSession(user, stripeCustomerId) {
  if (!stripeCustomerId) {
    throw new Error('No Stripe customer ID for this user');
  }
  const session = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: `${APP_BASE_URL}/orders`,
  });
  return session;
}

/**
 * Cancel a subscription (marks cancel_at_period_end = true).
 */
export async function cancelSubscription(subscriptionId) {
  const sub = await stripe.subscriptions.update(subscriptionId, {
    cancel_at_period_end: true,
  });
  return sub;
}

/**
 * Immediately cancel a subscription.
 */
export async function cancelSubscriptionNow(subscriptionId) {
  return stripe.subscriptions.cancel(subscriptionId);
}

// --- Customer Management ---

/**
 * Get or create a Stripe customer by email.
 */
export async function getOrCreateStripeCustomer(user) {
  if (user.stripe_customer_id) {
    try {
      const customer = await stripe.customers.retrieve(user.stripe_customer_id);
      if (!customer.deleted) return customer;
    } catch (e) {
      // customer not found, create new
    }
  }

  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name || user.email,
    metadata: { user_id: String(user.id) },
  });

  return customer;
}

// --- Webhook Verification ---

/**
 * Verify and parse a Stripe webhook payload.
 */
export function verifyStripeWebhookSignature(payload, sig) {
  if (!STRIPE_WEBHOOK_SECRET) {
    console.warn('[stripe] STRIPE_WEBHOOK_SECRET not set - skipping webhook verification');
    return JSON.parse(payload);
  }
  try {
    return stripe.webhooks.constructEvent(payload, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    throw new Error(`Webhook signature verification failed: ${err.message}`);
  }
}

// --- Billing State Serialization (for API responses) ---

/**
 * Serialize Stripe billing state into the same shape used by Whop.
 * This keeps the frontend BillingContext unchanged.
 */
export function serializeStripeBillingState(user) {
  const subStatus = user.stripe_subscription_status;
  const product = user.stripe_product;
  const hasActiveSub = subStatus === 'active' || subStatus === 'trialing';
  const isPaid = subStatus === 'active';
  const isTrialing = subStatus === 'trialing';
  const isPastDue = subStatus === 'past_due';
  const isCanceled = subStatus === 'canceled' || subStatus === 'unpaid';
  const isCancelledAtPeriodEnd = !!user.stripe_cancel_at_period_end;

  const introOfferUsed = !!user.stripe_intro_offer_used;

  let effectivePlan = 'free';
  if (product === 'intro' || product === 'standard' || product === 'advanced') {
    effectivePlan = product;
  }

  let subscriptionTier = null;
  if (isPaid || isTrialing) {
    subscriptionTier = effectivePlan;
  }

  let canAccessApp = false;
  let downloadAllowance = 0;
  let maxConcurrentOrders = 0;
  let canUseCustomNames = false;
  let canDownloadAll = false;
  let canCreateMoreThanOneCompletedOrder = false;
  let canOpenInboxesPage = false;
  let unlimitedConcurrency = false;

  if (isTrialing && product === 'standard') {
    canAccessApp = true;
    downloadAllowance = 10;
    maxConcurrentOrders = 1;
    canOpenInboxesPage = true;
  } else if (isPaid && effectivePlan === 'standard') {
    canAccessApp = true;
    downloadAllowance = Infinity;
    maxConcurrentOrders = 1;
    canUseCustomNames = true;
    canOpenInboxesPage = true;
    canDownloadAll = true;
    canCreateMoreThanOneCompletedOrder = false;
  } else if (isPaid && effectivePlan === 'advanced') {
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
  let needsPaymentMethodUpdate = isPastDue;
  let recommendedCheckoutIntent = null;

  if (!canAccessApp) {
    if (!introOfferUsed && effectivePlan === 'free') {
      needsIntroOffer = true;
      blockingReason = 'needs_intro_offer';
      recommendedCheckoutIntent = 'intro';
    } else {
      needsPaidSubscription = true;
      blockingReason = isPastDue ? 'payment_overdue' : 'needs_paid_subscription';
      recommendedCheckoutIntent = isPastDue ? 'retry' : 'standard';
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
    lifetimeCompletedOrders: user.lifetime_completed_orders || 0,
    maxConcurrentOrders,
    unlimitedConcurrency,
    subscriptionTier,
    subscriptionStatus: subStatus,
    paymentStatus: user.stripe_last_payment_status || 'unknown',
    invoiceStatus: user.stripe_last_invoice_status || 'unknown',
    renewalPeriodEnd: user.stripe_current_period_end,
    cancelAtPeriodEnd: isCancelledAtPeriodEnd,
    needsIntroOffer,
    needsPaidSubscription,
    needsPaymentMethodUpdate,
    blockingReason,
    recommendedCheckoutIntent,
    hasBillingPortal: !!user.stripe_customer_id,
    hasBillingIssue: isPastDue,
    overdueInvoiceId: isPastDue ? user.stripe_last_invoice_id : null,
  };
}

export default stripe;