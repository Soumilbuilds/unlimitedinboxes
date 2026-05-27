import { Router } from 'express';
import {
  getUserByEmail,
  getUserById,
  getUserByStripeCustomerId,
  getUserByStripeSubscriptionId,
  updateUserBillingById
} from '../db/database.js';
import { getUserAccessState } from '../services/access.js';
import {
  createStripeCheckoutSession,
  createTenantCheckoutSession,
  createCustomerPortalSession,
  cancelSubscription,
  retrieveCheckoutSession,
  isCheckoutSessionComplete,
  getSubscription,
  verifyStripeWebhookSignature,
  serializeStripeBillingState,
  isStripeConfigured,
  STRIPE_PRICES
} from '../services/stripe.js';

const router = Router();

const VALID_CHECKOUT_INTENTS = new Set(['intro', 'standard', 'advanced']);

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

// --- CHECKOUT ---
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

    const checkout = await createStripeCheckoutSession(
      { id: user.id, email: user.email, name: user.email },
      intent
    );

    updateUserBillingById(user.id, { stripe_checkout_session_id: checkout.sessionId });

    return res.json({
      sessionId: checkout.sessionId,
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

// --- STATUS ---
router.get('/status', async (req, res) => {
  if (!req.session.authenticated || !req.session.user?.id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  // If user has a Stripe subscription, sync it from Stripe API
  if (isStripeConfigured() && user.stripe_subscription_id) {
    try {
      const sub = await getSubscription(user.stripe_subscription_id);
      const latest = getUserById(user.id) || user;

      const periodEnd = sub.current_period_end
        ? new Date(sub.current_period_end * 1000).toISOString()
        : null;

      updateUserBillingById(latest.id, {
        stripe_subscription_status: sub.status,
        stripe_product: sub.metadata?.plan_key || latest.stripe_product || 'standard',
        stripe_current_period_end: periodEnd,
        stripe_cancel_at_period_end: sub.cancel_at_period_end ? 1 : 0,
        stripe_last_payment_status: sub.latest_invoice?.status === 'paid' ? 'paid' : (sub.latest_invoice?.status || 'unknown'),
        stripe_last_invoice_id: sub.latest_invoice?.id || null,
        stripe_last_invoice_status: sub.latest_invoice?.status || null,
      });

      const refreshed = getUserById(latest.id);
      const serialized = serializeStripeBillingState(refreshed || latest);
      req.session.user = serializeSessionUser(refreshed || latest);
      return res.json(serialized);
    } catch (error) {
      console.error('[billing] Stripe status sync failed:', error.message);
      // If sync fails, return what we have in the DB
      const latest = getUserById(user.id) || user;
      req.session.user = serializeSessionUser(latest);
      return res.json(serializeStripeBillingState(latest));
    }
  }

  // No Stripe subscription — return Stripe state from DB
  req.session.user = serializeSessionUser(user);
  return res.json(serializeStripeBillingState(user));
});

// --- PORTAL ---
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
      const session = await createCustomerPortalSession(user, user.stripe_customer_id);
      return res.json({ url: session.url });
    }

    // No customer ID yet — direct to the account's billing portal
    return res.json({
      url: 'https://billing.stripe.com/p/login/eVq8wOgwS8aB76uc3n28800',
      fallback: true
    });
  } catch (error) {
    console.error('[billing] Stripe portal failed:', error.message);
    return res.status(500).json({ error: error.message || 'Failed to open billing portal.' });
  }
});

// --- CANCEL ---
router.post('/cancel', async (req, res) => {
  if (!req.session.authenticated || !req.session.user?.id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  if (!user.stripe_subscription_id) {
    return res.status(503).json({ error: 'No active subscription to cancel.' });
  }

  try {
    await cancelSubscription(user.stripe_subscription_id);
    const latest = getUserById(user.id);
    req.session.user = serializeSessionUser(latest || user);
    return res.json({ success: true, message: 'Subscription will cancel at end of billing period.' });
  } catch (error) {
    console.error('[billing] Stripe cancel failed:', error);
    return res.status(500).json({ error: error.message });
  }
});

// --- RETURN (after Stripe redirect) ---
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

    const subscription = session.subscription;
    const customerId = typeof session.customer === 'string'
      ? session.customer
      : session.customer?.id;

    const periodEnd = subscription?.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : null;

    const planKey = session.metadata?.plan_key
      || subscription?.metadata?.plan_key
      || 'standard';

    updateUserBillingById(user.id, {
      stripe_customer_id: customerId,
      stripe_subscription_id: subscription?.id || null,
      stripe_subscription_status: subscription?.status || 'active',
      stripe_product: planKey,
      stripe_plan_id: subscription?.items?.data?.[0]?.price?.id || null,
      stripe_current_period_end: periodEnd,
      stripe_cancel_at_period_end: subscription?.cancel_at_period_end ? 1 : 0,
      stripe_checkout_session_id: null,
      stripe_intro_offer_used: planKey === 'intro' ? 1 : (user.stripe_intro_offer_used || 0),
      stripe_last_payment_status: 'paid',
      stripe_last_invoice_status: 'paid',
      stripe_last_invoice_id: session.invoice || null,
    });

    const latest = getUserById(user.id);
    req.session.user = serializeSessionUser(latest || user);

    return res.json({
      ...serializeStripeBillingState(latest || user),
      provider: 'stripe',
    });
  } catch (error) {
    console.error('[billing] Stripe return failed:', error);
    return res.status(500).json({ error: error.message || 'Failed to finalize checkout.' });
  }
});

// --- STRIPE WEBHOOK ---
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
        const userId = session.metadata?.user_id;
        if (!userId) break;

        const user = getUserById(Number(userId));
        if (!user) break;

        const subscription = session.subscription;
        const customerId = typeof session.customer === 'string'
          ? session.customer
          : session.customer?.id;
        const planKey = session.metadata?.plan_key || 'standard';

        const periodEnd = subscription?.current_period_end
          ? new Date(subscription.current_period_end * 1000).toISOString()
          : null;

        updateUserBillingById(user.id, {
          stripe_customer_id: customerId,
          stripe_subscription_id: subscription?.id || null,
          stripe_subscription_status: subscription?.status || 'active',
          stripe_product: planKey,
          stripe_plan_id: subscription?.items?.data?.[0]?.price?.id || null,
          stripe_current_period_end: periodEnd,
          stripe_cancel_at_period_end: subscription?.cancel_at_period_end ? 1 : 0,
          stripe_last_payment_status: 'paid',
          stripe_last_invoice_status: 'paid',
          stripe_last_invoice_id: session.invoice || null,
          stripe_intro_offer_used: planKey === 'intro' ? 1 : (user.stripe_intro_offer_used || 0),
        });
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const user = getUserByStripeSubscriptionId(sub.id) || getUserByStripeCustomerId(sub.customer);
        if (!user) break;

        const periodEnd = sub.current_period_end
          ? new Date(sub.current_period_end * 1000).toISOString()
          : null;

        updateUserBillingById(user.id, {
          stripe_subscription_status: sub.status,
          stripe_current_period_end: periodEnd,
          stripe_cancel_at_period_end: sub.cancel_at_period_end ? 1 : 0,
          stripe_last_payment_status: sub.latest_invoice?.status === 'paid' ? 'paid' : 'unknown',
          stripe_last_invoice_status: sub.latest_invoice?.status || null,
        });
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const user = getUserByStripeSubscriptionId(sub.id);
        if (!user) break;
        updateUserBillingById(user.id, { stripe_subscription_status: 'canceled' });
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const user = getUserByStripeCustomerId(invoice.customer);
        if (!user) break;
        updateUserBillingById(user.id, {
          stripe_subscription_status: 'past_due',
          stripe_last_invoice_id: invoice.id,
          stripe_last_invoice_status: 'open',
          stripe_last_payment_status: 'failed',
        });
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object;
        const user = getUserByStripeCustomerId(invoice.customer);
        if (!user) break;
        updateUserBillingById(user.id, {
          stripe_subscription_status: 'active',
          stripe_last_invoice_id: invoice.id,
          stripe_last_invoice_status: 'paid',
          stripe_last_payment_status: 'paid',
        });
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