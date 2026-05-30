import { Router } from 'express';
import {
  getUserByEmail,
  getUserById,
  getUserByStripeCustomerId,
  getUserByStripeSubscriptionId,
  updateUserBillingById,
  updateTenantPurchaseByCheckoutSession,
  resetOrdersUsed
} from '../db/database.js';
import { getUserAccessState } from '../services/access.js';
import {
  createStripeCheckoutSession,
  createCustomerPortalSession,
  cancelSubscription,
  retrieveCheckoutSession,
  isCheckoutSessionComplete,
  getSubscription,
  getPendingInvoice,
  verifyStripeWebhookSignature,
  serializeStripeBillingState,
  isStripeConfigured,
  createResellerCheckoutSession,
  createPerOrderCheckoutSession,
  chargeSavedPaymentMethodForQuota,
  STRIPE_PRICES
} from '../services/stripe.js';

const router = Router();

const VALID_CHECKOUT_INTENTS = new Set(['intro', 'standard', 'advanced', 'reseller', 'perOrder']);

const serializeSessionUser = (user) => ({
  id: user.id,
  email: user.email,
  plan: user.plan || 'free',
  billingStatus: user.stripe_subscription_status || null
});

const getCurrentUser = (req) => {
  const id = req.session?.user?.id;
  if (id) return getUserById(id);
  if (req.session?.user?.email) return getUserByEmail(req.session.user.email);
  return null;
};

function getRequestBaseUrl(req) {
  const origin = req.get('origin');
  const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:3000')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  if (
    origin
    && (
      allowedOrigins.includes(origin)
      || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)
    )
  ) {
    return origin;
  }

  return process.env.APP_BASE_URL || 'https://app.unlimitedinboxes.com';
}

function idOf(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  return value.id || null;
}

function isoFromUnix(timestamp) {
  return timestamp ? new Date(timestamp * 1000).toISOString() : null;
}

function planFromSubscription(sub, fallback = 'standard') {
  const metadataPlan = sub?.metadata?.plan_key;
  if (metadataPlan) return metadataPlan;

  const priceId = sub?.items?.data?.[0]?.price?.id || null;
  if (priceId === STRIPE_PRICES.advanced) return 'advanced';
  if (priceId === STRIPE_PRICES.standard || priceId === STRIPE_PRICES.intro) return fallback || 'standard';
  return fallback || 'standard';
}

async function resolveSubscription(subscriptionLike) {
  const subscriptionId = idOf(subscriptionLike);
  if (!subscriptionId) return null;
  if (typeof subscriptionLike === 'object' && subscriptionLike.current_period_end) {
    return subscriptionLike;
  }
  return getSubscription(subscriptionId);
}

async function resolveInvoiceForStatus(customerId, latestInvoice, subscriptionStatus) {
  if (latestInvoice && typeof latestInvoice === 'object') {
    return latestInvoice;
  }
  if (['past_due', 'unpaid', 'incomplete'].includes(subscriptionStatus)) {
    return getPendingInvoice(customerId);
  }
  return null;
}

async function buildSubscriptionUpdate(user, sub, fallbackPlan = 'standard', invoiceOverride = null) {
  const customerId = idOf(sub.customer) || user.stripe_customer_id || null;
  const latestInvoice = await resolveInvoiceForStatus(
    customerId,
    invoiceOverride || sub.latest_invoice,
    sub.status
  );
  const planKey = planFromSubscription(sub, fallbackPlan);
  const storedPlan = sub.status === 'trialing'
    ? 'intro'
    : (planKey === 'advanced' ? 'advanced' : 'standard');

  return {
    plan: ['active', 'trialing'].includes(sub.status) ? storedPlan : (user.plan || 'free'),
    stripe_customer_id: customerId,
    stripe_subscription_id: sub.id,
    stripe_subscription_status: sub.status,
    stripe_product: planKey,
    stripe_plan_id: sub.items?.data?.[0]?.price?.id || null,
    stripe_current_period_end: isoFromUnix(sub.current_period_end),
    stripe_trial_ends_at: isoFromUnix(sub.trial_end),
    stripe_cancel_at_period_end: sub.cancel_at_period_end ? 1 : 0,
    stripe_default_payment_method_id: idOf(sub.default_payment_method),
    stripe_last_payment_status: latestInvoice?.status === 'paid' ? 'paid' : (latestInvoice?.status || 'unknown'),
    stripe_last_invoice_id: latestInvoice?.id || null,
    stripe_last_invoice_status: latestInvoice?.status || null,
    stripe_last_invoice_url: latestInvoice?.hosted_invoice_url || null,
    stripe_intro_offer_used: planKey === 'intro' || user.stripe_intro_offer_used ? 1 : 0,
    reseller_plan: sub.metadata?.plan_key === 'reseller' ? 1 : (sub.metadata?.plan_key === 'perOrder' ? 0 : user.reseller_plan),
    orders_per_month: sub.metadata?.plan_key === 'perOrder'
      ? parseInt(sub.metadata?.quantity || '0', 10)
      : user.orders_per_month,
  };
}

router.post('/checkout', async (req, res) => {
  if (!req.session.authenticated || !req.session.user?.id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const intent = VALID_CHECKOUT_INTENTS.has(String(req.body?.intent || '').toLowerCase().trim())
    ? String(req.body.intent).toLowerCase().trim()
    : 'standard';

  if (!isStripeConfigured()) {
    return res.status(503).json({ error: 'Stripe is not configured.' });
  }

  if (!STRIPE_PRICES[intent]) {
    return res.status(400).json({ error: `Unknown plan: ${intent}` });
  }

  try {
    const access = getUserAccessState(user);

    if (access.hasBillingIssue || user.stripe_subscription_status === 'past_due') {
      const serialized = serializeStripeBillingState(user);
      return res.status(402).json({
        error: 'Invoice overdue. Pay the open Stripe invoice to restore access.',
        overdueInvoiceUrl: serialized.overdueInvoiceUrl,
      });
    }

    if (intent === 'intro') {
      if (access.introOfferUsed && !access.trialActive) {
        return res.status(409).json({ error: 'Your three-day trial has already been used.' });
      }
      if (access.trialActive || access.isFullyPaid) {
        return res.status(409).json({ error: 'Your account already has active access.' });
      }
    }

    if (intent === 'standard' && (access.subscriptionTier === 'standard' || access.subscriptionTier === 'advanced')) {
      return res.status(409).json({ error: 'Your paid subscription is already active.' });
    }

    if (intent === 'advanced' && access.subscriptionTier === 'advanced') {
      return res.status(409).json({ error: 'Advanced is already active on this account.' });
    }

    if (intent === 'reseller') {
      const checkout = await createResellerCheckoutSession(user, { appBaseUrl: getRequestBaseUrl(req) });
      updateUserBillingById(user.id, { stripe_checkout_session_id: checkout.sessionId });
      return res.json({ sessionId: checkout.sessionId, url: checkout.url, checkoutUrl: checkout.url });
    }

    if (intent === 'perOrder') {
      const quantity = Math.max(3, parseInt(req.body?.quantity, 10) || 3);
      const checkout = await createPerOrderCheckoutSession(user, quantity, { appBaseUrl: getRequestBaseUrl(req) });
      updateUserBillingById(user.id, { stripe_checkout_session_id: checkout.sessionId });
      return res.json({ sessionId: checkout.sessionId, url: checkout.url, checkoutUrl: checkout.url });
    }

    const checkout = await createStripeCheckoutSession(user, intent, {
      appBaseUrl: getRequestBaseUrl(req),
    });

    updateUserBillingById(user.id, { stripe_checkout_session_id: checkout.sessionId });

    return res.json({
      sessionId: checkout.sessionId,
      clientSecret: checkout.clientSecret,
      url: checkout.url,
      purchaseUrl: checkout.url,
      checkoutUrl: checkout.url,
      provider: 'stripe',
      plan: intent,
    });
  } catch (error) {
    console.error('[billing] Stripe checkout failed:', error);
    return res.status(500).json({ error: error.message || 'Failed to create checkout session.' });
  }
});

router.get('/status', async (req, res) => {
  if (!req.session.authenticated || !req.session.user?.id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  if (isStripeConfigured() && user.stripe_subscription_id) {
    try {
      const sub = await getSubscription(user.stripe_subscription_id);
      const update = await buildSubscriptionUpdate(user, sub, user.stripe_product || 'standard');
      updateUserBillingById(user.id, update);

      const refreshed = getUserById(user.id) || user;
      req.session.user = serializeSessionUser(refreshed);
      return res.json(serializeStripeBillingState(refreshed));
    } catch (error) {
      console.error('[billing] Stripe status sync failed:', error.message);
    }
  }

  req.session.user = serializeSessionUser(user);
  return res.json(serializeStripeBillingState(user));
});

router.get('/portal', async (req, res) => {
  if (!req.session.authenticated || !req.session.user?.id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  if (!isStripeConfigured()) {
    return res.status(503).json({ error: 'Stripe is not configured.' });
  }

  try {
    if (user.stripe_customer_id) {
      const session = await createCustomerPortalSession(user, user.stripe_customer_id, {
        appBaseUrl: getRequestBaseUrl(req),
      });
      return res.json({ url: session.url });
    }

    return res.status(404).json({ error: 'No Stripe customer exists for this account yet.' });
  } catch (error) {
    console.error('[billing] Stripe portal failed:', error.message);
    return res.status(500).json({ error: error.message || 'Failed to open billing portal.' });
  }
});

router.post('/cancel', async (req, res) => {
  if (!req.session.authenticated || !req.session.user?.id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  if (!user.stripe_subscription_id) {
    return res.status(400).json({ error: 'No active subscription to cancel.' });
  }

  try {
    const sub = await cancelSubscription(user.stripe_subscription_id);
    const update = await buildSubscriptionUpdate(user, sub, user.stripe_product || 'standard');
    updateUserBillingById(user.id, update);
    const latest = getUserById(user.id) || user;
    req.session.user = serializeSessionUser(latest);
    return res.json({ success: true, message: 'Subscription will cancel at the end of the billing period.' });
  } catch (error) {
    console.error('[billing] Stripe cancel failed:', error);
    return res.status(500).json({ error: error.message });
  }
});

router.post('/return', async (req, res) => {
  if (!req.session.authenticated || !req.session.user?.id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const sessionId = req.body?.sessionId || req.query?.session_id || user.stripe_checkout_session_id || null;

  if (!sessionId) {
    return res.status(400).json({ error: 'No session ID provided.' });
  }

  try {
    const session = await retrieveCheckoutSession(sessionId);
    if (!isCheckoutSessionComplete(session)) {
      return res.status(400).json({ error: 'Payment not complete.' });
    }

    const sub = await resolveSubscription(session.subscription);
    if (!sub) {
      return res.status(400).json({ error: 'Checkout session did not include a subscription.' });
    }

    const planKey = session.metadata?.plan_key || sub.metadata?.plan_key || 'standard';
    const update = await buildSubscriptionUpdate(user, sub, planKey);
    update.stripe_checkout_session_id = null;
    update.stripe_intro_offer_used = planKey === 'intro' ? 1 : (user.stripe_intro_offer_used || 0);
    updateUserBillingById(user.id, update);

    const latest = getUserById(user.id) || user;
    req.session.user = serializeSessionUser(latest);

    return res.json({
      ...serializeStripeBillingState(latest),
      provider: 'stripe',
    });
  } catch (error) {
    console.error('[billing] Stripe return failed:', error);
    return res.status(500).json({ error: error.message || 'Failed to finalize checkout.' });
  }
});

router.post('/checkout-additional-orders', async (req, res) => {
  if (!req.session.authenticated || !req.session.user?.id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const quantity = Math.max(3, parseInt(req.body?.quantity, 10) || 3);
  if (!isStripeConfigured()) {
    return res.status(503).json({ error: 'Stripe is not configured.' });
  }

  const checkout = await createPerOrderCheckoutSession(user, quantity, { appBaseUrl: getRequestBaseUrl(req) });
  updateUserBillingById(user.id, { stripe_checkout_session_id: checkout.sessionId });

  return res.json({ sessionId: checkout.sessionId, url: checkout.url, checkoutUrl: checkout.url, quantity });
});

router.get('/quota', async (req, res) => {
  if (!req.session.authenticated || !req.session.user?.id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  return res.json({
    isReseller: Boolean(user.reseller_plan),
    ordersPerMonth: user.orders_per_month || 0,
    ordersUsedThisPeriod: user.orders_used_this_period || 0,
    availableOrders: user.reseller_plan
      ? 'unlimited'
      : Math.max(0, (user.orders_per_month || 0) - (user.orders_used_this_period || 0)),
  });
});

router.post('/auto-charge-quota', async (req, res) => {
  if (!req.session.authenticated || !req.session.user?.id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  // Only for non-reseller users with no available orders
  if (user.reseller_plan) {
    return res.status(400).json({ error: 'Reseller plan has unlimited orders' });
  }

  const available = (user.orders_per_month || 0) - (user.orders_used_this_period || 0);
  if (available > 0) {
    return res.status(400).json({ error: 'No auto-charge needed, orders available' });
  }

  const quantity = Math.max(3, parseInt(req.body?.quantity, 10) || 3);
  const result = await chargeSavedPaymentMethodForQuota(user, quantity);

  if (result.paid) {
    // Add the purchased quantity to orders_per_month
    updateUserBillingById(user.id, { orders_per_month: (user.orders_per_month || 0) + quantity });
    return res.json({ success: true, ordersAdded: quantity });
  }

  return res.status(402).json({ error: 'Payment failed', reason: result.reason });
});

router.post('/webhook', async (req, res) => {
  if (!isStripeConfigured()) {
    return res.status(503).json({ error: 'Stripe not configured.' });
  }

  const sig = req.headers['stripe-signature'] || '';
  const rawBody = req.rawBody || req.body;

  let event;
  try {
    event = verifyStripeWebhookSignature(
      typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody),
      sig
    );
  } catch (error) {
    console.error('[stripe-webhook] Signature verification failed:', error.message);
    return res.status(400).json({ error: error.message });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;

        if (session.metadata?.type === 'tenant_purchase') {
          const custId = idOf(session.customer);
          updateTenantPurchaseByCheckoutSession(session.id, {
            status: session.payment_status === 'paid' ? 'paid' : 'complete',
            stripe_payment_intent_id: idOf(session.payment_intent),
            stripe_customer_id: custId,
          });
          if (custId) {
            const userId = Number(session.metadata?.user_id);
            const user = userId ? getUserById(userId) : null;
            if (user && !user.stripe_customer_id) {
              updateUserBillingById(user.id, { stripe_customer_id: custId });
            }
          }
          break;
        }

        const userId = session.metadata?.user_id;
        if (!userId) break;

        const user = getUserById(Number(userId));
        if (!user) break;

        const sub = await resolveSubscription(session.subscription);
        if (!sub) break;

        const planKey = session.metadata?.plan_key || sub.metadata?.plan_key || 'standard';
        const update = await buildSubscriptionUpdate(user, sub, planKey);
        update.stripe_checkout_session_id = null;
        update.stripe_intro_offer_used = planKey === 'intro' ? 1 : (user.stripe_intro_offer_used || 0);
        updateUserBillingById(user.id, update);
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const user = getUserByStripeSubscriptionId(sub.id) || getUserByStripeCustomerId(idOf(sub.customer));
        if (!user) break;

        const update = await buildSubscriptionUpdate(user, sub, user.stripe_product || 'standard');
        updateUserBillingById(user.id, update);

        if (sub.metadata?.plan_key === 'reseller') {
          updateUserBillingById(user.id, { reseller_plan: 1, orders_per_month: 0 });
        } else if (sub.metadata?.plan_key === 'perOrder') {
          const quantity = parseInt(sub.metadata?.quantity || '0', 10);
          updateUserBillingById(user.id, { reseller_plan: 0, orders_per_month: quantity });
          // Reset usage at start of new billing period
          if (sub.status === 'active') {
            resetOrdersUsed(user.id);
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const user = getUserByStripeSubscriptionId(sub.id) || getUserByStripeCustomerId(idOf(sub.customer));
        if (!user) break;
        updateUserBillingById(user.id, {
          plan: 'free',
          stripe_subscription_status: 'canceled',
          stripe_cancel_at_period_end: 0,
          reseller_plan: 0,
          orders_per_month: 0,
        });
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const user = getUserByStripeSubscriptionId(idOf(invoice.subscription))
          || getUserByStripeCustomerId(idOf(invoice.customer));
        if (!user) break;
        updateUserBillingById(user.id, {
          stripe_subscription_status: 'past_due',
          stripe_last_invoice_id: invoice.id,
          stripe_last_invoice_status: invoice.status || 'open',
          stripe_last_invoice_url: invoice.hosted_invoice_url || user.stripe_last_invoice_url || null,
          stripe_last_payment_status: 'failed',
        });
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object;
        const user = getUserByStripeSubscriptionId(idOf(invoice.subscription))
          || getUserByStripeCustomerId(idOf(invoice.customer));
        if (!user) break;

        const sub = invoice.subscription ? await resolveSubscription(invoice.subscription) : null;
        if (sub) {
          const update = await buildSubscriptionUpdate(user, sub, user.stripe_product || 'standard', invoice);
          updateUserBillingById(user.id, update);
        } else {
          updateUserBillingById(user.id, {
            stripe_subscription_status: 'active',
            stripe_last_invoice_id: invoice.id,
            stripe_last_invoice_status: 'paid',
            stripe_last_invoice_url: invoice.hosted_invoice_url || null,
            stripe_last_payment_status: 'paid',
          });
        }
        break;
      }

      default:
        break;
    }

    return res.json({ received: true });
  } catch (error) {
    console.error('[stripe-webhook] Handler error:', error.message);
    return res.status(500).json({ error: 'Webhook handler failed.' });
  }
});

export default router;
