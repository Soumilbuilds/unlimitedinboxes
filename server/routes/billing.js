import { Router } from 'express';
import {
 getUserByEmail,
 getUserById,
 getUserByXpayCheckoutId,
 getUserByXpayCustomerId,
 getUserByXpaySubscriptionId,
 getManagedBillingCycleByProviderIntentId,
 getManagedBillingCycleByReceiptId,
 enrollManagedRecurringBilling,
 completeManagedBillingCycle,
 cancelManagedRecurringBilling,
 recordXpayWebhookEvent,
 forgetXpayWebhookEvent,
 updateUserBillingById,
 getUserByWhopMembershipId,
 getUserByWhopMemberId,
 getUserByWhopCheckoutSessionId,
 recordWhopWebhookEvent,
 forgetWhopWebhookEvent,
} from '../db/database.js';
import { getUserAccessState } from '../services/access.js';
import {
 xpay,
 PLANS,
 ADDON_CONCURRENT_ORDERS,
 TRIAL_DAYS,
 TRIAL_AUTH_CHARGE_CENTS,
 buildProfile,
 createOneTimeCheckout,
 listLivePaymentMethods,
 isSubscriptionActive,
} from '../services/xpay.js';
import { MANAGED_BILLING_INTERVAL_DAYS } from '../services/recurringBilling.js';
import {
 whop,
 WHOP_COMPANY_ID,
 WHOP_PLAN_IDS,
 buildWhopMembershipUpdates,
 createWhopCheckout,
 getWhopPlanDetails,
 getWhopStatus,
 isWhopMembershipActive,
 selectInitialWhopPlan,
 serializeBillingAddress,
 unwrapWhopWebhook,
} from '../services/whop.js';

const router = Router();

function serializeSessionUser(user) {
 return {
 id: user.id,
 email: user.email,
 plan: user.plan || 'free',
 billingStatus: user.whop_membership_status || user.xpay_subscription_status || null,
 };
}

function getCurrentUser(req) {
 const id = req.session?.user?.id;
 if (id) return getUserById(id);
 if (req.session?.user?.email) return getUserByEmail(req.session.user.email);
 return null;
}

function getRequestBaseUrl(req) {
 const origin = req.get('origin');
 const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:3000')
 .split(',')
 .map((value) => value.trim())
 .filter(Boolean);

 if (
 origin
 && (allowedOrigins.includes(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin))
 ) {
 return origin;
 }

 return process.env.APP_BASE_URL || 'https://app.unlimitedinboxes.com';
}

function parseStoredAddress(value) {
 if (!value) return null;
 try {
 return typeof value === 'string' ? JSON.parse(value) : value;
 } catch {
 return null;
 }
}

function resolveWhopUser(data = {}) {
 const metadata = data.metadata || {};
 const metadataUserId = metadata.user_id || metadata.app_user_id;
 if (metadataUserId) {
 const user = getUserById(Number(metadataUserId));
 if (user) return user;
 }

 const checkoutId = data.checkout_configuration_id || data.checkout_configuration?.id;
 if (checkoutId) {
 const user = getUserByWhopCheckoutSessionId(String(checkoutId));
 if (user) return user;
 }
 if (data.id && String(data.id).startsWith('mem_')) {
 const user = getUserByWhopMembershipId(String(data.id));
 if (user) return user;
 }
 if (data.membership?.id) {
 const user = getUserByWhopMembershipId(String(data.membership.id));
 if (user) return user;
 }
 if (data.member?.id) {
 const user = getUserByWhopMemberId(String(data.member.id));
 if (user) return user;
 }

 const email = data.user?.email || data.member?.user?.email || metadata.email;
 return email ? getUserByEmail(String(email).trim().toLowerCase()) : null;
}

function whopCompanyMatches(data = {}) {
 const companyId = data.company?.id || data.company_id;
 return !companyId || String(companyId) === WHOP_COMPANY_ID;
}

function whopDataBelongsToUser(data, user) {
 const metadata = data?.metadata || {};
 const metadataUserId = metadata.user_id || metadata.app_user_id;
 if (metadataUserId) return String(metadataUserId) === String(user.id);
 const checkoutId = data?.checkout_configuration_id || data?.checkout_configuration?.id;
 if (checkoutId && String(checkoutId) === String(user.whop_checkout_session_id || '')) return true;
 if (data?.membership?.id && String(data.membership.id) === String(user.whop_membership_id || '')) return true;
 if (data?.member?.id && String(data.member.id) === String(user.whop_member_id || '')) return true;
 const email = data?.user?.email || data?.member?.user?.email || metadata.email;
 return Boolean(email && String(email).trim().toLowerCase() === String(user.email).trim().toLowerCase());
}

async function persistWhopMembership(user, membership) {
 if (!user || !membership || !whopCompanyMatches(membership)) return null;
 const metadataUserId = membership.metadata?.user_id || membership.metadata?.app_user_id;
 if (metadataUserId && String(metadataUserId) !== String(user.id)) return null;
 const updates = buildWhopMembershipUpdates(membership);
 if (getWhopStatus(membership.status) === 'canceling' && ['trial', 'basic', 'starter', 'growth', 'unlimited', 'agency'].includes(user.plan)) {
 updates.plan = user.plan;
 }
 updateUserBillingById(user.id, updates);
 return getUserById(user.id) || user;
}

async function persistWhopPayment(user, payment, { succeeded = false } = {}) {
 if (!user || !payment || !whopCompanyMatches(payment)) return null;
 const metadataUserId = payment.metadata?.user_id || payment.metadata?.app_user_id;
 if (metadataUserId && String(metadataUserId) !== String(user.id)) return null;

 const planId = payment.plan?.id || payment.metadata?.plan_id;
 const details = getWhopPlanDetails(planId);
 if (!details) return null;

 let membership = null;
 if (payment.membership?.id) {
 try {
 membership = await whop.memberships.retrieve(String(payment.membership.id));
 } catch (error) {
 console.warn('[whop] Could not retrieve payment membership:', error.message);
 }
 }

 const status = getWhopStatus(membership?.status || payment.membership?.status);
 const updates = membership
 ? buildWhopMembershipUpdates(membership)
 : buildWhopMembershipUpdates({
 id: payment.membership?.id,
 status: status || (succeeded ? 'active' : 'past_due'),
 plan: { id: planId },
 member: payment.member,
 });
 updates.whop_last_payment_status = succeeded ? 'paid' : 'failed';
 if (payment.payment_method?.id) updates.whop_payment_method_id = String(payment.payment_method.id);
 const address = serializeBillingAddress(payment.billing_address);
 if (address) updates.whop_billing_address = address;
 if (details.intro && succeeded) updates.whop_intro_offer_used = 1;

 updateUserBillingById(user.id, updates);
 return getUserById(user.id) || user;
}

function isSuccessfulIntroIntent(intent, user, intentId) {
 const metadata = intent?.metadata || {};
 return String(intent?.intentId || intent?.xIntentId || intentId) === String(intentId)
 && String(intent?.status || '').toUpperCase() === 'SUCCESS'
 && Number(intent?.amount) === TRIAL_AUTH_CHARGE_CENTS
 && String(intent?.currency || '').toUpperCase() === 'USD'
 && String(metadata?.purpose || '') === 'trial_auth'
 && String(metadata?.user_id || '') === String(user.id);
}

function addDays(value, days) {
 const date = new Date(value);
 date.setUTCDate(date.getUTCDate() + days);
 return date;
}

function paymentCompletedAt(intent) {
 const timestamp = Number(intent?.eventTime || intent?.succeededAt || intent?.completedAt);
 return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp) : new Date();
}

function activateIntroOffer(user, paidAt = new Date()) {
 if (user.xpay_intro_offer_used && user.xpay_billing_mode === 'managed') {
 return getUserById(user.id) || user;
 }

 const existingTrialEnd = user.xpay_trial_ends_at ? new Date(user.xpay_trial_ends_at) : null;
 const trialEnd = existingTrialEnd && existingTrialEnd > new Date(paidAt)
 ? existingTrialEnd
 : addDays(paidAt, TRIAL_DAYS);
 updateUserBillingById(user.id, {
 plan: 'trial',
 xpay_billing_mode: 'managed',
 xpay_subscription_plan: 'starter',
 xpay_subscription_status: 'TRIALING',
 xpay_trial_ends_at: trialEnd.toISOString(),
 xpay_intro_offer_used: 1,
 xpay_last_payment_status: 'paid',
 inboxes_limit: 100,
 });
 enrollManagedRecurringBilling(user.id, {
 firstChargeAt: trialEnd,
 amountCents: PLANS.starter.amountCents,
 planKey: 'starter',
 });
 return getUserById(user.id) || user;
}

async function recoverLivePaymentMethod(user) {
 if (user.xpay_default_payment_method_id || !user.xpay_customer_id) {
 return user.xpay_default_payment_method_id || null;
 }
 try {
 const methods = await listLivePaymentMethods(xpay, user.xpay_customer_id);
 const method = methods[0];
 const pmId = method?.paymentMethodId || method?.pmId || method?.id;
 if (!pmId) return null;
 updateUserBillingById(user.id, {
 xpay_default_payment_method_id: String(pmId),
 });
 return String(pmId);
 } catch (error) {
 console.warn('[billing] Payment method token is not available yet:', error.message);
 return null;
 }
}

async function ensureXpayCustomer(user, baseUrl) {
 if (user.xpay_customer_id) {
 return user.xpay_customer_id;
 }

 const response = await xpay.request(
 'POST',
 '/customer/create',
 { customerDetails: buildProfile(user) },
 `customer.${user.id}`
 );

 const customerId = response?.data?.customerId || response?.customerId || response?.data?.id || response?.id;
 if (customerId) {
 updateUserBillingById(user.id, { xpay_customer_id: String(customerId) });
 }

 return customerId;
}

async function autoSetupBilling(user, baseUrl) {
 if (!xpay.configured) {
 throw new Error('xPay is not configured.');
 }

 return {
 success: false,
 reason: 'Complete the secure $1 checkout before creating inboxes.',
 invoiceUrl: null,
 };
}

router.post('/checkout', async (req, res) => {
 if (!req.session.authenticated || !req.session.user?.id) {
 return res.status(401).json({ error: 'Unauthorized' });
 }

 const user = getCurrentUser(req);
 if (!user) return res.status(401).json({ error: 'Unauthorized' });

 if (!whop.configured) {
 return res.status(503).json({ error: 'Whop is not configured.' });
 }

 const currentAccess = getUserAccessState(user);
 if (currentAccess.canAccessApp) {
 return res.status(409).json({
 error: 'This account already has active billing access.',
 billing: serializeBillingState(user),
 });
 }

 try {
 const baseUrl = getRequestBaseUrl(req);
 const planId = selectInitialWhopPlan(user);
 const checkout = await createWhopCheckout(whop, {
 user,
 planId,
 redirectUrl: `${baseUrl}/billing?billing=success&provider=whop`,
 sourceUrl: `${baseUrl}/billing`,
 });

 updateUserBillingById(user.id, {
 whop_checkout_session_id: checkout.sessionId,
 });

 return res.json({
 redirectUrl: checkout.purchaseUrl,
 purchaseUrl: checkout.purchaseUrl,
 sessionId: checkout.sessionId,
 checkoutConfigId: checkout.sessionId,
 planId,
 offerType: planId === WHOP_PLAN_IDS.intro ? 'intro' : 'standard',
 email: user.email,
 billingAddress: parseStoredAddress(user.whop_billing_address),
 provider: 'whop',
 });
 } catch (error) {
 console.error('[billing] Whop checkout failed:', error);
 return res.status(500).json({ error: error.message || 'Failed to create payment session.' });
 }
});

router.post('/subscribe', async (req, res) => {
 if (!req.session.authenticated || !req.session.user?.id) {
 return res.status(401).json({ error: 'Unauthorized' });
 }

 return res.status(410).json({
 error: 'A second subscription checkout is not required. Whop bills the saved card after the five-day trial.',
 });
});

router.get('/status', async (req, res) => {
 if (!req.session.authenticated || !req.session.user?.id) {
 return res.status(401).json({ error: 'Unauthorized' });
 }

 const user = getCurrentUser(req);
 if (!user) return res.status(401).json({ error: 'Unauthorized' });

 const billingStatus = serializeBillingState(user);

 req.session.user = serializeSessionUser(user);
 return res.json(billingStatus);
});

router.post('/cancel', async (req, res) => {
 if (!req.session.authenticated || !req.session.user?.id) {
 return res.status(401).json({ error: 'Unauthorized' });
 }

 const user = getCurrentUser(req);
 if (!user) return res.status(401).json({ error: 'Unauthorized' });

 if (user.whop_membership_id) {
 try {
 const membership = await whop.memberships.cancel(user.whop_membership_id, {
 cancellation_mode: 'at_period_end',
 });
 const latest = await persistWhopMembership(user, membership) || getUserById(user.id) || user;
 req.session.user = serializeSessionUser(latest);
 return res.json({
 success: true,
 provider: 'whop',
 message: 'Automatic renewal is cancelled. Access continues until the end of the billing period.',
 accessUntil: latest.whop_current_period_end || null,
 });
 } catch (error) {
 console.error('[billing] Whop cancel failed:', error);
 return res.status(500).json({ error: error.message || 'Failed to cancel subscription.' });
 }
 }

 if (user.xpay_billing_mode === 'managed' || user.xpay_recurring_enabled) {
 const latest = cancelManagedRecurringBilling(user.id);
 req.session.user = serializeSessionUser(latest);
 return res.json({
 success: true,
 message: 'Automatic renewal is cancelled. No further recurring charges will be made.',
 accessUntil: user.xpay_current_period_end || user.xpay_trial_ends_at || null,
 });
 }

 if (!user.xpay_subscription_id) {
 return res.status(400).json({ error: 'No recurring billing plan to cancel.' });
 }

 try {
 const subResponse = await xpay.request('POST', '/subscription/merchant/cancel', {
 subscriptionId: user.xpay_subscription_id,
 }, `cancel.${user.xpay_subscription_id}`);

 const sub = subResponse?.data || subResponse;

 updateUserBillingById(user.id, {
 xpay_subscription_status: sub?.status || 'cancelled',
 });

 const latest = getUserById(user.id) || user;
 req.session.user = serializeSessionUser(latest);

 return res.json({
 success: true,
 message: 'Subscription will be cancelled. Access continues until the end of the billing period.',
 });
 } catch (error) {
 console.error('[billing] xPay cancel failed:', error);
 return res.status(500).json({ error: error.message });
 }
});

router.post('/return', async (req, res) => {
 if (!req.session.authenticated || !req.session.user?.id) {
 return res.status(401).json({ error: 'Unauthorized' });
 }

 const user = getCurrentUser(req);
 if (!user) return res.status(401).json({ error: 'Unauthorized' });

 const whopPaymentId = req.body?.paymentId
 || req.body?.receiptId
 || req.query?.payment_id
 || req.query?.receipt_id
 || null;
 if (whopPaymentId && String(whopPaymentId).startsWith('pay_')) {
 try {
 const payment = await whop.payments.retrieve(String(whopPaymentId));
 if (!whopCompanyMatches(payment)
 || !getWhopPlanDetails(payment?.plan?.id || payment?.metadata?.plan_id)
 || !whopDataBelongsToUser(payment, user)) {
 return res.status(400).json({ error: 'Payment does not match this account.' });
 }
 if (getWhopStatus(payment?.status) !== 'paid') {
 return res.status(409).json({ error: 'Payment is not complete yet.' });
 }
 const refreshed = await persistWhopPayment(user, payment, { succeeded: true });
 if (!refreshed) return res.status(400).json({ error: 'Payment could not be linked to this account.' });
 const suppliedAddress = serializeBillingAddress(req.body?.billingAddress);
 if (suppliedAddress && !refreshed.whop_billing_address) {
 updateUserBillingById(user.id, { whop_billing_address: suppliedAddress });
 }
 const latest = getUserById(user.id) || refreshed;
 req.session.user = serializeSessionUser(latest);
 return res.json({
 success: true,
 paymentId: String(whopPaymentId),
 provider: 'whop',
 billing: serializeBillingState(latest),
 });
 } catch (error) {
 console.error('[billing] Whop return failed:', error);
 return res.status(500).json({ error: error.message || 'Failed to verify payment.' });
 }
 }

 const requestedSessionId = req.body?.sessionId
 || req.body?.setupId
 || req.query?.xpay_intent_id
 || req.query?.xIntentId
 || req.query?.x_intent_id
 || req.query?.intentId
 || req.query?.session_id
 || null;
 const sessionId = requestedSessionId === '__stored_checkout__'
 ? user.xpay_checkout_id
 : requestedSessionId;
 if (!sessionId) {
 return res.status(400).json({ error: 'Missing payment session.' });
 }

 try {
 const latest = getUserById(user.id) || user;

 if (latest.xpay_checkout_id !== String(sessionId)) {
 return res.status(400).json({ error: 'Payment session does not match this account.' });
 }

 const intentResponse = await xpay.request(
 'GET',
 `/payments/v2/get-intent/${encodeURIComponent(sessionId)}`
 );
 const intent = intentResponse?.data || intentResponse;
 if (!isSuccessfulIntroIntent(intent, latest, sessionId)) {
 return res.status(409).json({ error: 'Payment is not complete yet.' });
 }

 const introUser = activateIntroOffer(latest, paymentCompletedAt(intent));
 const paymentMethodId = await recoverLivePaymentMethod(introUser);
 const refreshed = getUserById(introUser.id) || introUser;
 req.session.user = serializeSessionUser(refreshed);

 return res.json({
 success: true,
 sessionId,
 status: refreshed.xpay_subscription_status,
 plan: refreshed.plan,
 nextChargeAt: refreshed.xpay_next_charge_at,
 paymentMethodOnFile: Boolean(paymentMethodId || refreshed.xpay_default_payment_method_id),
 provider: 'xpay',
 });
 } catch (error) {
 console.error('[billing] xPay return failed:', error);
 return res.status(500).json({ error: error.message || 'Failed to finalize payment.' });
 }
});

router.get('/quota', async (req, res) => {
 if (!req.session.authenticated || !req.session.user?.id) {
 return res.status(401).json({ error: 'Unauthorized' });
 }
 const user = getCurrentUser(req);
 if (!user) return res.status(401).json({ error: 'Unauthorized' });

 return res.json({
 plan: getUserAccessState(user).effectivePlan,
 inboxesUsed: user.inboxes_used || 0,
 inboxesLimit: user.inboxes_limit || 0,
 hasConcurrentOrders: Boolean(user.has_concurrent_orders),
 subscriptionStatus: user.whop_membership_status || user.xpay_subscription_status || null,
 });
});

router.post('/auto-charge-quota', async (req, res) => {
 if (!req.session.authenticated || !req.session.user?.id) {
 return res.status(401).json({ error: 'Unauthorized' });
 }
 const user = getCurrentUser(req);
 if (!user) return res.status(401).json({ error: 'Unauthorized' });

 if (!user.xpay_default_payment_method_id) {
 return res.status(400).json({ error: 'No payment method on file.' });
 }

 if (!isSubscriptionActive(user.xpay_subscription_status)) {
 return res.status(400).json({ error: 'Active subscription required.' });
 }

 try {
 const receiptId = `concurrent_addon_u${user.id}_${Date.now()}`;
 const result = await xpay.request('POST', '/payments/charge-tokenised-pm', {
 customerId: user.xpay_customer_id,
 pmId: user.xpay_default_payment_method_id,
 amount: ADDON_CONCURRENT_ORDERS.amountCents,
 currency: 'USD',
 receiptId,
 metadata: { purpose: 'concurrent_orders_addon', user_id: String(user.id) },
 }, `concurrent.u${user.id}.${receiptId}`);

 const success = String((result?.data || result)?.status || '').toUpperCase() === 'SUCCESS';

 if (success) {
 updateUserBillingById(user.id, { has_concurrent_orders: 1 });
 return res.json({ success: true, message: 'Concurrent orders add-on activated.' });
 }

 updateUserBillingById(user.id, { xpay_last_payment_status: 'failed' });
 return res.status(402).json({ error: 'Payment failed', reason: result?.message || 'Card declined' });
 } catch (error) {
 console.error('[billing] xPay auto-charge failed:', error);
 return res.status(500).json({ error: error.message || 'Payment processing failed.' });
 }
});

async function handleWhopWebhook(req, res) {
 if (!whop.configured || !whop.webhookConfigured) {
 return res.status(503).json({ error: 'Whop webhook verification is not configured.' });
 }

 let event;
 try {
 const headers = Object.fromEntries(
 Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : String(value || '')])
 );
 event = unwrapWhopWebhook(whop, req.rawBody, headers);
 } catch (error) {
 console.error('[whop-webhook] Signature verification failed:', error.message);
 return res.status(400).json({ error: 'Invalid signature.' });
 }

 if (event.company_id && String(event.company_id) !== WHOP_COMPANY_ID) {
 return res.status(400).json({ error: 'Webhook company does not match.' });
 }

 if (!recordWhopWebhookEvent(event.id, event.type)) {
 return res.json({ received: true, duplicate: true, event_type: event.type });
 }

 try {
 const data = event.data || {};
 const user = resolveWhopUser(data);

 switch (event.type) {
 case 'membership.activated':
 case 'membership.deactivated':
 case 'membership.cancel_at_period_end_changed':
 if (user) await persistWhopMembership(user, data);
 break;

 case 'payment.succeeded':
 if (user) await persistWhopPayment(user, data, { succeeded: true });
 break;

 case 'payment.failed':
 if (user) await persistWhopPayment(user, data, { succeeded: false });
 break;

 case 'setup_intent.succeeded':
 if (user) {
 updateUserBillingById(user.id, {
 whop_member_id: data.member?.id ? String(data.member.id) : undefined,
 whop_payment_method_id: data.payment_method?.id ? String(data.payment_method.id) : undefined,
 whop_last_payment_status: 'active',
 });
 }
 break;

 default:
 break;
 }

 return res.json({ received: true, event_type: event.type });
 } catch (error) {
 forgetWhopWebhookEvent(event.id);
 console.error('[whop-webhook] Handler error:', error);
 return res.status(500).json({ error: 'Webhook handler failed.' });
 }
}

router.post('/webhook/whop', handleWhopWebhook);
router.post('/whop-webhook', handleWhopWebhook);

router.post('/webhook', async (req, res) => {
 if (!xpay.configured) {
 return res.status(503).json({ error: 'xPay not configured.' });
 }

 const rawBody = req.rawBody || JSON.stringify(req.body || {});
 const signature = req.headers['xpay-signature'] || '';

 let event;
 try {
 const isValid = xpay.verifyWebhookSignature(rawBody, signature, process.env.XPAY_WEBHOOK_SECRET);
 if (!isValid) {
 return res.status(400).json({ error: 'Invalid signature.' });
 }
 event = req.body || {};
 } catch (error) {
 console.error('[xpay-webhook] Signature verification failed:', error.message);
 return res.status(400).json({ error: 'Invalid signature.' });
 }

 try {
 const eventType = event?.eventType || event?.type || event?.event_type || event?.action || '';
 const eventId = event?.eventId || event?.event_id || null;
 if (!recordXpayWebhookEvent(eventId, eventType)) {
 return res.json({ received: true, duplicate: true, event_type: eventType });
 }

 switch (true) {
 case eventType === 'intent.success': {
 const intentId = event?.intentId || event?.xIntentId;
 if (!intentId) break;

 const recurringCycle = getManagedBillingCycleByProviderIntentId(String(intentId))
 || getManagedBillingCycleByReceiptId(String(event?.receiptId || ''));
 if (recurringCycle) {
 const nextDueAt = addDays(recurringCycle.due_at, MANAGED_BILLING_INTERVAL_DAYS);
 completeManagedBillingCycle(recurringCycle.id, {
 providerIntentId: String(intentId),
 paidAt: paymentCompletedAt(event),
 nextDueAt,
 intervalAmountCents: PLANS.starter.amountCents,
 });
 break;
 }

 const user = getUserByXpayCheckoutId(String(intentId));
 if (!user || !isSuccessfulIntroIntent(event, user, intentId)) break;
 const introUser = activateIntroOffer(user, paymentCompletedAt(event));
 await recoverLivePaymentMethod(introUser);
 break;
 }

 case eventType === 'intent.failed': {
 const intentId = event?.intentId || event?.xIntentId;
 if (!intentId) break;
 const user = getUserByXpayCheckoutId(String(intentId));
 if (!user) break;
 updateUserBillingById(user.id, { xpay_last_payment_status: 'failed' });
 break;
 }

 case eventType === 'subscription.trialing'
 || eventType === 'subscription.active'
 || eventType === 'subscription.cycle_charged': {
 const subscriptionId = event?.subscriptionId || event?.id;
 if (!subscriptionId) break;
 const user = getUserByXpaySubscriptionId(String(subscriptionId));
 if (!user) break;
 if (user.xpay_billing_mode === 'managed') break;
 const metadata = event?.metadata || {};
 if (
 metadata?.user_id
 && String(metadata.user_id) !== String(user.id)
 ) break;
 updateUserBillingById(user.id, {
 xpay_subscription_status: eventType === 'subscription.trialing' ? 'TRIALING' : 'ACTIVE',
 xpay_last_payment_status: eventType === 'subscription.cycle_charged' ? 'paid' : user.xpay_last_payment_status,
 });
 break;
 }

 case eventType === 'subscription.unpaid': {
 const subscriptionId = event?.subscriptionId || event?.id;
 if (!subscriptionId) break;
 const user = getUserByXpaySubscriptionId(String(subscriptionId));
 if (!user) break;
 if (user.xpay_billing_mode === 'managed') break;
 updateUserBillingById(user.id, {
 plan: 'free',
 xpay_subscription_status: 'UNPAID',
 xpay_last_payment_status: 'failed',
 });
 break;
 }

 case eventType === 'payment_method' || eventType === 'payment_method.added': {
 const customerId = event?.data?.customerId || event?.data?.customer?.customerId || event?.data?.customer_id || event?.data?.customer?.id;
 const pmId = event?.data?.paymentMethodId || event?.data?.id || event?.data?.pm_id;
 if (customerId && pmId) {
 const user = getUserByXpayCustomerId(String(customerId));
 if (user) {
 updateUserBillingById(user.id, {
 xpay_default_payment_method_id: String(pmId),
 xpay_last_payment_status: 'active',
 });
 }
 }
 break;
 }

 case eventType === 'subscription' || eventType === 'subscription.created': {
 const subData = event?.data || event;
 const customerId = subData?.customerId || subData?.customer_id || subData?.customer?.customerId || subData?.customer?.id;
 const subId = subData?.subscriptionId || subData?.id;
 const planKey = subData?.metadata?.plan_key || 'starter';
 const status = subData?.status || 'active';

 let user = customerId ? getUserByXpayCustomerId(String(customerId)) : null;
 if (!user && subId) {
 user = getUserByXpaySubscriptionId(String(subId));
 }
 if (!user) break;
 if (user.xpay_billing_mode === 'managed') break;

 updateUserBillingById(user.id, {
 plan: isSubscriptionActive(status) ? planKey : (user.plan || 'free'),
 xpay_subscription_id: subId ? String(subId) : user.xpay_subscription_id,
 xpay_subscription_status: status,
 xpay_subscription_plan: planKey,
 xpay_last_payment_status: subData?.last_payment_status || 'paid',
 });

 if (subData?.trial_end_date) {
 updateUserBillingById(user.id, { xpay_trial_ends_at: subData.trial_end_date });
 }
 break;
 }

 case eventType === 'subscription.updated' || eventType === 'subscription.status_changed': {
 const subData = event?.data || event;
 const subId = subData?.id;
 const planKey = subData?.metadata?.plan_key || 'starter';
 const status = subData?.status || 'unknown';

 if (!subId) break;
 const user = getUserByXpaySubscriptionId(String(subId));
 if (!user) break;
 if (user.xpay_billing_mode === 'managed') break;

 updateUserBillingById(user.id, {
 plan: isSubscriptionActive(status) ? planKey : 'free',
 xpay_subscription_status: status,
 xpay_subscription_plan: planKey,
 xpay_last_payment_status: subData?.last_payment_status || user.xpay_last_payment_status || 'unknown',
 });
 break;
 }

 case eventType === 'subscription.cancelled' || eventType === 'subscription.ended': {
 const subData = event?.data || event;
 const subId = subData?.subscriptionId || subData?.id;
 if (!subId) break;
 const user = getUserByXpaySubscriptionId(String(subId));
 if (!user) break;

 updateUserBillingById(user.id, {
 plan: 'free',
 xpay_subscription_status: 'cancelled',
 xpay_subscription_id: null,
 });
 break;
 }

 case eventType === 'payment_method_token.created' || eventType === 'setup_method.success': {
 const pmData = event?.data || event;
 const newPmId = pmData?.pmId;
 const customerId = pmData?.customerId;
 if (!newPmId || !customerId) break;
 const user = getUserByXpayCustomerId(String(customerId));
 if (!user) break;

 updateUserBillingById(user.id, {
 xpay_default_payment_method_id: String(newPmId),
 xpay_last_payment_status: 'active',
 });
 break;
 }

 case eventType === 'payment.failed' || eventType === 'subscription.payment_failed': {
 const subData = event?.data?.subscription || event?.data || event;
 const subId = subData?.id;
 let user = null;

 // Try to find by subscription ID first
 if (subId) {
 user = getUserByXpaySubscriptionId(String(subId));
 }

 // Fall back to customer_id for one-time payment failures (e.g., $1 trial auth)
 if (!user) {
 const customerId = subData?.customerId || subData?.customer_id || event?.data?.customerId;
 if (customerId) {
 user = getUserByXpayCustomerId(String(customerId));
 }
 }

 if (!user) break;

 const invoiceId = subData?.invoice?.id || subData?.invoiceId || subData?.invoice_id;
 const invoiceUrl = subData?.invoice?.url || subData?.invoiceUrl || subData?.invoice_url;
 const invoiceStatus = subData?.invoice?.status || subData?.invoice_status;

 const updates = {
 xpay_subscription_status: 'past_due',
 xpay_last_payment_status: 'failed',
 };
 if (invoiceId) updates.xpay_last_invoice_id = String(invoiceId);
 if (invoiceStatus) updates.xpay_last_invoice_status = String(invoiceStatus);
 if (invoiceUrl) updates.xpay_last_invoice_url = String(invoiceUrl);

 updateUserBillingById(user.id, updates);
 break;
 }

 case eventType === 'payment.succeeded' || eventType === 'subscription.payment_succeeded': {
 const subData = event?.data?.subscription || event?.data || event;
 const subId = subData?.id;
 const planKey = subData?.metadata?.plan_key || 'starter';
 const status = subData?.status || 'active';

 if (!subId) break;
 const user = getUserByXpaySubscriptionId(String(subId));
 if (!user) break;

 updateUserBillingById(user.id, {
 plan: isSubscriptionActive(status) ? planKey : user.plan,
 xpay_subscription_status: status,
 xpay_subscription_plan: planKey,
 xpay_last_payment_status: 'paid',
 });
 break;
 }

 case eventType === 'intent' || eventType === 'subscription.intent': {
 const intentData = event?.data || event;
 const subId = intentData?.id;
 const status = intentData?.status;

 if (!subId) break;
 const user = getUserByXpaySubscriptionId(String(subId));
 if (!user) break;

 const statusMap = {
 active: 'ACTIVE',
 trialing: 'TRIALING',
 created: 'CREATED',
 cycle_charged: 'ACTIVE',
 unpaid: 'UNPAID',
 cancelled: 'CANCELLED',
 ended: 'ENDED',
 paused: 'PAUSED',
 };

 const mappedStatus = statusMap[status] || status;

 const invoiceId = intentData?.invoice?.id || intentData?.invoiceId || intentData?.invoice_id;
 const invoiceUrl = intentData?.invoice?.url || intentData?.invoiceUrl || intentData?.invoice_url;
 const invoiceStatus = intentData?.invoice?.status || intentData?.invoice_status;

 const updates = { xpay_subscription_status: mappedStatus };
 if (invoiceId) updates.xpay_last_invoice_id = String(invoiceId);
 if (invoiceUrl) updates.xpay_last_invoice_url = String(invoiceUrl);
 if (invoiceStatus) updates.xpay_last_invoice_status = String(invoiceStatus);

 updateUserBillingById(user.id, updates);
 break;
 }

 default:
 break;
 }

 return res.json({ received: true, event_type: eventType });
 } catch (error) {
 forgetXpayWebhookEvent(event?.eventId || event?.event_id || null);
 console.error('[xpay-webhook] Handler error:', error.message);
 return res.status(500).json({ error: 'Webhook handler failed.' });
 }
});

export function serializeBillingState(user) {
 const access = getUserAccessState(user);
 const hasLegacyXpay = Boolean(
 user.xpay_customer_id
 || user.xpay_subscription_id
 || user.xpay_subscription_status
 || user.xpay_checkout_id
 || user.xpay_intro_offer_used
 || user.xpay_billing_mode
 );
 const usesWhop = Boolean(
 user.whop_membership_id
 || user.whop_membership_status
 || user.whop_checkout_session_id
 || !hasLegacyXpay
 );
 const status = usesWhop
 ? (user.whop_membership_status ? String(user.whop_membership_status).toUpperCase() : null)
 : (user.xpay_subscription_status ? String(user.xpay_subscription_status).toUpperCase() : null);
 const plan = access.effectivePlan;

 const isActive = access.isActive;
 const isPastDue = ['UNPAID', 'PAST_DUE', 'UNRESOLVED'].includes(status);

 const trialEndsAt = usesWhop ? user.whop_current_period_end : user.xpay_trial_ends_at;
 const isTrialing = access.isTrialing;
 const nextChargeAmounts = {
 [WHOP_PLAN_IDS.intro]: 999,
 [WHOP_PLAN_IDS.basic]: 999,
 [WHOP_PLAN_IDS.starter]: 3999,
 [WHOP_PLAN_IDS.growth]: 9999,
 [WHOP_PLAN_IDS.unlimited]: 19999,
 [WHOP_PLAN_IDS.agency]: 29999,
 };

 return {
 ...access,
 provider: usesWhop ? 'whop' : 'xpay',
 plan,
 status,
 isActive,
 isTrialing,
 isPastDue,
 trialEndsAt: trialEndsAt || null,
 customerId: usesWhop ? user.whop_member_id : user.xpay_customer_id || null,
 memberId: usesWhop ? user.whop_member_id || null : null,
 subscriptionId: usesWhop ? user.whop_membership_id || null : user.xpay_subscription_id || null,
 membershipId: usesWhop ? user.whop_membership_id || null : null,
 planId: usesWhop ? user.whop_plan_id || null : user.xpay_plan_id || null,
 checkoutSessionId: usesWhop ? user.whop_checkout_session_id || null : user.xpay_checkout_id || null,
 billingMode: usesWhop ? 'native' : (user.xpay_billing_mode || (user.xpay_subscription_id ? 'native' : null)),
 lifecycle: isPastDue
 ? 'past_due'
 : (access.isTrialing
 ? 'trialing'
 : (status === 'ACTIVE' && access.canAccessApp
 ? 'active'
 : ((usesWhop ? user.whop_cancel_at_period_end : user.xpay_cancel_at_period_end)
 ? 'cancelled'
 : ((usesWhop ? user.whop_checkout_session_id : user.xpay_checkout_id) ? 'intro_pending' : 'fresh')))),
 recurringEnabled: usesWhop ? Boolean(user.whop_membership_id) : Boolean(user.xpay_recurring_enabled),
 cancelAtPeriodEnd: Boolean(usesWhop ? user.whop_cancel_at_period_end : user.xpay_cancel_at_period_end),
 paymentMethodOnFile: Boolean(usesWhop ? user.whop_payment_method_id : user.xpay_default_payment_method_id),
 billingAddress: usesWhop ? parseStoredAddress(user.whop_billing_address) : null,
 nextChargeAt: usesWhop ? user.whop_current_period_end || null : user.xpay_next_charge_at || null,
 nextChargeAmount: usesWhop ? (nextChargeAmounts[user.whop_plan_id] || null) : PLANS.starter.amountCents,
 billingIntervalDays: 28,
 paymentMethodStatus: usesWhop ? user.whop_last_payment_status || null : user.xpay_last_payment_status || null,
 lastPaymentStatus: usesWhop ? user.whop_last_payment_status || null : user.xpay_last_payment_status || null,
 invoiceId: user.xpay_last_invoice_id || null,
 invoiceStatus: user.xpay_last_invoice_status || null,
 invoiceUrl: user.xpay_last_invoice_url || null,
 inboxesUsed: access.inboxesUsed,
 inboxesLimit: access.inboxesLimit,
 hasConcurrentOrders: Boolean(user.has_concurrent_orders),
 };
}

// Kept for callers and tests written against the legacy export name.
export const serializeXpayBillingState = serializeBillingState;

export { autoSetupBilling };
export default router;
