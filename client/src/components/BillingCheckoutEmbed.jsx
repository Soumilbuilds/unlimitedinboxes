import { useCallback, useEffect, useRef, useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, EmbeddedCheckout } from '@stripe/react-stripe-js';
import api from '../lib/api';
import { useAuth } from '../context/AuthContext';

const stripePromise = loadStripe(
  import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY ||
  'pk_live_51TXFGYAxRfptSO4wkESkYbJULJfUNAc6B2Y7p1Io5gFxMFy1i2qPuhXbs19YeHU5duPTEflZzn2P5m9aPkNZpSzX00jQnvph3v'
);

const STATUS_POLL_INTERVAL_MS = 1500;
const STATUS_POLL_ATTEMPTS = 20;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function isCheckoutSynced(status, intent) {
  if (!status) return false;
  if (intent === 'advanced') return Boolean(status.unlimitedConcurrency || status.plan === 'advanced');
  if (intent === 'standard') return status.plan === 'standard' || status.plan === 'advanced' || Boolean(status.isPaid);
  return Boolean(status.canAccessApp || status.isTrialing || status.isPaid);
}

async function syncBilling(intent, onSynced, onError, cancelled) {
  for (let i = 0; i < STATUS_POLL_ATTEMPTS; i++) {
    if (cancelled.current) return;
    try {
      await api.post('/billing/return').catch(() => {});
      const res = await api.get('/billing/status');
      if (isCheckoutSynced(res.data, intent)) {
        await onSynced?.(res.data);
        return;
      }
    } catch { /* continue */ }
    if (cancelled.current) return;
    await wait(STATUS_POLL_INTERVAL_MS);
  }
  onError?.('Payment processed. Refreshing access now...');
}

export default function BillingCheckoutEmbed({ intent = 'standard', onSynced, onError }) {
  const { user } = useAuth();
  const [clientSecret, setClientSecret] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusMsg, setStatusMsg] = useState('');
  const cancelled = useRef(false);

  // Fetch client secret on mount
  useEffect(() => {
    if (!user) return;
    cancelled.current = false;
    setLoading(true);
    setError('');

    api.post('/billing/checkout', { intent })
      .then((res) => {
        const cs = res.data?.clientSecret || res.data?.sessionId;
        if (!cs) throw new Error('No client secret returned.');
        setClientSecret(cs);
      })
      .catch((err) => {
        setError(err.response?.data?.error || 'Failed to load checkout.');
        onError?.(error, err);
      })
      .finally(() => setLoading(false));
  }, [user, intent]);

  // Handle return from Stripe
  useEffect(() => {
    if (!user || !clientSecret) return;
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session_id');
    const success = params.get('billing') === 'success';

    if (success && sessionId) {
      cancelled.current = false;
      setStatusMsg('Verifying payment...');
      syncBilling(intent, onSynced, (msg) => setError(msg), cancelled);
      const cleanUrl = window.location.pathname + (intent ? `?intent=${intent}` : '');
      window.history.replaceState({}, '', cleanUrl);
    }
  }, [user, clientSecret, intent, onSynced, onError]);

  const fetchClientSecret = useCallback(() => {
    return api.post('/billing/checkout', { intent })
      .then((res) => {
        const cs = res.data?.clientSecret || res.data?.sessionId;
        if (!cs) throw new Error('No client secret returned.');
        return cs;
      });
  }, [intent]);

  if (loading) {
    return (
      <div className="billing-page-loading" style={{ textAlign: 'center', padding: '40px 20px' }}>
        <div className="spinner" />
        <p style={{ color: '#888', marginTop: 12 }}>Loading secure checkout...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="billing-page-empty">
        <div className="alert error billing-page-alert">{error}</div>
      </div>
    );
  }

  if (!clientSecret) return null;

  const options = { fetchClientSecret };

  return (
    <div className="billing-page-embed-wrap">
      {statusMsg && (
        <div className="alert info billing-page-alert">
          <div className="spinner billing-inline-spinner" />
          <span>{statusMsg}</span>
        </div>
      )}
      <Elements stripe={stripePromise} options={options}>
        <EmbeddedCheckout
          onCheckoutComplete={() => {
            setStatusMsg('Payment successful! Syncing your access...');
            syncBilling(intent, onSynced, (msg) => setError(msg), cancelled);
          }}
        />
      </Elements>
    </div>
  );
}