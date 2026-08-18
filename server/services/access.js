import { isSubscriptionPastDue } from '../services/xpay.js';
import { getWhopPlanDetails, getWhopStatus, isWhopMembershipActive } from './whop.js';

const PLAN_LIMITS = {
 free: { inboxesLimit: 0, concurrentOrders: 0 },
 trial: { inboxesLimit: 100, concurrentOrders: 1 },
 basic: { inboxesLimit: 100, concurrentOrders: 1 },
 starter: { inboxesLimit: 500, concurrentOrders: 1 },
 growth: { inboxesLimit: 1500, concurrentOrders: 1 },
 unlimited: { inboxesLimit: Infinity, concurrentOrders: 1 },
 agency: { inboxesLimit: Infinity, concurrentOrders: Infinity },
};

function getPlanKey(user) {
 const whopStatus = getWhopStatus(user?.whop_membership_status);
 const whopDetails = getWhopPlanDetails(user?.whop_plan_id);
 if (whopDetails && isWhopMembershipActive(whopStatus)) {
  if (whopDetails.intro && (whopStatus === 'trialing' || (whopStatus === 'canceling' && user?.plan === 'trial'))) {
   return 'trial';
  }
  return whopDetails.key;
 }

 const status = (user?.xpay_subscription_status || '').toUpperCase();
 if (['TRIALING', 'TRIAL'].includes(status)) return 'trial';

 const subPlan = user?.xpay_subscription_plan;
 if (subPlan && PLAN_LIMITS[subPlan]) return subPlan;

 const stored = user?.plan;
 if (stored && PLAN_LIMITS[stored]) return stored;

 return 'free';
}

function getPlanLimits(user) {
 const planKey = getPlanKey(user);
 return PLAN_LIMITS[planKey] || PLAN_LIMITS.free || { inboxesLimit: 0, concurrentOrders: 0 };
}

export function isOnTrial(user) {
 const whopStatus = getWhopStatus(user?.whop_membership_status);
 if (getWhopPlanDetails(user?.whop_plan_id)?.intro
 && (whopStatus === 'trialing' || (whopStatus === 'canceling' && user?.plan === 'trial'))) {
  const trialEnd = user?.whop_current_period_end ? new Date(user.whop_current_period_end) : null;
  return !trialEnd || trialEnd > new Date();
 }
 const status = (user?.xpay_subscription_status || '').toUpperCase();
 if (!['TRIALING', 'TRIAL'].includes(status)) return false;

 const trialEnd = user?.xpay_trial_ends_at ? new Date(user.xpay_trial_ends_at) : null;
 return trialEnd ? trialEnd > new Date() : false;
}

export function getSubscriptionTier(user) {
 const planKey = getPlanKey(user);
 if (planKey === 'agency') return 'agency';
 if (planKey === 'unlimited') return 'unlimited';
 if (planKey === 'growth') return 'growth';
 if (planKey === 'starter') return 'starter';
 if (planKey === 'basic') return 'basic';
 if (isOnTrial(user)) return 'trial';
 return 'free';
}

export function hasUsedIntroOffer(user) {
 return Boolean(
 user?.xpay_intro_offer_used
 || user?.whop_intro_offer_used
 || user?.xpay_subscription_id
 || ['trial', 'basic', 'starter', 'growth', 'unlimited', 'agency'].includes(user?.plan)
 );
}

export function getUserAccessState(user) {
 const planKey = getPlanKey(user);
 const limits = getPlanLimits(user);
 const inboxesUsed = user?.inboxes_used || 0;
 const inboxesLimit = limits.inboxesLimit;
 // Unlimited simultaneous orders are a Reseller entitlement. Deriving this from
 // the active plan prevents a stale flag from leaking the entitlement to Scale.
 const hasConcurrentOrders = planKey === 'agency';

 const usesWhop = Boolean(user?.whop_membership_id || user?.whop_membership_status);
 const whopStatus = getWhopStatus(user?.whop_membership_status);
 const subscriptionStatus = usesWhop
 ? whopStatus.toUpperCase()
 : (user?.xpay_subscription_status || '').toUpperCase();
 const isPastDue = usesWhop
 ? ['past_due', 'unresolved'].includes(whopStatus)
 : isSubscriptionPastDue(subscriptionStatus);
 const trialing = isOnTrial(user);
 const currentPeriodEnd = usesWhop ? user?.whop_current_period_end : user?.xpay_current_period_end;
 const periodEnd = currentPeriodEnd ? new Date(currentPeriodEnd) : null;
 const cancelledAtPeriodEnd = Boolean(usesWhop ? user?.whop_cancel_at_period_end : user?.xpay_cancel_at_period_end);
 const whopPaidPeriodActive = whopStatus === 'active'
 ? (!cancelledAtPeriodEnd || (periodEnd && periodEnd > new Date()))
 : (whopStatus === 'canceling' && (!periodEnd || periodEnd > new Date()) && !trialing);
 const paidPeriodActive = usesWhop
 ? whopPaidPeriodActive
 : subscriptionStatus === 'ACTIVE'
 && (!cancelledAtPeriodEnd || (periodEnd && periodEnd > new Date()));
 const isActive = paidPeriodActive || trialing;

 const inboxesAvailable = inboxesLimit === Infinity
 ? Infinity
 : Math.max(0, inboxesLimit - inboxesUsed);
 const canCreateInbox = inboxesLimit === Infinity || inboxesUsed < inboxesLimit;
 const canAccessApp = isActive;

 const usedIntroOffer = hasUsedIntroOffer(user);
 const needsIntroOffer = !canAccessApp && !usedIntroOffer;
 const needsPaidSubscription = !canAccessApp && usedIntroOffer && !isPastDue;

 const blockingReason = isPastDue
 ? 'payment_overdue'
 : (cancelledAtPeriodEnd && !canAccessApp
 ? 'subscription_cancelled'
 : (needsIntroOffer ? 'needs_intro_offer' : (!canAccessApp ? 'needs_paid_subscription' : null)));

 const recommendedCheckoutIntent = isPastDue
 ? 'retry'
 : (needsIntroOffer ? 'intro' : (!canAccessApp ? 'standard' : null));

 return {
 effectivePlan: planKey,
 storedPlan: planKey,
 inboxesUsed,
 inboxesLimit,
 inboxesAvailable,
 canCreateInbox,
 hasConcurrentOrders,
 maxConcurrentOrders: hasConcurrentOrders ? Infinity : limits.concurrentOrders,
 isActive,
 isTrialing: trialing,
 isPastDue,
 subscriptionStatus: usesWhop ? (user?.whop_membership_status || null) : (user?.xpay_subscription_status || null),
 subscriptionTier: getSubscriptionTier(user),
 trialActive: trialing,
 trialEndsAt: usesWhop ? (trialing ? user?.whop_current_period_end || null : null) : (user?.xpay_trial_ends_at || null),
 introOfferUsed: usedIntroOffer,
 needsIntroOffer,
 needsPaidSubscription,
 needsPaymentMethodUpdate: isPastDue,
 blockingReason,
 recommendedCheckoutIntent,
 isFullyPaid: ['basic', 'starter', 'growth', 'unlimited', 'agency'].includes(planKey) && isActive && !trialing,
 hasBillingPortal: Boolean(user?.whop_membership_id || user?.xpay_customer_id),
 cleanupDueAt: null,
 hasBillingIssue: isPastDue,
 cancelAtPeriodEnd: cancelledAtPeriodEnd,
 currentPeriodEnd: currentPeriodEnd || null,
 canAccessApp,
 canAccessApi: ['basic', 'starter', 'growth', 'unlimited', 'agency'].includes(planKey),
 canAccessMcp: ['basic', 'starter', 'growth', 'unlimited', 'agency'].includes(planKey),
 hasUnlimitedOrders: planKey === 'agency',
 canDownloadAll: canAccessApp && !trialing,
 canCreateMoreThanOneCompletedOrder: ['basic', 'starter', 'growth', 'unlimited', 'agency'].includes(planKey),
 canUseCustomNames: ['basic', 'starter', 'growth', 'unlimited', 'agency'].includes(planKey),
 canUseDomainRedirects: ['basic', 'starter', 'growth', 'unlimited', 'agency'].includes(planKey),
 downloadAllowance: !canAccessApp ? 0 : (trialing ? 10 : Infinity),
 canOpenInboxesPage: canAccessApp,
 lifetimeCompletedOrders: 0,
 completedOrderQuotaReached: false,
 };
}
