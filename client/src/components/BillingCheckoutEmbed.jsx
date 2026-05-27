import { useEffect, useRef, useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import api from '../lib/api';
import { useAuth } from '../context/AuthContext';

const STATUS_POLL_INTERVAL_MS = 1500;
const STATUS_POLL_ATTEMPTS = 20;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isCheckoutSynced(status, intent) {
  if (!status) return false;

  if (intent === 'advanced') {
    return Boolean(status.unlimitedConcurrency || status.plan === 'advanced');
  }

  if (intent === 'standard') {
    return status.plan === 'standard' || status.plan === 'advanced' || Boolean(status.isPaid);
  }

  return Boolean(status.canAccessApp || status.isTrialing || status.isPaid);
}

export default function BillingCheckoutEmbed({
  intent = 'standard',
  onSynced,
  onError
}) {
  const { user } = useAuth();
  const [sessionId, setSessionId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [checkoutReady, setCheckoutReady] = useState(false);
  const pollCancelled = useRef(false);

  useEffect(() => {
    let cancelled = false;
    pollCancelled.current = false;
    setLoading(true);
    setError('');
    setStatusMessage('');
    setSessionId(null);
    setCheckoutReady(false);

    api.post('/billing/checkout', { intent })
      .then((res) => {
        if (cancelled) return;
        const session = res.data?.sessionId || res.data?.id;
        if (session) {
          setSessionId(session);
          setCheckoutReady(true);
        } else {
          setError('Failed to get checkout session.');
          onError?.('Failed to get checkout session.');
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err.response?.data?.error || 'Failed to open checkout.';
        setError(message);
        onError?.(message, err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      pollCancelled.current = true;
    };
  }, [intent, onError]);

  const handleVerify = async (verifySessionId = null) => {
    pollCancelled.current = false;
    setVerifying(true);
    setError('');
    setStatusMessage('Confirming your access...');

    try {
      for (let attempt = 0; attempt < STATUS_POLL_ATTEMPTS; attempt += 1) {
        if (pollCancelled.current) return;

        await api.post('/billing/return', { sessionId: verifySessionId }).catch(() => undefined);

        const res = await api.get('/billing/status');
        if (isCheckoutSynced(res.data, intent)) {
          await onSynced?.(res.data);
          return;
        }

        await wait(STATUS_POLL_INTERVAL_MS);
      }

      const message = 'Checkout completed, but billing is still syncing. Refresh in a few seconds.';
      setError(message);
      onError?.(message);
    } catch (err) {
      const message = err.response?.data?.error || 'Failed to verify your billing status.';
      setError(message);
      onError?.(message, err);
    } finally {
      if (!pollCancelled.current) {
        setVerifying(false);
        setStatusMessage('');
      }
    }
  };

  useEffect(() => {
    if (!sessionId) return;

    const params = new URLSearchParams(window.location.search);
    const urlSessionId = params.get('session_id');
    const success = params.get('billing') === 'success';

    if (success && urlSessionId) {
      handleVerify(urlSessionId);
    }
  }, [sessionId]);

  const handleCheckout = async () => {
    if (!sessionId) return;

    setLoading(true);
    setError('');

    try {
      const stripe = await loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY);
      if (!stripe) {
        throw new Error('Failed to load Stripe.');
      }
      await stripe.redirectToCheckout({ sessionId });
    } catch (err) {
      const message = err.message || 'Failed to open checkout.';
      setError(message);
      onError?.(message, err);
      setLoading(false);
    }
  };

  if (loading && !checkoutReady) {
    return (
      <div className="billing-page-loading">
        <div className="spinner" />
      </div>
    );
  }

  if (error && !checkoutReady) {
    return (
      <div className="billing-page-empty">
        <div className="alert error billing-page-alert">{error}</div>
      </div>
    );
  }

  return (
    <div className="billing-page-embed-wrap">
      {error && <div className="alert error billing-page-alert">{error}</div>}
      {statusMessage && (
        <div className="alert info billing-page-alert billing-status-row">
          <div className="spinner billing-inline-spinner" />
          <span>{statusMessage}</span>
        </div>
      )}
      {verifying ? (
        <div className="billing-page-loading">
          <div className="spinner" />
        </div>
      ) : checkoutReady ? (
        <div className="billing-embed-shell billing-page-embed">
          <div style={{ textAlign: 'center', padding: '40px 20px' }}>
            {loading ? (
              <div className="spinner" style={{ margin: '0 auto 20px' }} />
            ) : (
              <p style={{ color: '#fff', marginBottom: '20px' }}>
                Click below to complete your purchase securely via Stripe.
              </p>
            )}
            <button
              onClick={handleCheckout}
              disabled={loading}
              className="btn btn-primary"
              style={{
                display: 'inline-block',
                padding: '14px 32px',
                fontSize: '16px',
                borderRadius: '8px',
                border: 'none',
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.7 : 1,
              }}
            >
              Continue to Secure Checkout
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}