import { Router } from 'express';
import { randomUUID } from 'node:crypto';
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
 createWhopPlanChange,
 getWhopPlanChangeById,
 getActiveWhopPlanChange,
 getWhopPlanChangeByPaymentId,
 updateWhopPlanChange,
 bindWhopPlanChangePayment,
 claimWhopPlanChange,
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
 WHOP_PLAN_CATALOG,
 buildWhopMembershipUpdates,
 createWhopSavedCardPayment,
 createWhopCheckout,
 getWhopCatalogPlan,
 getWhopPlanDetails,
 getWhopStatus,
 getWhopEventTime,
 isWhopEventNewer,
 isWhopPaymentFailed,
 isWhopPaymentPaid,
 isWhopMembershipActive,
 selectInitialWhopPlan,
 serializeWhopPlanCatalog,
 serializeBillingAddress,
 unwrapWhopWebhook,
 validateWhopPromoCode,
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

async function persistWhopMembership(user, membership, { eventAt = null, force = false } = {}) {
 if (!user || !membership || !whopCompanyMatches(membership)) return null;
 const metadataUserId = membership.metadata?.user_id || membership.metadata?.app_user_id;
 if (metadataUserId && String(metadataUserId) !== String(user.id)) return null;
 const incomingId = membership.id ? String(membership.id) : '';
 const incomingEventAt = getWhopEventTime(eventAt || membership.updated_at || membership.created_at)
 || (force ? new Date().toISOString() : null);
 if (!force && !isWhopEventNewer(incomingEventAt, user.whop_membership_event_at)) return user;
 const incomingActive = isWhopMembershipActive(membership.status);
 const existingActive = isWhopMembershipActive(user.whop_membership_status);
 if (user.whop_membership_id && incomingId && incomingId !== String(user.whop_membership_id)
 && (existingActive || !incomingActive)) {
 return user;
 }
 const updates = buildWhopMembershipUpdates(membership);
 if (incomingEventAt) updates.whop_membership_event_at = incomingEventAt;
 if (getWhopStatus(membership.status) === 'canceling' && ['trial', 'basic', 'starter', 'growth', 'unlimited', 'agency'].includes(user.plan)) {
 updates.plan = user.plan;
 }
 updateUserBillingById(user.id, updates);
 return getUserById(user.id) || user;
}

async function persistWhopPayment(user, payment, { succeeded = false, eventAt = null, force = false } = {}) {
 if (!user || !payment || !whopCompanyMatches(payment)) return null;
 const metadataUserId = payment.metadata?.user_id || payment.metadata?.app_user_id;
 if (metadataUserId && String(metadataUserId) !== String(user.id)) return null;

 const planId = payment.plan?.id || payment.metadata?.plan_id;
 const details = getWhopPlanDetails(planId);
 if (!details) return null;
 const incomingEventAt = getWhopEventTime(eventAt || payment.updated_at || payment.created_at)
 || (force ? new Date().toISOString() : null);
 if (!force && !isWhopEventNewer(incomingEventAt, user.whop_payment_event_at)) return user;

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
 if (incomingEventAt) updates.whop_payment_event_at = incomingEventAt;
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

function startPlanChange(user, target, promo = null) {
 const active = getActiveWhopPlanChange(user.id);
 if (active) {
 const sameTarget = String(active.target_plan_id) === String(target.planId);
 const samePromo = String(active.promo_code_id || '') === String(promo?.id || '');
 if (sameTarget && samePromo) return { ...active, reused: true };
 const error = new Error('Another plan change is already being processed. Please wait for it to finish before selecting a different plan.');
 error.code = 'PLAN_CHANGE_IN_PROGRESS';
 throw error;
 }
 const change = createWhopPlanChange({
 id: randomUUID(),
 userId: user.id,
 targetPlanId: target.planId,
 sourceMembershipId: user.whop_membership_id || null,
 promoCodeId: promo?.id || null,
 });
 updateUserBillingById(user.id, {
 whop_pending_plan_id: target.planId,
 whop_pending_promo_code_id: promo?.id || null,
 whop_pending_payment_id: null,
 whop_plan_change_requested_at: change.requested_at,
 });
 return change;
}

function getPlanRank(planKeyOrId) {
 return WHOP_PLAN_CATALOG.findIndex((plan) => plan.key === planKeyOrId || plan.planId === planKeyOrId);
}

function serializePlansForUser(user) {
 const access = getUserAccessState(user);
 const currentPlanKey = access.canAccessApp ? (access.isTrialing ? 'trial' : access.effectivePlan) : 'free';
 const currentRank = getPlanRank(currentPlanKey);
 const pendingPlan = getWhopCatalogPlan(user.whop_pending_plan_id);
 return serializeWhopPlanCatalog().map((plan) => ({
 ...plan,
 current: plan.key === currentPlanKey,
 action: plan.trial
 ? (access.introOfferUsed ? (access.isTrialing ? 'current' : 'trial_consumed') : 'start_trial')
 : (plan.rank === currentRank ? 'current' : (plan.rank > currentRank ? 'upgrade' : 'downgrade')),
 disabled: plan.trial && access.introOfferUsed && !access.isTrialing,
 pending: pendingPlan?.key === plan.key,
 }));
}

async function createPlanFallbackCheckout(user, target, baseUrl, promo = null, existingChange = null) {
 const change = existingChange || startPlanChange(user, target, promo);
 const checkout = await createWhopCheckout(whop, {
 user,
 planId: target.planId,
 redirectUrl: `${baseUrl}/plans?billing=success&provider=whop`,
 purpose: 'plan_change_checkout',
 idempotencyKey: `ui.plan-change.${change.id}.checkout`,
 planChangeId: change.id,
 });
 updateWhopPlanChange(change.id, {
 status: 'awaiting_checkout',
 checkout_id: checkout.sessionId,
 checkout_url: checkout.purchaseUrl,
 });
 updateUserBillingById(user.id, {
 whop_checkout_session_id: checkout.sessionId,
 whop_pending_plan_id: target.planId,
 whop_pending_promo_code_id: promo?.id || null,
 whop_plan_change_requested_at: new Date().toISOString(),
 });
 return {
 checkoutRequired: true,
 sessionId: checkout.sessionId,
 purchaseUrl: checkout.purchaseUrl,
 planId: target.planId,
 promoCode: promo?.code || null,
 email: user.email,
 billingAddress: parseStoredAddress(user.whop_billing_address),
 checkout: {
 sessionId: checkout.sessionId, purchaseUrl: checkout.purchaseUrl, planId: target.planId,
 promoCode: promo?.code || null,
 },
 planChangeId: change.id,
 };
}

async function retrievePendingPromo(user) {
 if (!user?.whop_pending_promo_code_id) return null;
 try {
 const promo = await whop.promoCodes.retrieve(String(user.whop_pending_promo_code_id));
 return promo?.id ? { id: String(promo.id), code: String(promo.code || '') } : null;
 } catch {
 return null;
 }
}

function resolvePaymentPlanChange(user, payment) {
 const paymentId = payment?.id ? String(payment.id) : '';
 const metadataChangeId = payment?.metadata?.plan_change_id;
 const change = (metadataChangeId && getWhopPlanChangeById(metadataChangeId))
 || getWhopPlanChangeByPaymentId(paymentId);
 if (!change || String(change.user_id) !== String(user.id)) return null;
 return change;
}

async function applyVerifiedPlanPayment(user, payment, expectedChange = null) {
 if (!whopCompanyMatches(payment) || !whopDataBelongsToUser(payment, user)) {
 throw new Error('The plan payment does not match this account.');
 }
 const change = expectedChange || resolvePaymentPlanChange(user, payment);
 if (!change) throw new Error('The plan payment is not bound to an active plan change.');
 if (change.status === 'completed') return getUserById(user.id) || user;
 if (['failed', 'superseded'].includes(change.status)) throw new Error('This plan change is no longer active.');
 const metadataChangeId = payment.metadata?.plan_change_id;
 if (!['plan_change', 'plan_change_checkout'].includes(String(payment.metadata?.purpose || ''))) {
 throw new Error('The payment was not created for a plan change.');
 }
 if (metadataChangeId && String(metadataChangeId) !== String(change.id)) {
 throw new Error('The plan payment does not match this plan change.');
 }
 const paymentCheckoutId = payment.checkout_configuration_id || payment.checkout_configuration?.id;
 if (change.checkout_id && paymentCheckoutId
 && String(paymentCheckoutId) !== String(change.checkout_id)) {
 throw new Error('The payment does not match the secure checkout for this plan change.');
 }
 const paymentId = String(payment.id || '');
 if (!paymentId || (change.payment_id && paymentId !== String(change.payment_id))) {
 throw new Error('The plan payment reference does not match this plan change.');
 }
 if (change.status === 'cleanup_pending') {
 const currentUser = getUserById(user.id) || user;
 const oldMembershipId = change.source_membership_id;
 if (oldMembershipId && oldMembershipId !== currentUser.whop_membership_id) {
 await whop.memberships.cancel(oldMembershipId, { cancellation_mode: 'immediate' });
 }
 updateWhopPlanChange(change.id, { status: 'completed', completed_at: new Date().toISOString(), last_error: null });
 updateUserBillingById(user.id, {
 whop_pending_plan_id: null,
 whop_pending_promo_code_id: null,
 whop_pending_payment_id: null,
 whop_plan_change_requested_at: null,
 });
 return getUserById(user.id) || currentUser;
 }
 if (!bindWhopPlanChangePayment(change.id, paymentId)) throw new Error('The plan payment could not be bound to this plan change.');
 const targetPlanId = change.target_plan_id;
 const paidPlanId = payment.plan?.id || payment.metadata?.plan_id;
 if (String(paidPlanId || '') !== String(targetPlanId)) throw new Error('The plan payment does not match the selected plan.');
 if (!isWhopPaymentPaid(payment)) return null;

 const claimed = claimWhopPlanChange(change.id, paymentId);
 if (!claimed) {
 const current = getWhopPlanChangeById(change.id);
 if (current?.status === 'completed') return getUserById(user.id) || user;
 return null;
 }

 const oldMembershipId = claimed.source_membership_id;
 const newMembershipId = payment.membership?.id ? String(payment.membership.id) : '';
 if (!newMembershipId) throw new Error('Whop confirmed payment but has not attached the new membership yet.');
 const latest = await persistWhopPayment(user, payment, { succeeded: true, force: true });
 if (!latest) throw new Error('Whop confirmed payment but did not attach a valid membership.');
 if (oldMembershipId && oldMembershipId !== newMembershipId) {
 try {
 await whop.memberships.cancel(oldMembershipId, { cancellation_mode: 'immediate' });
 } catch (error) {
 updateWhopPlanChange(change.id, { status: 'cleanup_pending', last_error: error.message || 'Old membership cleanup failed.' });
 throw error;
 }
 }
 updateWhopPlanChange(change.id, { status: 'completed', completed_at: new Date().toISOString(), last_error: null });
 updateUserBillingById(user.id, {
 whop_pending_plan_id: null,
 whop_pending_promo_code_id: null,
 whop_pending_payment_id: null,
 whop_plan_change_requested_at: null,
 });
 return getUserById(user.id) || latest;
}

async function chargePendingDowngrade(user, existingChange = null, baseUrl = process.env.APP_BASE_URL || 'https://app.unlimitedinboxes.com') {
 const change = existingChange || getActiveWhopPlanChange(user?.id);
 const target = getWhopCatalogPlan(change?.target_plan_id);
 if (!change || change.status !== 'scheduled' || !target || target.trial) return null;
 if (!user.whop_member_id || !user.whop_payment_method_id) {
 return createPlanFallbackCheckout(user, target, baseUrl, null, change);
 }
 const payment = await createWhopSavedCardPayment(whop, {
 user,
 planId: target.planId,
 promoCodeId: change.promo_code_id || null,
 idempotencyKey: `ui.plan-change.${change.id}.payment`,
 planChangeId: change.id,
 });
 bindWhopPlanChangePayment(change.id, payment.id);
 updateWhopPlanChange(change.id, { status: 'pending_payment' });
 updateUserBillingById(user.id, { whop_pending_payment_id: payment.id ? String(payment.id) : null });
 if (isWhopPaymentPaid(payment)) return applyVerifiedPlanPayment(user, payment, change);
 if (isWhopPaymentFailed(payment)) {
 updateUserBillingById(user.id, { whop_last_payment_status: 'failed' });
 return createPlanFallbackCheckout(user, target, baseUrl, null, change);
 }
 return null;
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
 idempotencyKey: `ui.initial-checkout.${user.id}.${planId}`,
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

router.get('/plans', (req, res) => {
 if (!req.session.authenticated || !req.session.user?.id) return res.status(401).json({ error: 'Unauthorized' });
 const user = getCurrentUser(req);
 if (!user) return res.status(401).json({ error: 'Unauthorized' });
 const access = getUserAccessState(user);
 const pendingChange = getActiveWhopPlanChange(user.id);
 return res.json({
 plans: serializePlansForUser(user),
 currentPlan: access.canAccessApp ? (access.isTrialing ? 'trial' : access.effectivePlan) : 'free',
 pendingPlan: getWhopCatalogPlan(user.whop_pending_plan_id)?.key || null,
 trialConsumed: access.introOfferUsed,
 paymentMethodOnFile: Boolean(user.whop_member_id && user.whop_payment_method_id),
 billingAddressOnFile: Boolean(parseStoredAddress(user.whop_billing_address)),
 currentPeriodEnd: user.whop_current_period_end || null,
 cancelAtPeriodEnd: Boolean(user.whop_cancel_at_period_end),
 legacyBilling: Boolean(access.canAccessApp && !user.whop_membership_id && user.xpay_subscription_id),
 pendingCheckout: pendingChange?.status === 'awaiting_checkout' ? {
 sessionId: pendingChange.checkout_id,
 purchaseUrl: pendingChange.checkout_url,
 planChangeId: pendingChange.id,
 } : null,
 });
});

router.post('/plans/coupon', async (req, res) => {
 if (!req.session.authenticated || !req.session.user?.id) return res.status(401).json({ error: 'Unauthorized' });
 const user = getCurrentUser(req);
 if (!user) return res.status(401).json({ error: 'Unauthorized' });
 if (!whop.configured) return res.status(503).json({ error: 'Whop is not configured.' });
 try {
 const promo = await validateWhopPromoCode(whop, {
 code: req.body?.code,
 planKey: req.body?.planKey || req.body?.plan || req.body?.planId,
 });
 return res.json({ promo });
 } catch (error) {
 return res.status(400).json({ error: error.message || 'Coupon validation failed.' });
 }
});

router.post('/plans/change', async (req, res) => {
 if (!req.session.authenticated || !req.session.user?.id) return res.status(401).json({ error: 'Unauthorized' });
 let user = getCurrentUser(req);
 if (!user) return res.status(401).json({ error: 'Unauthorized' });
 if (!whop.configured) return res.status(503).json({ error: 'Whop is not configured.' });

 const target = getWhopCatalogPlan(req.body?.planKey || req.body?.plan || req.body?.planId);
 if (!target || target.trial) return res.status(400).json({ error: 'Select a paid plan.' });
 const access = getUserAccessState(user);
 if (access.canAccessApp && !user.whop_membership_id && user.xpay_subscription_id) {
 return res.status(409).json({
 error: 'This legacy subscription must be migrated before changing plans. Contact support so you are not billed twice.',
 code: 'LEGACY_SUBSCRIPTION_MIGRATION_REQUIRED',
 });
 }
 const currentKey = access.isTrialing ? 'trial' : access.effectivePlan;
 const currentRank = getPlanRank(currentKey);
 const targetRank = getPlanRank(target.key);
 if (access.canAccessApp && currentKey === target.key) return res.status(409).json({ error: 'This is already your current plan.' });

 let promo = null;
 if (String(req.body?.couponCode || '').trim()) {
 try {
 promo = await validateWhopPromoCode(whop, { code: req.body.couponCode, planKey: target.key });
 } catch (error) {
 return res.status(400).json({ error: error.message || 'Coupon validation failed.' });
 }
 }
 try {
 const change = startPlanChange(user, target, promo);
 if (change.reused && change.status === 'awaiting_checkout') {
 return res.json({
 checkoutRequired: true,
 sessionId: change.checkout_id,
 purchaseUrl: change.checkout_url,
 planId: target.planId,
 promoCode: promo?.code || null,
 email: user.email,
 billingAddress: parseStoredAddress(user.whop_billing_address),
 planChangeId: change.id,
 });
 }
 if (change.reused && ['pending_payment', 'applying'].includes(change.status)) {
 return res.status(202).json({
 success: true,
 paymentPending: true,
 paymentId: change.payment_id,
 targetPlan: target.key,
 });
 }
 if (change.reused && change.status === 'scheduled') {
 return res.json({
 scheduled: true,
 effectiveAt: change.effective_at || user.whop_current_period_end || null,
 currentPlan: currentKey,
 pendingPlan: target.key,
 message: `Your ${target.name} plan will begin after the current billing period ends.`,
 });
 }
 if (targetRank < currentRank && access.canAccessApp && user.whop_membership_id) {
 if (!user.whop_member_id || !user.whop_payment_method_id) {
 return res.status(402).json(await createPlanFallbackCheckout(user, target, getRequestBaseUrl(req), promo, change));
 }
 const membership = await whop.memberships.cancel(user.whop_membership_id, { cancellation_mode: 'at_period_end' });
 updateWhopPlanChange(change.id, {
 status: 'scheduled',
 effective_at: getWhopEventTime(membership.renewal_period_end) || user.whop_current_period_end || null,
 });
 await persistWhopMembership(user, membership, { force: true });
 user = getUserById(user.id) || user;
 return res.json({
 scheduled: true,
 effectiveAt: user.whop_current_period_end || null,
 currentPlan: currentKey,
 pendingPlan: target.key,
 message: `Your ${target.name} plan will begin after the current billing period ends.`,
 });
 }

 if (!user.whop_member_id || !user.whop_payment_method_id) {
 return res.json(await createPlanFallbackCheckout(user, target, getRequestBaseUrl(req), promo, change));
 }

 const payment = await createWhopSavedCardPayment(whop, {
 user,
 planId: target.planId,
 promoCodeId: promo?.id,
 idempotencyKey: `ui.plan-change.${change.id}.payment`,
 planChangeId: change.id,
 });
 bindWhopPlanChangePayment(change.id, payment.id);
 updateWhopPlanChange(change.id, { status: 'pending_payment' });
 updateUserBillingById(user.id, {
 whop_pending_plan_id: target.planId,
 whop_pending_promo_code_id: promo?.id || null,
 whop_pending_payment_id: payment.id ? String(payment.id) : null,
 whop_plan_change_requested_at: new Date().toISOString(),
 });

 if (isWhopPaymentPaid(payment)) {
 const latest = await applyVerifiedPlanPayment(user, payment, change);
 req.session.user = serializeSessionUser(latest);
 return res.json({ success: true, paid: true, billing: serializeBillingState(latest) });
 }
 if (isWhopPaymentFailed(payment)) {
 updateUserBillingById(user.id, { whop_last_payment_status: 'failed' });
 return res.status(402).json(await createPlanFallbackCheckout(user, target, getRequestBaseUrl(req), promo, change));
 }
 return res.status(202).json({ success: true, paymentPending: true, paymentId: payment.id, targetPlan: target.key });
 } catch (error) {
 console.error('[billing] Whop plan change failed:', error);
 const failedChange = getActiveWhopPlanChange(user.id);
 if (failedChange?.status === 'created') updateWhopPlanChange(failedChange.id, { status: 'failed', last_error: error.message });
 if (targetRank < currentRank && access.canAccessApp) {
 return res.status(500).json({ error: error.message || 'Could not schedule the downgrade.' });
 }
 if (user.whop_member_id && user.whop_payment_method_id) {
 try {
 return res.status(402).json(await createPlanFallbackCheckout(user, target, getRequestBaseUrl(req), promo));
 } catch (checkoutError) {
 console.error('[billing] Whop plan fallback failed:', checkoutError);
 }
 }
 return res.status(400).json({ error: error.message || 'Plan change failed.' });
 }
});

router.post('/plans/change/confirm', async (req, res) => {
 if (!req.session.authenticated || !req.session.user?.id) return res.status(401).json({ error: 'Unauthorized' });
 const user = getCurrentUser(req);
 if (!user) return res.status(401).json({ error: 'Unauthorized' });
 const paymentId = String(req.body?.paymentId || '');
 const change = getWhopPlanChangeByPaymentId(paymentId) || getActiveWhopPlanChange(user.id);
 if (!/^pay_[A-Za-z0-9_-]+$/.test(paymentId)
 || !change || String(change.user_id) !== String(user.id)
 || paymentId !== String(change.payment_id || '')) {
 return res.status(400).json({ error: 'The plan payment reference is invalid.' });
 }
 try {
 const payment = await whop.payments.retrieve(paymentId);
 const target = getWhopCatalogPlan(change.target_plan_id);
 if (!target || target.trial) return res.status(409).json({ error: 'No plan change is pending.' });
 if (isWhopPaymentPaid(payment)) {
 const latest = await applyVerifiedPlanPayment(user, payment, change);
 if (!latest) return res.status(202).json({ success: true, paymentPending: true, paymentId });
 req.session.user = serializeSessionUser(latest);
 return res.json({ success: true, paid: true, billing: serializeBillingState(latest) });
 }
 if (isWhopPaymentFailed(payment)) {
 const promo = await retrievePendingPromo(user);
 updateWhopPlanChange(change.id, { status: 'failed', last_error: 'Saved payment method charge failed.' });
 return res.status(402).json(await createPlanFallbackCheckout(user, target, getRequestBaseUrl(req), promo));
 }
 return res.status(202).json({ success: true, paymentPending: true, paymentId });
 } catch (error) {
 return res.status(500).json({ error: error.message || 'Failed to verify plan payment.' });
 }
});

router.post('/plans/confirm', async (req, res) => {
 if (!req.session.authenticated || !req.session.user?.id) return res.status(401).json({ error: 'Unauthorized' });
 const user = getCurrentUser(req);
 if (!user) return res.status(401).json({ error: 'Unauthorized' });
 const paymentId = String(req.body?.paymentId || req.body?.receiptId || '');
 if (!/^pay_[A-Za-z0-9_-]+$/.test(paymentId)) return res.status(400).json({ error: 'The plan payment reference is invalid.' });
 try {
 const payment = await whop.payments.retrieve(paymentId);
 const change = resolvePaymentPlanChange(user, payment);
 if (!change || (change.payment_id && String(change.payment_id) !== paymentId)) {
 return res.status(400).json({ error: 'The plan payment does not match this plan change.' });
 }
 const target = getWhopCatalogPlan(change.target_plan_id);
 if (!target || target.trial) return res.status(409).json({ error: 'No plan change is pending.' });
 if (!whopCompanyMatches(payment) || !whopDataBelongsToUser(payment, user)) {
 return res.status(400).json({ error: 'The plan payment does not match this account.' });
 }
 if (isWhopPaymentPaid(payment)) {
 const latest = await applyVerifiedPlanPayment(user, payment, change);
 if (!latest) return res.status(202).json({ success: true, paymentPending: true, paymentId });
 req.session.user = serializeSessionUser(latest);
 return res.json({ success: true, paid: true, billing: serializeBillingState(latest) });
 }
 if (isWhopPaymentFailed(payment)) {
 const promo = await retrievePendingPromo(user);
 updateWhopPlanChange(change.id, { status: 'failed', last_error: 'Checkout payment failed.' });
 return res.status(402).json(await createPlanFallbackCheckout(user, target, getRequestBaseUrl(req), promo));
 }
 return res.status(202).json({ success: true, paymentPending: true, paymentId });
 } catch (error) {
 return res.status(500).json({ error: error.message || 'Failed to verify plan payment.' });
 }
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
 const targetPlanId = payment.plan?.id || payment.metadata?.plan_id;
 const planChange = resolvePaymentPlanChange(user, payment);
 const isPlanChange = ['plan_change', 'plan_change_checkout'].includes(String(payment.metadata?.purpose || ''))
 && planChange && String(planChange.target_plan_id) === String(targetPlanId || '');
 const refreshed = isPlanChange
 ? await applyVerifiedPlanPayment(user, payment, planChange)
 : await persistWhopPayment(user, payment, { succeeded: true, force: true });
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

 const access = getUserAccessState(user);
 return res.json({
 plan: access.effectivePlan,
 inboxesUsed: user.inboxes_used || 0,
 inboxesLimit: user.inboxes_limit || 0,
 hasConcurrentOrders: access.hasConcurrentOrders,
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
 const eventAt = event.created_at || event.occurred_at || data.updated_at || data.created_at || null;

 switch (event.type) {
 case 'membership.activated':
 case 'membership.cancel_at_period_end_changed':
 if (user) await persistWhopMembership(user, data, { eventAt });
 break;

 case 'membership.deactivated':
 if (user) {
 const latest = await persistWhopMembership(user, data, { eventAt });
 const change = getActiveWhopPlanChange(user.id);
 if (change?.status === 'scheduled'
 && String(change.source_membership_id || '') === String(data.id || '')
 && String(data.id || '') === String(user.whop_membership_id || '')) {
 try {
 await chargePendingDowngrade(getUserById(user.id) || latest, change);
 } catch (error) {
 updateUserBillingById(user.id, { whop_last_payment_status: 'failed' });
 console.error('[whop-webhook] Scheduled downgrade charge failed:', error.message);
 }
 }
 }
 break;

 case 'payment.succeeded':
 if (user) {
 const targetPlanId = data.plan?.id || data.metadata?.plan_id;
 const latestUser = getUserById(user.id) || user;
 const change = resolvePaymentPlanChange(latestUser, data);
 if (change && String(change.target_plan_id) === String(targetPlanId || '')
 && ['plan_change', 'plan_change_checkout'].includes(String(data.metadata?.purpose || ''))) {
 await applyVerifiedPlanPayment(latestUser, data, change);
 } else {
 await persistWhopPayment(latestUser, data, { succeeded: true, eventAt });
 }
 }
 break;

 case 'payment.failed':
 if (user) {
 if (['plan_change', 'plan_change_checkout'].includes(String(data.metadata?.purpose || ''))) {
 const change = resolvePaymentPlanChange(user, data);
 if (change && change.status !== 'completed') {
 bindWhopPlanChangePayment(change.id, data.id);
 updateWhopPlanChange(change.id, { status: 'failed', last_error: 'Whop reported that the plan payment failed.' });
 const target = getWhopCatalogPlan(change.target_plan_id);
 if (target) await createPlanFallbackCheckout(getUserById(user.id) || user, target,
 process.env.APP_BASE_URL || 'https://app.unlimitedinboxes.com', null, change);
 }
 updateUserBillingById(user.id, { whop_last_payment_status: 'failed' });
 } else {
 await persistWhopPayment(user, data, { succeeded: false, eventAt });
 }
 }
 break;

 case 'setup_intent.succeeded':
 if (user) {
 if (!isWhopEventNewer(eventAt, user.whop_payment_event_at)) break;
 updateUserBillingById(user.id, {
 whop_member_id: data.member?.id ? String(data.member.id) : undefined,
 whop_payment_method_id: data.payment_method?.id ? String(data.payment_method.id) : undefined,
 whop_last_payment_status: 'active',
 whop_payment_event_at: getWhopEventTime(eventAt) || undefined,
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
 hasConcurrentOrders: access.hasConcurrentOrders,
 plans: serializePlansForUser(user),
 currentPlan: access.canAccessApp ? (access.isTrialing ? 'trial' : access.effectivePlan) : 'free',
 pendingPlan: getWhopCatalogPlan(user.whop_pending_plan_id)?.key || null,
 trialConsumed: access.introOfferUsed,
 };
}

// Kept for callers and tests written against the legacy export name.
export const serializeXpayBillingState = serializeBillingState;

export { autoSetupBilling };
export default router;
