import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import api from '../lib/api';
import { useAuth } from './AuthContext';

const BillingContext = createContext(null);
const REVIEW_URL = 'https://unlimitedinboxes.com/freeinboxes';

function redirectToBilling(intent, { replace = false } = {}) {
 const url = `/billing?intent=${intent}`;
 if (typeof window !== 'undefined') {
 if (replace) {
 window.location.replace(url);
 return;
 }
 window.location.assign(url);
 return;
 }

 return url;
}

function buildBlockingCheckout(billing) {
 if (!billing?.blockingReason) {
 return null;
 }

 if (billing.blockingReason === 'needs_payment_method' || billing.blockingReason === 'needs_intro_offer') {
 return {
 intent: 'starter',
 allowClose: false,
 headline: 'No Active Subscription Found',
 subheadline: 'Create The First 100 Inboxes For Just One Dollar.',
 description: null,
 showInvoice: false
 };
 }

 if (
 billing.blockingReason === 'subscription_past_due' ||
 billing.blockingReason === 'subscription_incomplete'
 ) {
 return {
 intent: 'retry',
 allowClose: false,
 headline: 'Payment Issue',
 subheadline: 'Your payment could not be processed. Please update your payment method to restore access.',
 description: null,
 showInvoice: true
 };
 }

 if (billing.blockingReason === 'subscription_cancelled') {
 return {
 intent: 'standard',
 allowClose: false,
 headline: 'Subscription Cancelled',
 subheadline: 'Your subscription has been cancelled. Renew to restore access.',
 description: null
 };
 }

 if (billing.blockingReason === 'inbox_limit_reached') {
 return {
 intent: 'standard',
 allowClose: false,
 headline: 'Inbox Limit Reached',
 subheadline: 'You have used all available inboxes. Upgrade to continue.',
 description: null
 };
 }

 return {
 intent: 'standard',
 allowClose: false,
 headline: 'No Active Subscription Found',
 subheadline: 'Upgrade To Continue',
 description: null
 };
}

function buildUpgradeCheckout(intent) {
 if (intent === 'trial' || intent === 'starter') {
 return {
 intent: 'starter',
 allowClose: true,
 headline: 'No Active Subscription Found',
 subheadline: 'Create The First 100 Inboxes For Just One Dollar.',
 description: null
 };
 }

 if (intent === 'retry') {
 return {
 intent: 'retry',
 allowClose: false,
 headline: 'Payment Issue',
 subheadline: 'Your payment could not be processed. Please update your payment method to restore access.',
 description: null,
 showInvoice: true
 };
 }

 if (intent === 'unlimited') {
 return {
 intent: 'unlimited',
 allowClose: true,
 headline: 'Upgrade To Unlimited',
 subheadline: 'Unlock Unlimited Parallel Order Processing',
 description: null
 };
 }

 if (intent === 'concurrent') {
 return {
 intent: 'concurrent',
 allowClose: true,
 headline: 'Add Multiple Order Processing',
 subheadline: 'Run multiple orders simultaneously for $29/month',
 description: null
 };
 }

 return {
 intent: 'standard',
 allowClose: true,
 headline: 'Upgrade And Get Limitless Access',
 subheadline: 'Unlock Full Downloads And Paid Access',
 description: null
 };
}

export function BillingProvider({ children }) {
 const location = useLocation();
 const { user } = useAuth();
 const [billing, setBilling] = useState(null);
 const [loading, setLoading] = useState(true);
 const refreshState = useRef({
 userId: null,
 inFlight: null,
 lastCompletedAt: 0,
 lastResult: null
 });

 const refreshBilling = async (options = {}) => {
 const { force = false, minIntervalMs = 5000 } = options;

 if (!user?.id) {
 setBilling(null);
 setLoading(false);
 refreshState.current = {
 userId: null,
 inFlight: null,
 lastCompletedAt: 0,
 lastResult: null
 };
 return null;
 }

 if (refreshState.current.userId !== user.id) {
 refreshState.current = {
 userId: user.id,
 inFlight: null,
 lastCompletedAt: 0,
 lastResult: null
 };
 }

 if (!force && refreshState.current.inFlight) {
 return refreshState.current.inFlight;
 }

 if (
 !force &&
 refreshState.current.lastCompletedAt > 0 &&
 Date.now() - refreshState.current.lastCompletedAt < minIntervalMs
 ) {
 return refreshState.current.lastResult;
 }

 setLoading(true);
 const request = api.get('/billing/status')
 .then((res) => {
 setBilling(res.data);
 refreshState.current.lastResult = res.data;
 return res.data;
 })
 .catch((error) => {
 if (refreshState.current.lastResult) {
 return refreshState.current.lastResult;
 }
 throw error;
 })
 .finally(() => {
 refreshState.current.inFlight = null;
 refreshState.current.lastCompletedAt = Date.now();
 setLoading(false);
 });

 refreshState.current.inFlight = request;
 return request;
 };

 useEffect(() => {
 void refreshBilling({ force: true, minIntervalMs: 0 });
 }, [user?.id]);

 const openUpgrade = (intent = 'standard') => {
 const checkout = buildUpgradeCheckout(intent);
 redirectToBilling(checkout.intent);
 };

 const openBillingPortal = async () => {
 if (billing?.isPastDue) {
 redirectToBilling('retry');
 return;
 }

 if (billing?.billingMode === 'managed' && billing?.recurringEnabled) {
 const accessEnd = billing.currentPeriodEnd || billing.trialEndsAt;
 const suffix = accessEnd
 ? ` Access continues until ${new Date(accessEnd).toLocaleDateString()}.`
 : '';
 if (!window.confirm(`Cancel automatic renewal? No further recurring charges will be made.${suffix}`)) {
 return;
 }
 await api.post('/billing/cancel');
 await refreshBilling({ force: true, minIntervalMs: 0 });
 return;
 }

 window.alert('Billing portal is not available. Please visit the billing page to manage your subscription.');
 };

 const value = {
 billing,
 loading,
 reviewUrl: REVIEW_URL,
 refreshBilling,
 openUpgrade,
 openBillingPortal
 };

 const blockingCheckout = buildBlockingCheckout(billing);

 useEffect(() => {
 if (!user?.id || !blockingCheckout) {
 return;
 }

 if (location.pathname === '/billing') {
 return;
 }

 if (blockingCheckout.intent === 'retry') {
 return;
 }

 redirectToBilling(blockingCheckout.intent, { replace: true });
 }, [user?.id, billing?.isTrialing, billing?.plan, billing?.blockingReason, blockingCheckout?.intent, location.pathname]);

 return (
 <BillingContext.Provider value={value}>
 {children}
 </BillingContext.Provider>
 );
}

export function useBilling() {
 const ctx = useContext(BillingContext);
 if (!ctx) {
 throw new Error('useBilling must be used within BillingProvider');
 }
 return ctx;
}
