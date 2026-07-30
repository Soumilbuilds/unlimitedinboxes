import { useEffect, useRef, useState } from 'react';
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
 || params.get('session_id');
 if (sessionId) return sessionId;
 return params.get('billing') === 'success' ? '__stored_checkout__' : null;
}

function isSynced(status) {
 return Boolean(status?.canAccessApp || status?.isTrialing || status?.isActive);
}

export default function BillingCheckoutEmbed({ onSynced, onError }) {
 const { user } = useAuth();
 const [error, setError] = useState('');
 const [message, setMessage] = useState('Checking your billing status...');
 const [ready, setReady] = useState(false);
 const [submitting, setSubmitting] = useState(false);
 const returnedFromXpay = useRef(Boolean(getReturnSession()));
 const cancelled = useRef(false);

 async function syncStatus() {
 const statusResponse = await api.get('/billing/status');
 if (isSynced(statusResponse.data)) {
 await onSynced?.(statusResponse.data);
 return true;
 }
 return false;
 }

 async function finalizeReturn(sessionId) {
 setError('');
 setReady(false);
 setMessage('Confirming your $1 payment...');

 for (let attempt = 0; attempt < STATUS_POLL_ATTEMPTS; attempt += 1) {
 if (cancelled.current) return;
 try {
 await api.post('/billing/return', { sessionId });
 if (await syncStatus()) return;
 } catch (requestError) {
 const status = requestError?.response?.status;
 if (status && status !== 409 && status < 500) {
 const detail = requestError?.response?.data?.error || requestError.message;
 setError(detail);
 onError?.(detail, requestError);
 return;
 }
 }
 await wait(STATUS_POLL_INTERVAL_MS);
 }

 if (!cancelled.current) {
 setMessage('');
 setError('We received your return and are still confirming the payment. Do not pay again.');
 }
 }

 useEffect(() => {
 if (!user) return undefined;
 cancelled.current = false;
 const sessionId = getReturnSession();

 if (sessionId) {
 void finalizeReturn(sessionId);
 } else {
 void syncStatus()
 .then((synced) => {
 if (!synced && !cancelled.current) {
 setMessage('');
 setReady(true);
 }
 })
 .catch((requestError) => {
 if (cancelled.current) return;
 const detail = requestError?.response?.data?.error || requestError.message || 'Could not load billing status.';
 setError(detail);
 setMessage('');
 onError?.(detail, requestError);
 });
 }

 return () => {
 cancelled.current = true;
 };
 }, [user?.id]);

 async function openCheckout() {
 if (submitting) return;
 setSubmitting(true);
 setError('');
 try {
 const response = await api.post('/billing/checkout', { intent: 'starter' });
 const checkoutUrl = response.data?.redirectUrl;
 if (!checkoutUrl) throw new Error('No checkout URL returned.');
 window.location.assign(checkoutUrl);
 } catch (requestError) {
 if (requestError?.response?.status === 409) {
 const synced = await syncStatus().catch(() => false);
 if (synced) return;
 }
 const detail = requestError?.response?.data?.error || requestError.message || 'Failed to open checkout.';
 setError(detail);
 onError?.(detail, requestError);
 setSubmitting(false);
 }
 }

 async function checkReturnedPayment() {
 const sessionId = getReturnSession() || '__stored_checkout__';
 await finalizeReturn(sessionId);
 }

 if (!user) return null;

 if (error) {
 return (
 <div className="billing-page-empty">
 <div className="alert error billing-page-alert">{error}</div>
 {returnedFromXpay.current ? (
 <button className="btn primary" type="button" onClick={() => void checkReturnedPayment()}>
 Check payment status
 </button>
 ) : null}
 </div>
 );
 }

 if (ready) {
 return (
 <div className="billing-page-empty">
 <p>
 $1 today for your first 100 inboxes. After 7 days, your saved card will be charged
 {' '}$49.99, then $49.99 every 4 weeks until cancelled.
 </p>
 <button
 className="btn primary"
 type="button"
 disabled={submitting}
 onClick={() => void openCheckout()}
 >
 {submitting ? 'Opening secure checkout...' : 'Pay $1 & start 7-day trial'}
 </button>
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
