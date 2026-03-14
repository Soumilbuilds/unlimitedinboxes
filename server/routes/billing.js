import { Router } from 'express';
import {
  getUserByEmail,
  getUserById,
  getUserByWhopMemberId,
  getUserByWhopMembershipId,
  updateUserBillingById
} from '../db/database.js';
import {
  WHOP_PLAN_ID_PAID,
  createWhopCheckoutSession,
  isActiveWhopMembershipStatus,
  isWhopCheckoutConfigured,
  isWhopSyncConfigured,
  isWhopWebhookConfigured,
  readBillingMetadata,
  syncUserBillingState,
  unwrapWhopWebhook
} from '../services/whop.js';

const router = Router();

const requireAuth = (req, res, next) => {
  if (!req.session.authenticated || !req.session.user?.id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
};

const normalizeEmail = (value) => String(value || '').trim().toLowerCase() || null;

const parseUserId = (value) => {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const resolvePlan = (currentPlan, membershipStatus, planId = null) => {
  if (planId && planId !== WHOP_PLAN_ID_PAID) {
    return currentPlan || 'free';
  }

  if (isActiveWhopMembershipStatus(membershipStatus)) {
    return 'paid';
  }
  if (String(currentPlan || 'free') === 'paid') {
    return 'free';
  }
  return currentPlan || 'free';
};

const serializeSessionUser = (user) => ({
  id: user.id,
  email: user.email,
  plan: user.plan || 'free',
  billingStatus: user.whop_membership_status || null
});

const getCurrentUser = (req) => {
  const id = req.session?.user?.id;
  if (id) {
    return getUserById(id);
  }
  if (req.session?.user?.email) {
    return getUserByEmail(req.session.user.email);
  }
  return null;
};

const findBillingUser = ({ metadata, email, membershipId, memberId }) => {
  const metadataUserId = parseUserId(metadata?.unlimited_mailboxes_user_id);
  if (metadataUserId) {
    const byId = getUserById(metadataUserId);
    if (byId) return byId;
  }

  if (membershipId) {
    const byMembership = getUserByWhopMembershipId(membershipId);
    if (byMembership) return byMembership;
  }

  if (memberId) {
    const byMember = getUserByWhopMemberId(memberId);
    if (byMember) return byMember;
  }

  const normalizedEmail = normalizeEmail(email ?? metadata?.unlimited_mailboxes_user_email ?? null);
  if (normalizedEmail) {
    return getUserByEmail(normalizedEmail);
  }

  return null;
};

const applyMembershipUpdate = (user, membership) => {
  updateUserBillingById(user.id, {
    plan: resolvePlan(user.plan, membership.status, membership.plan?.id ?? null),
    whop_member_id: membership.member?.id ?? user.whop_member_id ?? null,
    whop_membership_id: membership.id,
    whop_membership_status: membership.status,
    whop_renewal_period_end: membership.renewal_period_end ?? user.whop_renewal_period_end ?? null,
    whop_cancel_at_period_end: membership.cancel_at_period_end ? 1 : 0,
    whop_plan_id: membership.plan?.id ?? user.whop_plan_id ?? null
  });
};

const applyPaymentUpdate = (user, payment) => {
  const nextPlan = payment.membership
    ? resolvePlan(user.plan, payment.membership.status, payment.plan?.id ?? payment.membership.plan?.id ?? null)
    : user.plan;

  updateUserBillingById(user.id, {
    plan: nextPlan,
    whop_member_id: payment.member?.id ?? user.whop_member_id ?? null,
    whop_membership_id: payment.membership?.id ?? user.whop_membership_id ?? null,
    whop_membership_status: payment.membership?.status ?? user.whop_membership_status ?? null,
    whop_plan_id: payment.plan?.id ?? payment.membership?.plan?.id ?? user.whop_plan_id ?? null,
    whop_last_payment_id: payment.id,
    whop_last_payment_status: payment.status,
    whop_last_payment_substatus: payment.substatus ?? null
  });
};

const applyInvoiceUpdate = (user, invoice) => {
  updateUserBillingById(user.id, {
    whop_last_invoice_id: invoice.id,
    whop_last_invoice_status: invoice.status
  });
};

router.post('/checkout', requireAuth, async (req, res) => {
  if (!isWhopCheckoutConfigured()) {
    return res.status(503).json({ error: 'Whop billing is not configured yet.' });
  }

  const user = getCurrentUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const billing = await syncUserBillingState(user, { forceRecovery: true });
    const latest = getUserById(user.id) || user;

    if (latest.plan === 'paid' && isActiveWhopMembershipStatus(billing.membershipStatus)) {
      req.session.user = serializeSessionUser(latest);
      return res.status(409).json({ error: 'Your paid plan is already active.' });
    }

    const checkout = await createWhopCheckoutSession({
      userId: latest.id,
      email: latest.email
    });

    req.session.user = serializeSessionUser(latest);
    return res.json({
      sessionId: checkout.id,
      purchaseUrl: checkout.purchaseUrl
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to create checkout session.' });
  }
});

router.get('/status', requireAuth, async (req, res) => {
  const user = getCurrentUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!isWhopSyncConfigured()) {
    req.session.user = serializeSessionUser(user);
    return res.json({
      configured: false,
      plan: user.plan || 'free',
      membershipStatus: user.whop_membership_status || null,
      isPaid: user.plan === 'paid'
    });
  }

  try {
    const billing = await syncUserBillingState(user, { forceRecovery: true });
    const latest = getUserById(user.id) || user;
    req.session.user = serializeSessionUser(latest);

    return res.json({
      configured: true,
      plan: latest.plan || billing.plan || 'free',
      membershipStatus: latest.whop_membership_status || billing.membershipStatus || null,
      paymentStatus: latest.whop_last_payment_status || billing.payment?.status || null,
      invoiceStatus: latest.whop_last_invoice_status || billing.invoice?.status || null,
      renewalPeriodEnd: latest.whop_renewal_period_end || billing.membership?.renewal_period_end || null,
      cancelAtPeriodEnd: Boolean(latest.whop_cancel_at_period_end),
      isPaid: (latest.plan || billing.plan) === 'paid'
    });
  } catch (error) {
    req.session.user = serializeSessionUser(user);
    return res.status(200).json({
      configured: true,
      plan: user.plan || 'free',
      membershipStatus: user.whop_membership_status || null,
      isPaid: user.plan === 'paid',
      syncError: error.message || 'Failed to sync billing status.'
    });
  }
});

router.post('/whop/webhook', async (req, res) => {
  if (!isWhopWebhookConfigured()) {
    return res.status(503).json({ error: 'Whop webhook verification is not configured yet.' });
  }

  const rawBody = req.rawBody || '';
  const headers = Object.fromEntries(
    Object.entries(req.headers).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.join(', ') : String(value ?? '')
    ])
  );

  try {
    const event = unwrapWhopWebhook(rawBody, headers);
    const data = event?.data;

    if (!data) {
      return res.json({ received: true });
    }

    const metadata = readBillingMetadata(data.metadata);
    const user = findBillingUser({
      metadata,
      email:
        data.user?.email ??
        data.member?.user?.email ??
        data.member?.email ??
        null,
      membershipId: data.membership?.id ?? data.id ?? null,
      memberId: data.member?.id ?? null
    });

    if (!user) {
      return res.json({ received: true, ignored: true });
    }

    switch (event.type) {
      case 'membership.activated':
      case 'membership.deactivated':
      case 'membership.cancel_at_period_end_changed':
        applyMembershipUpdate(user, data);
        break;
      case 'payment.succeeded':
      case 'payment.failed':
      case 'payment.pending':
        applyPaymentUpdate(user, data);
        break;
      case 'invoice.created':
      case 'invoice.paid':
      case 'invoice.past_due':
      case 'invoice.voided':
        applyInvoiceUpdate(user, data);
        break;
      default:
        break;
    }

    return res.json({ received: true });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Invalid webhook payload.' });
  }
});

export default router;
