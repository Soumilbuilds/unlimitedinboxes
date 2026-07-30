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

const router = Router();

function serializeSessionUser(user) {
 return {
 id: user.id,
 email: user.email,
 plan: user.plan || 'free',
 billingStatus: user.xpay_subscription_status || null,
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

 if (!xpay.configured) {
 return res.status(503).json({ error: 'xPay is not configured.' });
 }

 const currentAccess = getUserAccessState(user);
 if (currentAccess.canAccessApp || user.xpay_intro_offer_used) {
 return res.status(409).json({
 error: 'The $1 intro offer has already been paid for this account. Please do not pay again.',
 billing: serializeXpayBillingState(user),
 });
 }

 try {
 const baseUrl = getRequestBaseUrl(req);
 const customerId = await ensureXpayCustomer(user, baseUrl);

 if (user.xpay_checkout_id && user.xpay_checkout_url) {
 try {
 const storedResponse = await xpay.request(
 'GET',
 `/payments/v2/get-intent/${encodeURIComponent(user.xpay_checkout_id)}`
 );
 const storedIntent = storedResponse?.data || storedResponse;
 const storedStatus = String(storedIntent?.status || '').toUpperCase();
 if (storedStatus === 'SUCCESS' && isSuccessfulIntroIntent(storedIntent, user, user.xpay_checkout_id)) {
 const refreshed = activateIntroOffer(user, paymentCompletedAt(storedIntent));
 await recoverLivePaymentMethod(refreshed);
 return res.status(409).json({
 error: 'The $1 payment is already complete. Please do not pay again.',
 billing: serializeXpayBillingState(getUserById(user.id) || refreshed),
 });
 }
 if (['CREATED', 'CHECKOUT_OPENED', 'PENDING', 'PROCESSING'].includes(storedStatus)) {
 return res.json({
 redirectUrl: user.xpay_checkout_url,
 sessionId: user.xpay_checkout_id,
 provider: 'xpay',
 reused: true,
 });
 }
 } catch (error) {
 console.warn('[billing] Could not resume the stored intro checkout:', error.message);
 }
 }

 const receiptId = `trial_auth_u${user.id}`;
 const checkout = await createOneTimeCheckout(xpay, {
 user,
 customerId,
 amount: TRIAL_AUTH_CHARGE_CENTS,
 description: '$1 today for 100 inboxes; $49.99 in 7 days and every 4 weeks until cancelled.',
 receiptId,
 metadata: {
 purpose: 'trial_auth',
 user_id: String(user.id),
 },
 callbackUrl: `${baseUrl}/billing?billing=success&intent=starter`,
 cancelUrl: `${baseUrl}/billing?intent=starter`,
 });

 updateUserBillingById(user.id, {
 xpay_checkout_id: checkout.intentId,
 xpay_checkout_url: checkout.redirectUrl,
 xpay_subscription_plan: 'trial',
 });

 return res.json({
 redirectUrl: checkout.redirectUrl,
 sessionId: checkout.intentId,
 provider: 'xpay',
 });
 } catch (error) {
 console.error('[billing] xPay checkout failed:', error);
 return res.status(500).json({ error: error.message || 'Failed to create payment session.' });
 }
});

router.post('/subscribe', async (req, res) => {
 if (!req.session.authenticated || !req.session.user?.id) {
 return res.status(401).json({ error: 'Unauthorized' });
 }

 return res.status(410).json({
 error: 'A second subscription checkout is no longer required. The saved card from the $1 checkout is billed automatically after 7 days.',
 });
});

router.get('/status', async (req, res) => {
 if (!req.session.authenticated || !req.session.user?.id) {
 return res.status(401).json({ error: 'Unauthorized' });
 }

 const user = getCurrentUser(req);
 if (!user) return res.status(401).json({ error: 'Unauthorized' });

 const billingStatus = serializeXpayBillingState(user);

 req.session.user = serializeSessionUser(user);
 return res.json(billingStatus);
});

router.post('/cancel', async (req, res) => {
 if (!req.session.authenticated || !req.session.user?.id) {
 return res.status(401).json({ error: 'Unauthorized' });
 }

 const user = getCurrentUser(req);
 if (!user) return res.status(401).json({ error: 'Unauthorized' });

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
 plan: user.xpay_subscription_plan || user.plan || 'free',
 inboxesUsed: user.inboxes_used || 0,
 inboxesLimit: user.inboxes_limit || 0,
 hasConcurrentOrders: Boolean(user.has_concurrent_orders),
 subscriptionStatus: user.xpay_subscription_status || null,
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

export function serializeXpayBillingState(user) {
 const access = getUserAccessState(user);
 const status = user.xpay_subscription_status
 ? String(user.xpay_subscription_status).toUpperCase()
 : null;
 const plan = access.effectivePlan;

 const isActive = access.isActive;
 const isPastDue = ['UNPAID', 'PAST_DUE'].includes(status);

 const trialEnd = user.xpay_trial_ends_at ? new Date(user.xpay_trial_ends_at) : null;
 const isTrialing = trialEnd && trialEnd > new Date() && status === 'TRIALING';

 return {
 ...access,
 provider: 'xpay',
 plan,
 status,
 isActive,
 isTrialing,
 isPastDue,
 trialEndsAt: user.xpay_trial_ends_at || null,
 customerId: user.xpay_customer_id || null,
 subscriptionId: user.xpay_subscription_id || null,
 billingMode: user.xpay_billing_mode || (user.xpay_subscription_id ? 'native' : null),
 lifecycle: isPastDue
 ? 'past_due'
 : (access.isTrialing
 ? 'trialing'
 : (status === 'ACTIVE' && access.canAccessApp
 ? 'active'
 : (user.xpay_cancel_at_period_end ? 'cancelled' : (user.xpay_checkout_id ? 'intro_pending' : 'fresh')))),
 recurringEnabled: Boolean(user.xpay_recurring_enabled),
 cancelAtPeriodEnd: Boolean(user.xpay_cancel_at_period_end),
 paymentMethodOnFile: Boolean(user.xpay_default_payment_method_id),
 nextChargeAt: user.xpay_next_charge_at || null,
 nextChargeAmount: PLANS.starter.amountCents,
 billingIntervalDays: MANAGED_BILLING_INTERVAL_DAYS,
 paymentMethodStatus: user.xpay_last_payment_status || null,
 lastPaymentStatus: user.xpay_last_payment_status || null,
 invoiceId: user.xpay_last_invoice_id || null,
 invoiceStatus: user.xpay_last_invoice_status || null,
 invoiceUrl: user.xpay_last_invoice_url || null,
 inboxesUsed: access.inboxesUsed,
 inboxesLimit: access.inboxesLimit,
 hasConcurrentOrders: Boolean(user.has_concurrent_orders),
 };
}

export { autoSetupBilling };
export default router;
