import { useEffect, useState } from 'react';
import api from '../lib/api';
import { useAuth } from '../context/AuthContext';

const STATUS_POLL_INTERVAL_MS = 1500;
const STATUS_POLL_ATTEMPTS = 20;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getReturnSession() {
  const params = new URLSearchParams(window.location.search);
  return params.get('billing') === 'success' ? params.get('session_id') : null;
}

function cleanUrl(intent) {
  const params = new URLSearchParams();
  if (intent) params.set('intent', intent);
  const query = params.toString();
  window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
}

function isSynced(status, intent) {
  if (!status) return false;
  if (intent === 'advanced') return Boolean(status.unlimitedConcurrency || status.plan === 'advanced');
  if (intent === 'standard') return status.plan === 'standard' || status.plan === 'advanced' || Boolean(status.isPaid);
  return Boolean(status.canAccessApp || status.isTrialing || status.isPaid);
}

async function pollBilling(intent, sessionId, onSynced, onError, cancelled) {
  for (let attempt = 0; attempt < STATUS_POLL_ATTEMPTS; attempt += 1) {
    if (cancelled.current) return;

    try {
      if (sessionId) await api.post('/billing/return', { sessionId }).catch(() => {});
      const res = await api.get('/billing/status');
      if (isSynced(res.data, intent)) {
        await onSynced?.(res.data);
        return;
      }
    } catch {
      // Keep polling while Stripe webhooks and the return endpoint converge.
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
      cleanUrl(intent);
      await pollBilling(intent, sessionId, onSynced, onError, cancelled);
    }

    async function redirectToHostedCheckout() {
      try {
        setError('');
        setMessage('Redirecting to Stripe...');
        const res = await api.post('/billing/checkout', { intent });
        const checkoutUrl = res.data?.url || res.data?.checkoutUrl || res.data?.purchaseUrl;
        if (!checkoutUrl) throw new Error('No Stripe checkout URL returned.');
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
      if (typeof openBillingPortal === 'function') {
        void openBillingPortal();
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
