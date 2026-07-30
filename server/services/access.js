import { isSubscriptionActive, isSubscriptionPastDue, TRIAL_DAYS } from '../services/xpay.js';

const PLAN_LIMITS = {
 free: { inboxesLimit: 0, concurrentOrders: 0 },
 trial: { inboxesLimit: 100, concurrentOrders: 1 },
 starter: { inboxesLimit: 500, concurrentOrders: 1 },
 growth: { inboxesLimit: 1500, concurrentOrders: 1 },
 unlimited: { inboxesLimit: Infinity, concurrentOrders: 1 },
};

function getPlanKey(user) {
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
 const status = (user?.xpay_subscription_status || '').toUpperCase();
 if (!['TRIALING', 'TRIAL'].includes(status)) return false;

 const trialEnd = user?.xpay_trial_ends_at ? new Date(user.xpay_trial_ends_at) : null;
 return trialEnd ? trialEnd > new Date() : false;
}

export function getSubscriptionTier(user) {
 const planKey = getPlanKey(user);
 if (planKey === 'unlimited') return 'unlimited';
 if (planKey === 'growth') return 'growth';
 if (planKey === 'starter') return 'starter';
 if (isOnTrial(user)) return 'trial';
 return 'free';
}

export function hasUsedIntroOffer(user) {
 return Boolean(
 user?.xpay_intro_offer_used
 || user?.xpay_subscription_id
 || ['trial', 'starter', 'growth', 'unlimited'].includes(user?.plan)
 );
}

export function getUserAccessState(user) {
 const planKey = getPlanKey(user);
 const limits = getPlanLimits(user);
 const inboxesUsed = user?.inboxes_used || 0;
 const inboxesLimit = limits.inboxesLimit;
 const hasConcurrentOrders = Boolean(user?.has_concurrent_orders);

 const subscriptionStatus = (user?.xpay_subscription_status || '').toUpperCase();
 const isActive = isSubscriptionActive(subscriptionStatus);
 const isPastDue = isSubscriptionPastDue(subscriptionStatus);
 const trialing = isOnTrial(user);

 const inboxesAvailable = inboxesLimit === Infinity
 ? Infinity
 : Math.max(0, inboxesLimit - inboxesUsed);
 const canCreateInbox = inboxesLimit === Infinity || inboxesUsed < inboxesLimit;
 const canAccessApp = isActive || trialing;

 const usedIntroOffer = hasUsedIntroOffer(user);
 const needsIntroOffer = !canAccessApp && !usedIntroOffer;
 const needsPaidSubscription = !canAccessApp && usedIntroOffer && !isPastDue;

 const blockingReason = isPastDue
 ? 'payment_overdue'
 : (needsIntroOffer ? 'needs_intro_offer' : (!canAccessApp ? 'needs_paid_subscription' : null));

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
 subscriptionStatus: user?.xpay_subscription_status || null,
 subscriptionTier: getSubscriptionTier(user),
 trialActive: trialing,
 trialEndsAt: user?.xpay_trial_ends_at || null,
 introOfferUsed: usedIntroOffer,
 needsIntroOffer,
 needsPaidSubscription,
 needsPaymentMethodUpdate: isPastDue,
 blockingReason,
 recommendedCheckoutIntent,
 isFullyPaid: ['starter', 'growth', 'unlimited'].includes(planKey) && isActive,
 hasBillingPortal: Boolean(user?.xpay_customer_id),
 cleanupDueAt: null,
 hasBillingIssue: isPastDue,
 canAccessApp,
 canAccessApi: ['growth', 'unlimited'].includes(planKey),
 hasUnlimitedOrders: planKey === 'unlimited',
 canDownloadAll: canAccessApp,
 };
}
