import { useEffect, useMemo, useRef, useState } from 'react';
import { WhopCheckoutEmbed, useCheckoutEmbedControls } from '@whop/checkout/react';
import api from '../lib/api';
import { useAuth } from '../context/AuthContext';

const STATUS_POLL_INTERVAL_MS = 1500;
const STATUS_POLL_ATTEMPTS = 20;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeAddress(value) {
  if (!value || typeof value !== 'object') return null;

  const address = {
    name: value.name || value.fullName || value.full_name || '',
    country: value.country || value.countryCode || value.country_code || '',
    line1: value.line1 || value.addressLine1 || value.address_line_1 || '',
    line2: value.line2 || value.addressLine2 || value.address_line_2 || '',
    city: value.city || '',
    state: value.state || value.region || '',
    postalCode: value.postalCode || value.postal_code || value.zip || ''
  };

  return address;
}

function isCompleteAddress(address) {
  return Boolean(
    address?.name
    && address?.country
    && address?.line1
    && address?.city
    && address?.state
    && address?.postalCode
  );
}

function getReturnedReceipt() {
  const params = new URLSearchParams(window.location.search);
  return params.get('receipt_id') || params.get('receiptId');
}

function getStateId() {
  return new URLSearchParams(window.location.search).get('state_id') || undefined;
}

function isSynced(status) {
  return Boolean(status?.canAccessApp || status?.isTrialing || status?.isActive);
}

export default function BillingCheckoutEmbed({ billing, intent = 'starter', onSynced, onError }) {
  const { user } = useAuth();
  const controls = useCheckoutEmbedControls();
  const [sessionId, setSessionId] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('Checking Your Billing Status...');
  const [checkoutState, setCheckoutState] = useState('loading');
  const [submitting, setSubmitting] = useState(false);
  const cancelled = useRef(false);
  const runId = useRef(0);

  const savedAddress = useMemo(
    () => normalizeAddress(billing?.billingAddress),
    [billing?.billingAddress]
  );
  const hasSavedAddress = isCompleteAddress(savedAddress);

  async function syncStatus() {
    const statusResponse = await api.get('/billing/status');
    if (isSynced(statusResponse.data)) {
      await onSynced?.(statusResponse.data);
      return true;
    }
    return false;
  }

  async function finalizeCheckout(receiptId) {
    setError('');
    setSubmitting(true);
    setMessage('Confirming Your Access...');

    let billingAddress = savedAddress;
    try {
      const result = await controls.current?.getAddress(4000);
      if (result?.isComplete) billingAddress = result.address;
    } catch {
      // A completed checkout can still be finalized if the iframe has already unloaded.
    }

    for (let attempt = 0; attempt < STATUS_POLL_ATTEMPTS; attempt += 1) {
      if (cancelled.current) return;
      try {
        await api.post('/billing/return', { receiptId, billingAddress });
        if (await syncStatus()) return;
      } catch (requestError) {
        const status = requestError?.response?.status;
        if (status && status !== 409 && status < 500) {
          const detail = requestError?.response?.data?.error || requestError.message;
          setError(detail);
          setSubmitting(false);
          onError?.(detail, requestError);
          return;
        }
      }
      await wait(STATUS_POLL_INTERVAL_MS);
    }

    if (!cancelled.current) {
      setMessage('');
      setSubmitting(false);
      setError('Your payment was received and is still being confirmed. Please do not submit it again.');
    }
  }

  useEffect(() => {
    if (!user) return undefined;
    const currentRun = ++runId.current;
    cancelled.current = false;

    const returnedReceipt = getReturnedReceipt();
    if (returnedReceipt) {
      void finalizeCheckout(returnedReceipt);
      return () => { cancelled.current = true; };
    }

    void Promise.resolve()
      .then(() => {
        if (runId.current !== currentRun) return true;
        return syncStatus();
      })
      .then(async (synced) => {
        if (synced || cancelled.current || runId.current !== currentRun) return;
        setMessage('Preparing Secure Checkout...');
        const response = await api.post('/billing/checkout', { intent });
        if (response.data?.provider && response.data.provider !== 'whop') {
          throw new Error('The secure checkout provider is unavailable.');
        }
        if (!response.data?.sessionId) throw new Error('No checkout session was returned.');
        if (!cancelled.current && runId.current === currentRun) {
          setSessionId(response.data.sessionId);
          setMessage('');
        }
      })
      .catch((requestError) => {
        if (cancelled.current || runId.current !== currentRun) return;
        if (requestError?.response?.status === 409) {
          void syncStatus().catch(() => false);
          return;
        }
        const detail = requestError?.response?.data?.error || requestError.message || 'Could not prepare checkout.';
        setError(detail);
        setMessage('');
        onError?.(detail, requestError);
      });

    return () => {
      if (runId.current === currentRun) cancelled.current = true;
    };
  }, [user?.id]);

  async function submitCheckout() {
    if (submitting || checkoutState !== 'ready' || !controls.current) return;
    setSubmitting(true);
    setError('');
    try {
      await controls.current.submit();
    } catch (requestError) {
      const detail = requestError?.message || 'Please check your payment details and try again.';
      setError(detail);
      setSubmitting(false);
      onError?.(detail, requestError);
    }
  }

  if (!user) return null;

  if (error && !sessionId) {
    return <div className="alert error billing-page-alert">{error}</div>;
  }

  if (!sessionId) {
    return (
      <div className="billing-page-loading compact">
        <div className="spinner" />
        <p>{message}</p>
      </div>
    );
  }

  return (
    <div className="whop-checkout-layout">
      {error ? <div className="alert error billing-page-alert">{error}</div> : null}

      <div className={`whop-checkout-frame ${submitting ? 'is-submitting' : ''}`}>
        <WhopCheckoutEmbed
          ref={controls}
          sessionId={sessionId}
          stateId={getStateId()}
          theme="dark"
          themeOptions={{ accentColor: '#86f7b8', backgroundColor: '#090909', borderRadius: 8 }}
          styles={{ container: { paddingX: 0, paddingY: 0 } }}
          prefill={{ email: user.email, ...(savedAddress ? { address: savedAddress } : {}) }}
          hideEmail
          hideAddressForm={hasSavedAddress}
          hideSubmitButton
          setupFutureUsage="off_session"
          skipRedirect
          returnUrl={`${window.location.origin}/billing?intent=${intent}`}
          onStateChange={setCheckoutState}
          onAddressValidationError={({ error_message: detail }) => setError(detail)}
          onPaymentError={({ message: detail }) => {
            setSubmitting(false);
            setError(detail || 'Your payment could not be completed. Please try again.');
          }}
          onComplete={(_planId, receiptId, result) => {
            void finalizeCheckout(result?.receipt_id || receiptId);
          }}
          fallback={(
            <div className="billing-page-loading compact">
              <div className="spinner" />
              <p>Loading Secure Payment Form...</p>
            </div>
          )}
        />
      </div>

      <button
        className="btn checkout-get-access"
        type="button"
        disabled={submitting || checkoutState !== 'ready'}
        onClick={() => void submitCheckout()}
      >
        {submitting ? 'Confirming...' : 'Get Access'}
      </button>
    </div>
  );
}
