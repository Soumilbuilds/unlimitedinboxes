import { useCallback, useEffect, useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { CheckoutElementsProvider, PaymentElement, useCheckoutElements } from '@stripe/react-stripe-js/checkout';
import api from '../lib/api';
import { useAuth } from '../context/AuthContext';

const stripePublishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY;
const stripePromise = stripePublishableKey ? loadStripe(stripePublishableKey) : Promise.resolve(null);

const STATUS_POLL_INTERVAL_MS = 1500;
const STATUS_POLL_ATTEMPTS = 20;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Dark theme matching your app ─────────────────────────────────────────────

const darkAppearance = {
  theme: 'night',
  variables: {
    colorPrimary: '#14f195',
    colorBackground: '#0a0a0a',
    colorText: '#ffffff',
    colorTextSecondary: '#aaaaaa',
    colorDanger: '#ff4d4d',
    fontFamily: 'Inter, system-ui, sans-serif',
    borderRadius: '6px',
    spacingUnit: '4px',
  },
  rules: {
    '.Input': {
      backgroundColor: '#141414',
      color: '#ffffff',
      border: '1px solid #2a2a2a',
      padding: '10px 12px',
    },
    '.Input:focus': {
      border: '1px solid #14f195',
      boxShadow: '0 0 0 2px rgba(20, 241, 149, 0.15)',
    },
    '.Input--invalid': {
      border: '1px solid #ff4d4d',
    },
    '.Label': {
      color: '#888888',
      fontSize: '13px',
      fontWeight: '500',
      marginBottom: '6px',
    },
    '.Tab': {
      backgroundColor: '#141414',
      color: '#888888',
      border: '1px solid #2a2a2a',
    },
    '.Tab:hover': {
      color: '#ffffff',
      border: '1px solid #3a3a3a',
    },
    '.Tab--selected': {
      backgroundColor: '#1e1e1e',
      color: '#ffffff',
      border: '1px solid #14f195',
    },
    '.TabIcon': { color: '#888888' },
    '.TabLabel': { color: '#888888' },
    '.Block': {
      backgroundColor: '#0e0e0e',
      border: '1px solid #1e1e1e',
      borderRadius: '8px',
    },
    '.Error': { color: '#ff4d4d', fontSize: '13px' },
    '.Checkbox-input:focus': {
      boxShadow: '0 0 0 2px rgba(20, 241, 149, 0.15)',
      border: '1px solid #14f195',
    },
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getReturnSession() {
  const params = new URLSearchParams(window.location.search);
  return params.get('billing') === 'success' ? params.get('session_id') : null;
}

function cleanUrl(intent) {
  const p = new URLSearchParams();
  if (intent) p.set('intent', intent);
  const q = p.toString();
  window.history.replaceState({}, '', `${window.location.pathname}${q ? `?${q}` : ''}`);
}

function isSynced(status, intent) {
  if (!status) return false;
  if (intent === 'advanced') return Boolean(status.unlimitedConcurrency || status.plan === 'advanced');
  if (intent === 'standard') return status.plan === 'standard' || status.plan === 'advanced' || Boolean(status.isPaid);
  return Boolean(status.canAccessApp || status.isTrialing || status.isPaid);
}

async function pollBilling(intent, sessionId, onSynced, onError) {
  for (let i = 0; i < STATUS_POLL_ATTEMPTS; i += 1) {
    try {
      if (sessionId) await api.post('/billing/return', { sessionId }).catch(() => {});
      const res = await api.get('/billing/status');
      if (isSynced(res.data, intent)) { await onSynced?.(res.data); return; }
    } catch { /* keep polling */ }
    await wait(STATUS_POLL_INTERVAL_MS);
  }
  onError?.('Syncing access...');
}

// ── Checkout Form (inside provider) ───────────────────────────────────────────

function CheckoutForm({ intent, onSynced, onError }) {
  const checkoutState = useCheckoutElements();

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    if (checkoutState.type !== 'success') return;

    const result = await checkoutState.checkout.confirm();
    if (result?.type === 'error') {
      onError?.(result.error?.message || 'Payment failed.', result.error);
      return;
    }

    if (result?.type === 'success') {
      pollBilling(intent, result.session?.id, onSynced, onError);
    }
  }, [checkoutState, intent, onSynced, onError]);

  if (checkoutState.type === 'loading') {
    return (
      <div className="billing-page-loading">
        <div className="spinner" />
        <p>Loading secure checkout...</p>
      </div>
    );
  }

  if (checkoutState.type === 'error') {
    return (
      <div className="billing-page-empty">
        <div className="alert error billing-page-alert">
          {checkoutState.error?.message || 'Failed to load checkout.'}
        </div>
      </div>
    );
  }

  return (
    <form className="billing-checkout-form" onSubmit={handleSubmit}>
      <div className="billing-checkout-section">
        <PaymentElement />
      </div>
      <div className="billing-checkout-submit">
        <button type="submit" className="btn accent" disabled={checkoutState.type !== 'success'}>
          {intent === 'intro' ? 'Start Free Trial' : 'Subscribe Now'}
        </button>
        <p className="billing-checkout-disclaimer">Secure payment powered by Stripe. Cancel anytime.</p>
      </div>
    </form>
  );
}

// ── Root: manages session creation, stable provider ───────────────────────────

export default function BillingCheckoutEmbed({ intent = 'standard', onSynced, onError }) {
  const { user } = useAuth();
  const [secret, setSecret] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [fetching, setFetching] = useState(false);

  // Handle return from Stripe first
  useEffect(() => {
    if (!user) return;
    const sid = getReturnSession();
    if (!sid) return;
    cleanUrl(intent);
    pollBilling(intent, sid, onSynced, onError);
  }, [user?.id]);

  // Create session once, no re-mounting provider
  useEffect(() => {
    if (!user || secret || fetching) return;
    setFetching(true);

    api.post('/billing/checkout', { intent })
      .then(res => {
        if (res.data?.url && !res.data?.clientSecret) {
          window.location.assign(res.data.url);
          return;
        }
        if (!res.data?.clientSecret) throw new Error('No client secret returned.');
        setSecret(res.data.clientSecret);
      })
      .catch(err => {
        const msg = err?.response?.data?.error || err.message || 'Failed to load checkout.';
        setLoadError(msg);
        onError?.(msg, err);
      })
      .finally(() => { setFetching(false); });
  }, [user?.id]);

  if (!user) return null;

  if (loadError) {
    return (
      <div className="billing-page-empty">
        <div className="alert error billing-page-alert">{loadError}</div>
      </div>
    );
  }

  if (!secret) {
    return (
      <div className="billing-page-loading">
        <div className="spinner" />
        <p>Preparing secure checkout...</p>
      </div>
    );
  }

  return (
    <CheckoutElementsProvider
      stripe={stripePromise}
      options={{
        clientSecret: Promise.resolve(secret),
        elementsOptions: { appearance: darkAppearance },
      }}
    >
      <CheckoutForm intent={intent} onSynced={onSynced} onError={onError} />
    </CheckoutElementsProvider>
  );
}
