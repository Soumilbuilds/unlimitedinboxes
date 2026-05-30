const INTRO_DOWNLOAD_LIMIT = 10;
const MANUAL_PLAN_LIMITS = new Map([
  ['25', 25],
  ['50', 50],
  ['100', 100]
]);

function normalize(value) {
  return String(value || '').trim();
}

function normalizeLower(value) {
  return normalize(value).toLowerCase();
}

function matchesProduct(productId, ...envKeys) {
  const normalized = normalize(productId);
  if (!normalized) return false;
  return envKeys.some((key) => normalize(process.env[key]) === normalized);
}

export function getSubscriptionTierFromProduct(productId) {
  if (matchesProduct(productId, 'STRIPE_PRICE_RESELLER')) {
    return 'reseller';
  }
  if (matchesProduct(productId, 'STRIPE_PRICE_PER_ORDER')) {
    return 'perOrder';
  }
  if (matchesProduct(productId, 'STRIPE_PRICE_ADVANCED')) {
    return 'advanced';
  }
  if (matchesProduct(productId, 'STRIPE_PRICE_STANDARD')) {
    return 'standard';
  }
  return null;
}

export function isManualAllowancePlan(plan) {
  return MANUAL_PLAN_LIMITS.has(normalize(plan));
}

export function getManualAllowance(plan) {
  return MANUAL_PLAN_LIMITS.get(normalize(plan)) || 0;
}

export function isPaidSubscriptionStatus(status) {
  return normalizeLower(status) === 'active';
}

export function isPaymentMethodUpdateStatus(status) {
  return normalizeLower(status) === 'on_hold';
}

function isBillingIssueStatus(status) {
  return ['past_due', 'unpaid', 'incomplete'].includes(normalizeLower(status));
}

function getStripeState(user) {
  const subStatus = normalizeLower(user?.stripe_subscription_status);
  const product = normalize(user?.stripe_product);

  const isActive = subStatus === 'active' || subStatus === 'trialing';
  const trialActive = subStatus === 'trialing';
  const hasBillingIssue = isBillingIssueStatus(subStatus);

  let paidTier = null;
  if (isActive && !trialActive) {
    if (product === 'reseller') paidTier = 'reseller';
    else if (product === 'perOrder') paidTier = 'perOrder';
    else if (product === 'advanced') paidTier = 'advanced';
    else if (product === 'standard' || product === 'intro') paidTier = 'standard';
  }

  const introOfferUsed = Boolean(
    user?.stripe_intro_offer_used
    || user?.stripe_subscription_id
    || user?.whop_membership_id
    || user?.whop_plan_id
  );

  return {
    trialActive,
    paidTier,
    hasBillingIssue,
    membershipStatus: subStatus,
    introOfferUsed,
    hasBillingPortal: !!user?.stripe_customer_id,
    isPastDue: hasBillingIssue,
  };
}

export function hasUsedIntroOffer(user) {
  return Boolean(
    user?.stripe_intro_offer_used
    || user?.stripe_subscription_id
    || user?.whop_membership_id
    || user?.whop_plan_id
  );
}

export function getUserAccessState(user) {
  const storedPlan = normalizeLower(user?.plan || 'free');
  const manualAllowance = getManualAllowance(storedPlan);
  const lifetimeCompletedOrders = Math.max(Number(user?.lifetime_completed_orders || 0), 0);

  const stripeState = getStripeState(user);

  const paidTier = stripeState.paidTier;
  const activeTrial = stripeState.trialActive;

  let effectivePlan = 'free';
  let downloadAllowance = 0;
  let maxConcurrentOrders = 0;
  let canAccessApp = false;
  let canUseCustomNames = false;
  let canCreateMoreThanOneCompletedOrder = false;
  let canDownloadAll = false;
  let canAccessApi = false;
  let hasUnlimitedOrders = false;

  if (paidTier === 'advanced') {
    effectivePlan = 'advanced';
    downloadAllowance = Number.POSITIVE_INFINITY;
    maxConcurrentOrders = Number.POSITIVE_INFINITY;
    canAccessApp = true;
    canUseCustomNames = true;
    canCreateMoreThanOneCompletedOrder = true;
    canDownloadAll = true;
  } else if (paidTier === 'standard') {
    effectivePlan = 'standard';
    downloadAllowance = Number.POSITIVE_INFINITY;
    maxConcurrentOrders = 1;
    canAccessApp = true;
    canUseCustomNames = true;
    canCreateMoreThanOneCompletedOrder = true;
    canDownloadAll = true;
  } else if (paidTier === 'reseller') {
    effectivePlan = 'reseller';
    downloadAllowance = Number.POSITIVE_INFINITY;
    maxConcurrentOrders = Number.POSITIVE_INFINITY;
    canAccessApp = true;
    canUseCustomNames = true;
    canCreateMoreThanOneCompletedOrder = true;
    canDownloadAll = true;
    canAccessApi = true;
    hasUnlimitedOrders = true;
  } else if (paidTier === 'perOrder') {
    effectivePlan = 'perOrder';
    downloadAllowance = Number.POSITIVE_INFINITY;
    maxConcurrentOrders = Number.POSITIVE_INFINITY;
    canAccessApp = true;
    canUseCustomNames = true;
    canCreateMoreThanOneCompletedOrder = true;
    canDownloadAll = true;
    canAccessApi = true;
    hasUnlimitedOrders = true;
  } else if (manualAllowance > 0) {
    effectivePlan = storedPlan;
    downloadAllowance = manualAllowance;
    maxConcurrentOrders = 1;
    canAccessApp = true;
    canDownloadAll = manualAllowance >= 100;
  } else if (activeTrial) {
    effectivePlan = 'intro';
    downloadAllowance = INTRO_DOWNLOAD_LIMIT;
    maxConcurrentOrders = 1;
    canAccessApp = true;
  }

  const usedIntroOffer = hasUsedIntroOffer(user);
  const needsIntroOffer = !canAccessApp && !usedIntroOffer;
  const needsPaidSubscription = !canAccessApp && usedIntroOffer && !stripeState.isPastDue;
  const blockingReason = stripeState.isPastDue
    ? 'payment_overdue'
    : (needsIntroOffer ? 'needs_intro_offer' : (!canAccessApp ? 'needs_paid_subscription' : null));
  const recommendedCheckoutIntent = stripeState.isPastDue
    ? 'retry'
    : (needsIntroOffer ? 'intro' : (!canAccessApp ? 'standard' : null));
  const completedOrderQuotaReached =
    !canCreateMoreThanOneCompletedOrder
    && lifetimeCompletedOrders >= 1;

  return {
    effectivePlan,
    storedPlan,
    downloadAllowance,
    canAccessApp,
    canUseCustomNames,
    canCreateMoreThanOneCompletedOrder,
    completedOrderQuotaReached,
    canDownloadAll,
    canOpenInboxesPage: downloadAllowance > 0,
    maxConcurrentOrders,
    lifetimeCompletedOrders,
    trialActive: activeTrial,
    introOfferUsed: usedIntroOffer,
    subscriptionStatus: stripeState.membershipStatus || null,
    subscriptionTier: paidTier,
    needsIntroOffer,
    needsPaidSubscription,
    needsPaymentMethodUpdate: stripeState.isPastDue,
    blockingReason,
    recommendedCheckoutIntent,
    isFullyPaid: paidTier === 'standard' || paidTier === 'advanced' || paidTier === 'reseller' || paidTier === 'perOrder',
    hasBillingPortal: stripeState.hasBillingPortal,
    cleanupDueAt: null,
    hasBillingIssue: stripeState.isPastDue,
    canAccessApi: paidTier === 'reseller' || paidTier === 'perOrder',
    hasUnlimitedOrders: paidTier === 'reseller' || paidTier === 'perOrder',
  };
}
