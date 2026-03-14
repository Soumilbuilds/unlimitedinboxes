import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
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
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
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

  const redirectToOrders = async () => {
    await refreshUser({ force: true, minIntervalMs: 0 });
    setSessionId(null);
    navigate('/orders', { replace: true });
  };

  const verifyUpgrade = async ({
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
          await redirectToOrders();
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

    try {
      const res = await api.post('/billing/checkout');
      setSessionId(res.data.sessionId || null);
      return true;
    } catch (err) {
      if (err.response?.status === 409) {
        await redirectToOrders();
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

      try {
        const statusRes = await api.get('/billing/status');
        if (cancelled) {
          return;
        }

        if (statusRes.data?.isPaid) {
          await redirectToOrders();
          return;
        }

        if (isReturnVisit) {
          const confirmed = await verifyUpgrade({
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
    <main className="billing-page">
      <div className="billing-page-inner">
        <section className="billing-page-header">
          <h1>Upgrade To Unlock Limitless Access</h1>
        </section>

        {error && <div className="alert error billing-alert">{error}</div>}
        {statusMessage && (
          <div className="alert info billing-alert billing-status-row">
            <div className="spinner billing-inline-spinner" />
            <span>{statusMessage}</span>
          </div>
        )}

        {loading ? (
          <div className="billing-page-loading">
            <div className="spinner" />
            <p>Preparing your secure checkout...</p>
          </div>
        ) : sessionId ? (
          <div className="billing-page-checkout">
            <WhopCheckoutFrame
              sessionId={sessionId}
              email={user?.email || ''}
              returnUrl={returnUrl}
              stateId={stateId || undefined}
              onComplete={() => {
                void verifyUpgrade({
                  initialMessage: 'Payment submitted. Confirming your access...'
                });
              }}
            />
          </div>
        ) : (
          <div className="billing-page-loading">
            <p>Unable to load checkout right now.</p>
          </div>
        )}
      </div>
    </main>
  );
}
