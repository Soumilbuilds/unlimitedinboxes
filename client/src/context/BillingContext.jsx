import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
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

function buildBlockingCheckout(billing) {
  if (!billing?.blockingReason) {
    return null;
  }

  if (billing.blockingReason === 'needs_intro_offer') {
    return {
      intent: 'intro',
      allowClose: false,
      headline: 'No Active Subscription Found',
      subheadline: 'Start Three-Day Free Trial',
      description: null
    };
  }

  if (billing.blockingReason === 'payment_overdue') {
    return {
      intent: 'retry',
      allowClose: false,
      headline: 'Payment Overdue',
      subheadline: 'An invoice is past due. Please update your payment method to restore access.',
      description: billing.overdueInvoiceId
        ? `Invoice ID: ${billing.overdueInvoiceId}`
        : null
    };
  }

  return {
    intent: 'standard',
    allowClose: false,
    headline: 'No Active Subscription Found',
    subheadline: 'Upgrade To Continue',
    description: null
  };
}

function buildUpgradeCheckout(intent) {
  if (intent === 'intro') {
    return {
      intent: 'intro',
      allowClose: true,
      headline: 'Start Three-Day Free Trial',
      subheadline: 'Create Your First Order And Download 10 Inboxes',
      description: null
    };
  }

  if (intent === 'retry') {
    return {
      intent: 'retry',
      allowClose: false,
      headline: 'Payment Overdue',
      subheadline: 'Pay The Open Invoice To Restore Access',
      description: null
    };
  }

  if (intent === 'advanced') {
    return {
      intent: 'advanced',
      allowClose: true,
      headline: 'Upgrade To Access Advanced',
      subheadline: 'Unlock Unlimited Parallel Order Processing',
      description: null
    };
  }

  return {
    intent: 'standard',
    allowClose: true,
    headline: 'Upgrade And Get Limitless Access',
    subheadline: 'Unlock Full Downloads And Paid Access',
    description: null
  };
}

export function BillingProvider({ children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, refreshUser } = useAuth();
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

  const finalizeReturn = async () => {
    if (!user?.id) return;
    const params = new URLSearchParams(location.search);
    const billingParam = params.get('billing');
    const sessionId = params.get('session_id');
    if (!billingParam) {
      return;
    }

    try {
      await api.post('/billing/return', { sessionId });
      await refreshUser({ force: true, minIntervalMs: 0 });
      await refreshBilling({ force: true, minIntervalMs: 0 });
    } catch (error) {
      console.error(error);
    } finally {
      navigate(location.pathname, { replace: true });
    }
  };

  useEffect(() => {
    void refreshBilling({ force: true, minIntervalMs: 0 });
  }, [user?.id]);

  useEffect(() => {
    void finalizeReturn();
  }, [user?.id, location.search]);

  const openUpgrade = (intent = 'standard') => {
    const checkout = buildUpgradeCheckout(intent);
    redirectToBilling(checkout.intent);
  };

  const openBillingPortal = async () => {
    try {
      const res = await api.get('/billing/portal');
      const targetUrl = res.data?.url;
      if (!targetUrl) {
        throw new Error('Billing portal link was not returned.');
      }
      const portalWindow = window.open(targetUrl, '_blank', 'noopener,noreferrer');
      if (!portalWindow) {
        window.location.href = targetUrl;
      }
    } catch (error) {
      window.alert(error.response?.data?.error || error.message || 'Failed to open billing portal.');
    }
  };

  const value = {
    billing,
    loading,
    reviewUrl: REVIEW_URL,
    refreshBilling,
    openUpgrade,
    openBillingPortal
  };

  const blockingCheckout = buildBlockingCheckout(billing);

  useEffect(() => {
    if (!user?.id || !blockingCheckout || billing?.blockingReason !== 'payment_overdue') {
      return;
    }

    if (location.pathname === '/billing') {
      return;
    }

    redirectToBilling(blockingCheckout.intent, { replace: true });
  }, [user?.id, billing?.blockingReason, blockingCheckout?.intent, location.pathname]);

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
