import { createContext, useContext, useEffect, useRef, useState } from 'react';
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

function buildUpgradeCheckout(intent) {
 if (intent === 'trial' || intent === 'starter') {
 return {
 intent: 'starter',
 allowClose: true,
 headline: 'No Active Subscription Found',
 subheadline: 'Create 100 inboxes and send 15,000 cold emails for just $1.',
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
 intent: 'starter',
 allowClose: true,
 headline: 'No Active Subscription Found',
 subheadline: 'Create 100 inboxes and send 15,000 cold emails for just $1.',
 description: '$9.99 will be charged after the five-day free trial. Cancel anytime in one click.'
 };
}

export function BillingProvider({ children }) {
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

 if (billing?.provider === 'whop' && billing?.membershipId) {
 const accessEnd = billing.currentPeriodEnd;
 const suffix = accessEnd
 ? ` Access continues until ${new Date(accessEnd).toLocaleDateString()}.`
 : '';
 if (!window.confirm(`Cancel automatic renewal?${suffix}`)) {
 return;
 }
 await api.post('/billing/cancel');
 await refreshBilling({ force: true, minIntervalMs: 0 });
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
