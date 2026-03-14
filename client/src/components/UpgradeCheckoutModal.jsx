import { useEffect, useMemo, useRef, useState } from 'react';
import { WhopCheckoutEmbed } from '@whop/checkout/react';
import api from '../lib/api';
import { useAuth } from '../context/AuthContext';

const STATUS_POLL_INTERVAL_MS = 1500;
const STATUS_POLL_ATTEMPTS = 20;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default function UpgradeCheckoutModal({ open, onClose, onUpgraded }) {
  const { user } = useAuth();
  const [sessionId, setSessionId] = useState(null);
  const [purchaseUrl, setPurchaseUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const pollCancelled = useRef(false);

  useEffect(() => {
    if (!open) {
      pollCancelled.current = true;
      setSessionId(null);
      setPurchaseUrl('');
      setLoading(false);
      setVerifying(false);
      setError('');
      setStatusMessage('');
      return;
    }

    let cancelled = false;
    pollCancelled.current = false;
    setLoading(true);
    setError('');
    setStatusMessage('');
    setSessionId(null);

    api.post('/billing/checkout')
      .then((res) => {
        if (cancelled) return;
        setSessionId(res.data.sessionId || null);
        setPurchaseUrl(res.data.purchaseUrl || '');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.response?.data?.error || 'Failed to open Whop checkout.');
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      pollCancelled.current = true;
    };
  }, [open]);

  const returnUrl = useMemo(() => {
    if (typeof window === 'undefined') {
      return 'http://localhost:3000/orders';
    }
    return `${window.location.origin}/orders`;
  }, []);

  const handleVerify = async () => {
    pollCancelled.current = false;
    setVerifying(true);
    setError('');
    setStatusMessage('Finalizing your Whop subscription...');

    try {
      for (let attempt = 0; attempt < STATUS_POLL_ATTEMPTS; attempt += 1) {
        if (pollCancelled.current) {
          return;
        }

        const res = await api.get('/billing/status');
        if (res.data?.isPaid) {
          setStatusMessage('Subscription confirmed. Redirecting to your dashboard...');
          await onUpgraded?.();
          return;
        }

        await wait(STATUS_POLL_INTERVAL_MS);
      }

      setError('Payment completed, but the upgrade is still syncing. Wait a few seconds and click "Check Status" again.');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to verify your subscription status.');
    } finally {
      if (!pollCancelled.current) {
        setVerifying(false);
        setStatusMessage('');
      }
    }
  };

  const handleClose = () => {
    pollCancelled.current = true;
    onClose?.();
  };

  if (!open) {
    return null;
  }

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal upgrade-modal billing-modal" onClick={(e) => e.stopPropagation()}>
        <div className="wizard-header billing-modal-header">
          <div>
            <h2>Upgrade Your Account</h2>
            <p className="modal-subtitle billing-modal-subtitle">
              Complete the secure Whop checkout below to unlock unlimited inboxes.
            </p>
          </div>
          <button className="icon-btn" onClick={handleClose} title="Close">✕</button>
        </div>

        {error && <div className="alert error billing-alert">{error}</div>}
        {statusMessage && (
          <div className="alert info billing-alert billing-status-row">
            <div className="spinner billing-inline-spinner" />
            <span>{statusMessage}</span>
          </div>
        )}

        {loading ? (
          <div className="billing-loading-shell">
            <div className="spinner" />
            <p>Preparing your secure checkout...</p>
          </div>
        ) : sessionId ? (
          <div className="billing-embed-shell">
            <WhopCheckoutEmbed
              sessionId={sessionId}
              theme="dark"
              skipRedirect
              returnUrl={returnUrl}
              prefill={user?.email ? { email: user.email } : undefined}
              hideEmail
              disableEmail
              setupFutureUsage="off_session"
              themeOptions={{ accentColor: 'cyan', highContrast: true }}
              onComplete={() => {
                void handleVerify();
              }}
            />
          </div>
        ) : null}

        <div className="billing-footer">
          <p className="billing-helper">
            You can close this checkout at any time and come back later.
          </p>
          <div className="modal-actions centered billing-actions">
            <button className="btn ghost" onClick={handleClose}>Close</button>
            <button className="btn accent" onClick={() => void handleVerify()} disabled={loading || verifying}>
              {verifying ? 'Checking...' : 'Check Status'}
            </button>
            {purchaseUrl && (
              <a className="btn primary" href={purchaseUrl} target="_blank" rel="noreferrer">
                Open Full Page
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
