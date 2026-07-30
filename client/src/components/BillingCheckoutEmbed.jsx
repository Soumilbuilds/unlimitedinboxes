import { useEffect, useState } from 'react';
import api from '../lib/api';
import { useAuth } from '../context/AuthContext';

const STATUS_POLL_INTERVAL_MS = 1500;
const STATUS_POLL_ATTEMPTS = 20;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getReturnSession() {
 const params = new URLSearchParams(window.location.search);
 const sessionId = params.get('xpay_intent_id')
 || params.get('xIntentId')
 || params.get('x_intent_id')
 || params.get('intentId')
 || params.get('subscriptionId')
 || params.get('subscription_id')
 || params.get('session_id')
 || params.get('setup_method_id');
 if (sessionId) return sessionId;
 if (params.get('billing') === 'subscription-success') return '__stored_subscription__';
 return params.get('billing') === 'success' ? '__stored_checkout__' : null;
}

function isSynced(status, intent) {
 if (!status) return false;
 if (intent === 'advanced') return Boolean(status.plan === 'unlimited');
 if (intent === 'standard') return status.plan === 'starter' || status.plan === 'growth' || status.plan === 'unlimited' || Boolean(status.isActive);
 return Boolean(status.canAccessApp || status.isTrialing || status.isActive);
}

async function pollBilling(intent, sessionId, onSynced, onError, cancelled) {
 for (let attempt = 0; attempt < STATUS_POLL_ATTEMPTS; attempt += 1) {
 if (cancelled.current) return;

 try {
 if (sessionId) {
 const returnResponse = await api.post('/billing/return', { sessionId });
 if (returnResponse.data?.redirectUrl) {
 window.location.assign(returnResponse.data.redirectUrl);
 return;
 }
 }
 const res = await api.get('/billing/status');
 if (isSynced(res.data, intent)) {
 await onSynced?.(res.data);
 return;
 }
 } catch {
 // Keep polling while payment status updates.
 }

 await wait(STATUS_POLL_INTERVAL_MS);
 }

 if (!cancelled.current) {
 onError?.('Payment processed. Refreshing access now...');
 }
}

export default function BillingCheckoutEmbed({ intent = 'standard', onSynced, onError, openBillingPortal }) {
 const { user } = useAuth();
 const [error, setError] = useState('');
 const [message, setMessage] = useState('Preparing secure checkout...');

 useEffect(() => {
 if (!user) return undefined;

 const cancelled = { current: false };
 const sessionId = getReturnSession();

 async function finalizeReturn() {
 setError('');
 setMessage('Finalizing payment...');
 await pollBilling(intent, sessionId, onSynced, onError, cancelled);
 }

 async function redirectToHostedCheckout() {
 try {
 setError('');
 setMessage('Setting up payment...');
 const res = await api.post('/billing/checkout', { intent });
 const checkoutUrl = res.data?.redirectUrl || res.data?.url || res.data?.checkoutUrl || res.data?.purchaseUrl;
 if (!checkoutUrl) throw new Error('No checkout URL returned.');
 window.location.assign(checkoutUrl);
 } catch (err) {
 if (cancelled.current) return;
 const nextError = err?.response?.data?.error || err.message || 'Failed to open checkout.';
 setError(nextError);
 setMessage('');
 onError?.(nextError, err);
 }
 }

 if (sessionId) {
 void finalizeReturn();
 } else if (intent === 'retry') {
 setError('');
 setMessage('');
 if (typeof onError === 'function') {
 onError('Please update your payment method to continue.', null);
 }
 } else {
 void redirectToHostedCheckout();
 }

 return () => {
 cancelled.current = true;
 };
 }, [user?.id, intent]);

 if (!user) return null;

 if (error) {
 return (
 <div className="billing-page-empty">
 <div className="alert error billing-page-alert">{error}</div>
 </div>
 );
 }

 return (
 <div className="billing-page-loading">
 <div className="spinner" />
 <p>{message}</p>
 </div>
 );
}
