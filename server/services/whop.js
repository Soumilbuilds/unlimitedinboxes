import Whop from '@whop/sdk';
import { getUserByEmail, updateUserBillingById } from '../db/database.js';

const ACTIVE_MEMBERSHIP_STATUSES = new Set(['active', 'trialing', 'canceling']);

const MEMBERSHIP_STATUS_PRIORITY = {
  active: 7,
  trialing: 6,
  canceling: 5,
  past_due: 4,
  unresolved: 3,
  canceled: 2,
  expired: 1
};

const PAYMENT_STATUS_PRIORITY = {
  paid: 5,
  open: 4,
  pending: 3,
  failed: 2,
  void: 1
};

const readEnv = (key) => {
  const value = process.env[key] ?? '';
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('\'') && trimmed.endsWith('\''))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const isConfiguredValue = (value) =>
  Boolean(String(value || '').trim()) && !String(value).startsWith('REPLACE_WITH_');

const encodeWebhookKey = (value) => Buffer.from(value, 'utf8').toString('base64');

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

const toTimestamp = (value) => {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
};

const toSqliteDateTime = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
};

const getMembershipPriority = (status) => MEMBERSHIP_STATUS_PRIORITY[status ?? ''] ?? 0;
const getPaymentPriority = (status) => PAYMENT_STATUS_PRIORITY[status ?? ''] ?? 0;

const pickBestMembershipSummary = (memberships = []) =>
  [...memberships].sort((left, right) => {
    const priorityDelta = getMembershipPriority(right.status) - getMembershipPriority(left.status);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    return toTimestamp(right.created_at) - toTimestamp(left.created_at);
  })[0] ?? null;

const pickBestPaymentSummary = (payments = [], membershipId = null) =>
  [...payments].sort((left, right) => {
    const membershipMatchDelta =
      Number((right.membership?.id ?? null) === membershipId) -
      Number((left.membership?.id ?? null) === membershipId);
    if (membershipMatchDelta !== 0) {
      return membershipMatchDelta;
    }

    const priorityDelta = getPaymentPriority(right.status) - getPaymentPriority(left.status);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    const paidAtDelta = toTimestamp(right.paid_at) - toTimestamp(left.paid_at);
    if (paidAtDelta !== 0) {
      return paidAtDelta;
    }

    return toTimestamp(right.created_at) - toTimestamp(left.created_at);
  })[0] ?? null;

const getDefaultAppBaseUrl = () =>
  process.env.NODE_ENV === 'production'
    ? 'https://app.unlimitedinboxes.com'
    : 'http://localhost:3000';

export const WHOP_API_KEY = readEnv('WHOP_API_KEY');
export const WHOP_COMPANY_ID = readEnv('WHOP_COMPANY_ID');
export const WHOP_PLAN_ID_PAID = readEnv('WHOP_PLAN_ID_PAID');
export const WHOP_WEBHOOK_SECRET = readEnv('WHOP_WEBHOOK_SECRET');
export const APP_BASE_URL = readEnv('APP_BASE_URL') || getDefaultAppBaseUrl();

const getWhopClient = ({ requireWebhookKey = false } = {}) => {
  if (!isWhopSyncConfigured()) {
    throw new Error('Whop sync is not configured.');
  }

  if (requireWebhookKey && !isWhopWebhookConfigured()) {
    throw new Error('Whop webhook verification is not configured.');
  }

  return new Whop({
    apiKey: WHOP_API_KEY,
    ...(isWhopWebhookConfigured()
      ? { webhookKey: encodeWebhookKey(WHOP_WEBHOOK_SECRET) }
      : {})
  });
};

export const isWhopSyncConfigured = () =>
  isConfiguredValue(WHOP_API_KEY) &&
  isConfiguredValue(WHOP_COMPANY_ID) &&
  isConfiguredValue(WHOP_PLAN_ID_PAID);

export const isWhopCheckoutConfigured = () =>
  isWhopSyncConfigured() && isConfiguredValue(APP_BASE_URL);

export const isWhopWebhookConfigured = () =>
  isWhopSyncConfigured() && isConfiguredValue(WHOP_WEBHOOK_SECRET);

export const isActiveWhopMembershipStatus = (status) =>
  ACTIVE_MEMBERSHIP_STATUSES.has(String(status || '').toLowerCase());

export const buildBillingMetadata = ({ userId, email, action = 'upgrade' }) => ({
  unlimited_mailboxes_user_id: String(userId),
  unlimited_mailboxes_user_email: normalizeEmail(email),
  unlimited_mailboxes_action: action
});

export const readBillingMetadata = (metadata = null) => ({
  unlimited_mailboxes_user_id:
    typeof metadata?.unlimited_mailboxes_user_id === 'string'
      ? metadata.unlimited_mailboxes_user_id
      : undefined,
  unlimited_mailboxes_user_email:
    typeof metadata?.unlimited_mailboxes_user_email === 'string'
      ? metadata.unlimited_mailboxes_user_email
      : undefined,
  unlimited_mailboxes_action:
    typeof metadata?.unlimited_mailboxes_action === 'string'
      ? metadata.unlimited_mailboxes_action
      : undefined
});

export const createWhopCheckoutSession = async ({ userId, email }) => {
  const client = getWhopClient();
  const checkout = await client.checkoutConfigurations.create({
    plan_id: WHOP_PLAN_ID_PAID,
    metadata: buildBillingMetadata({ userId, email, action: 'upgrade' }),
    redirect_url: `${APP_BASE_URL}/orders?billing=success`,
    source_url: `${APP_BASE_URL}/orders`
  });

  return {
    id: checkout.id,
    purchaseUrl: checkout.purchase_url
  };
};

export const retrieveWhopMembership = async (membershipId) =>
  getWhopClient().memberships.retrieve(membershipId);

export const retrieveWhopPayment = async (paymentId) =>
  getWhopClient().payments.retrieve(paymentId);

export const retrieveWhopInvoice = async (invoiceId) =>
  getWhopClient().invoices.retrieve(invoiceId);

export const recoverWhopBillingStateByEmail = async (email) => {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return {
      memberId: null,
      membership: null,
      payment: null,
      invoice: null
    };
  }

  const client = getWhopClient();
  const membersPage = await client.members.list({
    company_id: WHOP_COMPANY_ID,
    query: normalizedEmail,
    plan_ids: [WHOP_PLAN_ID_PAID],
    first: 10
  });

  const matchedMember =
    membersPage.data.find((member) => normalizeEmail(member.user?.email) === normalizedEmail) ??
    null;

  const userId = matchedMember?.user?.id ?? null;
  const memberId = matchedMember?.id ?? null;

  const membershipsPage = userId
    ? await client.memberships.list({
        company_id: WHOP_COMPANY_ID,
        user_ids: [userId],
        plan_ids: [WHOP_PLAN_ID_PAID],
        first: 10,
        order: 'created_at',
        direction: 'desc'
      })
    : null;

  const matchedMembershipSummary = pickBestMembershipSummary(membershipsPage?.data ?? []);

  let membership = matchedMembershipSummary
    ? await retrieveWhopMembership(matchedMembershipSummary.id).catch(() => null)
    : null;

  const paymentsPage = await client.payments.list({
    company_id: WHOP_COMPANY_ID,
    query: normalizedEmail,
    plan_ids: [WHOP_PLAN_ID_PAID],
    include_free: true,
    first: 10,
    order: 'created_at',
    direction: 'desc'
  });

  const matchedPaymentSummary = pickBestPaymentSummary(
    paymentsPage.data ?? [],
    membership?.id ?? matchedMembershipSummary?.id ?? null
  );

  const payment = matchedPaymentSummary
    ? await retrieveWhopPayment(matchedPaymentSummary.id).catch(() => null)
    : null;

  if (!membership && payment?.membership?.id) {
    membership = await retrieveWhopMembership(payment.membership.id).catch(() => null);
  }

  return {
    memberId: membership?.member?.id ?? payment?.member?.id ?? memberId,
    membership,
    payment,
    invoice: null
  };
};

const resolveStoredPlan = (user, membershipStatus, planId = null) => {
  if (planId && planId !== WHOP_PLAN_ID_PAID) {
    if (String(user.plan || 'free') === 'paid') {
      return 'free';
    }
    return user.plan || 'free';
  }

  if (isActiveWhopMembershipStatus(membershipStatus)) {
    return 'paid';
  }

  if (String(user.plan || 'free') === 'paid') {
    return 'free';
  }

  return user.plan || 'free';
};

export const syncUserBillingState = async (user, options = {}) => {
  if (!user || !isWhopSyncConfigured()) {
    return {
      plan: user?.plan || 'free',
      membershipStatus: user?.whop_membership_status ?? null,
      membership: null,
      payment: null,
      invoice: null
    };
  }

  const forceRecovery = Boolean(options.forceRecovery);
  const [storedMembership, storedPayment, storedInvoice] = await Promise.all([
    user.whop_membership_id
      ? retrieveWhopMembership(user.whop_membership_id).catch(() => null)
      : Promise.resolve(null),
    user.whop_last_payment_id
      ? retrieveWhopPayment(user.whop_last_payment_id).catch(() => null)
      : Promise.resolve(null),
    user.whop_last_invoice_id
      ? retrieveWhopInvoice(user.whop_last_invoice_id).catch(() => null)
      : Promise.resolve(null)
  ]);
  const storedMembershipStatus = storedMembership?.status ?? user.whop_membership_status ?? null;

  const needsRecovery =
    forceRecovery ||
    !storedMembership ||
    (user.plan === 'paid' && !isActiveWhopMembershipStatus(storedMembership?.status));

  let recovered = null;
  if (needsRecovery) {
    try {
      recovered = await recoverWhopBillingStateByEmail(user.email);
    } catch (_error) {
      return {
        plan: user.plan || 'free',
        membershipStatus: storedMembershipStatus,
        membership: storedMembership,
        payment: storedPayment,
        invoice: storedInvoice
      };
    }
  }

  const membership =
    pickBestMembershipSummary([storedMembership, recovered?.membership].filter(Boolean)) ?? null;
  const payment =
    pickBestPaymentSummary(
      [storedPayment, recovered?.payment].filter(Boolean),
      membership?.id ?? storedMembership?.id ?? recovered?.membership?.id ?? null
    ) ?? null;
  const invoice = storedInvoice ?? recovered?.invoice ?? null;
  const membershipStatus = membership?.status ?? storedMembershipStatus;
  const plan = resolveStoredPlan(
    user,
    membershipStatus,
    membership?.plan?.id ?? payment?.plan?.id ?? user.whop_plan_id ?? null
  );

  updateUserBillingById(user.id, {
    plan,
    whop_member_id:
      membership?.member?.id ??
      payment?.member?.id ??
      recovered?.memberId ??
      user.whop_member_id ??
      null,
    whop_membership_id: membership?.id ?? user.whop_membership_id ?? null,
    whop_membership_status: membershipStatus,
    whop_renewal_period_end:
      toSqliteDateTime(membership?.renewal_period_end) ?? user.whop_renewal_period_end ?? null,
    whop_cancel_at_period_end: membership
      ? (membership.cancel_at_period_end ? 1 : 0)
      : (user.whop_cancel_at_period_end ? 1 : 0),
    whop_plan_id: membership?.plan?.id ?? payment?.plan?.id ?? user.whop_plan_id ?? null,
    whop_last_payment_id: payment?.id ?? user.whop_last_payment_id ?? null,
    whop_last_payment_status: payment?.status ?? user.whop_last_payment_status ?? null,
    whop_last_payment_substatus: payment?.substatus ?? user.whop_last_payment_substatus ?? null,
    whop_last_invoice_id: invoice?.id ?? user.whop_last_invoice_id ?? null,
    whop_last_invoice_status: invoice?.status ?? user.whop_last_invoice_status ?? null
  });

  const latest = getUserByEmail(user.email);

  return {
    plan: latest?.plan || plan,
    membershipStatus: latest?.whop_membership_status ?? membershipStatus,
    membership,
    payment,
    invoice
  };
};

export const unwrapWhopWebhook = (body, headers) =>
  getWhopClient({ requireWebhookKey: true }).webhooks.unwrap(body, { headers });
