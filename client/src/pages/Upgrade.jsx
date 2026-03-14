import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import WhopCheckoutFrame from '../components/WhopCheckoutFrame';
import { useAuth } from '../context/AuthContext';
import api from '../lib/api';

const STATUS_POLL_INTERVAL_MS = 1500;
const STATUS_POLL_ATTEMPTS = 20;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default function Upgrade() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, refreshUser } = useAuth();
  const [sessionId, setSessionId] = useState(null);
  const [purchaseUrl, setPurchaseUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [alreadyPaid, setAlreadyPaid] = useState(false);
  const [error, setError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const pollCancelled = useRef(false);

  const stateId = searchParams.get('state_id') || '';
  const isReturnVisit =
    searchParams.get('billing') === 'success' || Boolean(stateId);

  const returnUrl = useMemo(() => {
    if (typeof window === 'undefined') {
      return 'http://localhost:3000/upgrade?billing=success';
    }

    return `${window.location.origin}/upgrade?billing=success`;
  }, []);

  const applyPaidState = async ({ redirect = false } = {}) => {
    await refreshUser({ force: true, minIntervalMs: 0 });
    setAlreadyPaid(true);
    setSessionId(null);
    setPurchaseUrl('');

    if (redirect) {
      navigate('/orders', { replace: true });
    }
  };

  const verifyUpgrade = async ({
    redirectOnSuccess = false,
    suppressFinalError = false,
    initialMessage = 'Checking your subscription...'
  } = {}) => {
    pollCancelled.current = false;
    setVerifying(true);
    setError('');
    setStatusMessage(initialMessage);

    try {
      for (let attempt = 0; attempt < STATUS_POLL_ATTEMPTS; attempt += 1) {
        if (pollCancelled.current) {
          return false;
        }

        const res = await api.get('/billing/status');
        if (res.data?.isPaid) {
          setStatusMessage('Subscription confirmed. Redirecting to your dashboard...');
          await applyPaidState({ redirect: redirectOnSuccess });
          return true;
        }

        await wait(STATUS_POLL_INTERVAL_MS);
      }

      if (!suppressFinalError) {
        setError('Payment was submitted, but the upgrade is still syncing. Wait a few seconds and try again.');
      }
      return false;
    } catch (err) {
      if (!suppressFinalError) {
        setError(err.response?.data?.error || 'Failed to verify your subscription status.');
      }
      return false;
    } finally {
      if (!pollCancelled.current) {
        setVerifying(false);
        setStatusMessage('');
      }
    }
  };

  const createCheckoutSession = async () => {
    setError('');
    setSessionId(null);
    setPurchaseUrl('');

    try {
      const res = await api.post('/billing/checkout');
      setSessionId(res.data.sessionId || null);
      setPurchaseUrl(res.data.purchaseUrl || '');
      return true;
    } catch (err) {
      if (err.response?.status === 409) {
        await applyPaidState();
        return true;
      }

      setError(err.response?.data?.error || 'Failed to prepare Whop checkout.');
      return false;
    }
  };

  useEffect(() => {
    let cancelled = false;
    pollCancelled.current = false;

    const bootstrap = async () => {
      setLoading(true);
      setError('');
      setStatusMessage('');
      setAlreadyPaid(false);

      try {
        const statusRes = await api.get('/billing/status');
        if (cancelled) {
          return;
        }

        if (statusRes.data?.isPaid) {
          if (isReturnVisit) {
            await applyPaidState({ redirect: true });
            return;
          }

          await applyPaidState();
          return;
        }

        if (isReturnVisit) {
          const confirmed = await verifyUpgrade({
            redirectOnSuccess: true,
            suppressFinalError: true,
            initialMessage: 'Payment submitted. Confirming your access...'
          });

          if (cancelled || confirmed) {
            return;
          }
        }

        await createCheckoutSession();
      } catch (err) {
        if (!cancelled) {
          setError(err.response?.data?.error || 'Failed to load your billing status.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
      pollCancelled.current = true;
    };
  }, [isReturnVisit, stateId]);

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <div className="upgrade-page">
          <button className="btn ghost upgrade-back" onClick={() => navigate('/orders')}>
            Back to Orders
          </button>

          <section className="upgrade-hero">
            <span className="upgrade-eyebrow">Unlimited plan</span>
            <h1>Upgrade To Unlock Limitless Access</h1>
            <p>
              Complete the secure Whop checkout below to unlock unlimited inboxes,
              unlimited downloads, and full access across the app.
            </p>
            {user?.email && (
              <p className="upgrade-meta">Signed in as {user.email}</p>
            )}
          </section>

          {error && <div className="alert error billing-alert">{error}</div>}
          {statusMessage && (
            <div className="alert info billing-alert billing-status-row">
              <div className="spinner billing-inline-spinner" />
              <span>{statusMessage}</span>
            </div>
          )}

          <section className="upgrade-shell">
            {loading ? (
              <div className="upgrade-loading-shell">
                <div className="spinner" />
                <p>Preparing your secure checkout...</p>
              </div>
            ) : alreadyPaid ? (
              <div className="upgrade-state-card">
                <h2>Unlimited access is already active</h2>
                <p>Your account is marked as paid. You can go straight back to the dashboard.</p>
                <div className="upgrade-actions">
                  <button className="btn accent" onClick={() => navigate('/orders')}>
                    Go to Orders
                  </button>
                  <button className="btn primary" onClick={() => navigate('/inboxes')}>
                    Open Inboxes
                  </button>
                </div>
              </div>
            ) : sessionId ? (
              <div className="upgrade-checkout-shell">
                <WhopCheckoutFrame
                  sessionId={sessionId}
                  email={user?.email || ''}
                  returnUrl={returnUrl}
                  stateId={stateId || undefined}
                  onComplete={() => {
                    void verifyUpgrade({
                      redirectOnSuccess: true,
                      initialMessage: 'Payment submitted. Confirming your access...'
                    });
                  }}
                />
              </div>
            ) : (
              <div className="upgrade-state-card">
                <h2>Checkout unavailable</h2>
                <p>We could not create a Whop checkout session right now.</p>
                <div className="upgrade-actions">
                  <button
                    className="btn accent"
                    onClick={async () => {
                      setLoading(true);
                      await createCheckoutSession();
                      setLoading(false);
                    }}
                  >
                    Try Again
                  </button>
                </div>
              </div>
            )}
          </section>

          <div className="upgrade-actions">
            <button className="btn ghost" onClick={() => navigate('/orders')}>
              Back to Orders
            </button>
            <button
              className="btn primary"
              onClick={() => void verifyUpgrade()}
              disabled={loading || verifying || alreadyPaid}
            >
              {verifying ? 'Checking...' : 'Check Status'}
            </button>
            {purchaseUrl && !alreadyPaid && (
              <a className="btn primary" href={purchaseUrl} target="_blank" rel="noreferrer">
                Open In New Tab
              </a>
            )}
          </div>

          <p className="upgrade-note">
            If your bank opens an extra authorization step, Whop will bring you back here automatically.
          </p>
        </div>
      </main>
    </div>
  );
}
