import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { WhopCheckoutEmbed, useCheckoutEmbedControls } from '@whop/checkout/react';
import { useAuth } from '../context/AuthContext';
import { useBilling } from '../context/BillingContext';
import api from '../lib/api';

const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

function normalizeAddress(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    name: value.name || value.fullName || value.full_name || '',
    country: value.country || value.countryCode || value.country_code || '',
    line1: value.line1 || value.addressLine1 || value.address_line_1 || '',
    line2: value.line2 || value.addressLine2 || value.address_line_2 || '',
    city: value.city || '',
    state: value.state || value.region || '',
    postalCode: value.postalCode || value.postal_code || value.zip || ''
  };
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

export default function TenantCheckout() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const { billing, loading: billingLoading, refreshBilling } = useBilling();
  const controls = useCheckoutEmbedControls();
  const confirmingRef = useRef(false);
  const [checkoutState, setCheckoutState] = useState('loading');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const purchaseId = searchParams.get('purchase_id') || searchParams.get('purchase') || '';
  const querySessionId = searchParams.get('session_id') || '';
  const queryPromoCode = searchParams.get('promo_code') || '';
  const returnedReceipt = searchParams.get('receipt_id') || searchParams.get('receiptId') || '';
  const [sessionId, setSessionId] = useState(querySessionId);
  const [promoCode, setPromoCode] = useState(queryPromoCode);
  const [recovering, setRecovering] = useState(Boolean(purchaseId && !querySessionId));
  const savedAddress = useMemo(() => normalizeAddress(billing?.billingAddress), [billing?.billingAddress]);
  const completeAddress = isCompleteAddress(savedAddress);

  useEffect(() => {
    if (!purchaseId || sessionId) return undefined;
    let active = true;
    setRecovering(true);
    setError('');

    api.get(`/tenants/purchase/${encodeURIComponent(purchaseId)}`)
      .then(({ data }) => {
        if (!active) return;
        if (data?.paid || data?.confirmed) {
          navigate('/tenants?tenant_purchase=success', { replace: true });
          return;
        }
        if (!data?.sessionId) throw new Error('Secure checkout could not be restored.');
        const restoredSessionId = String(data.sessionId);
        const restoredPromoCode = String(data.promoCode || queryPromoCode || '');
        setSessionId(restoredSessionId);
        setPromoCode(restoredPromoCode);

        const next = new URLSearchParams(searchParams);
        next.delete('purchase');
        next.set('purchase_id', String(purchaseId));
        next.set('session_id', restoredSessionId);
        if (restoredPromoCode) next.set('promo_code', restoredPromoCode);
        setSearchParams(next, { replace: true });
      })
      .catch((requestError) => {
        if (!active) return;
        setError(requestError?.response?.data?.error || requestError.message || 'Secure checkout could not be restored.');
      })
      .finally(() => {
        if (active) setRecovering(false);
      });

    return () => { active = false; };
  }, [purchaseId, sessionId]);

  useEffect(() => {
    if (purchaseId && sessionId && returnedReceipt) {
      void confirmPurchase(returnedReceipt);
    }
  }, [purchaseId, returnedReceipt, sessionId]);

  if (!purchaseId) {
    return <Navigate to="/tenants" replace />;
  }

  if (!sessionId || recovering || billingLoading) {
    return (
      <main className="tenant-checkout-page">
        <div className="tenant-checkout-shell">
          <header className="tenant-checkout-heading">
            <span>Secure Checkout</span>
            <h1>{recovering || !sessionId ? 'Restoring Your Tenant Order' : 'Preparing Your Tenant Order'}</h1>
          </header>
          {error ? (
            <div className="alert error" role="alert">{error}</div>
          ) : (
            <div className="tenant-checkout-loading">
              <div className="spinner" />
              <p>{recovering ? 'Restoring Secure Payment Form...' : 'Preparing Secure Payment Form...'}</p>
            </div>
          )}
        </div>
      </main>
    );
  }

  async function confirmPurchase(receiptId) {
    if (!receiptId || confirmingRef.current) return;
    confirmingRef.current = true;
    setSubmitting(true);
    setError('');
    setStatus('Confirming Your Tenant Order...');

    let billingAddress = savedAddress;
    try {
      const result = await controls.current?.getAddress(4000);
      if (result?.isComplete) billingAddress = result.address;
    } catch {
      // The checkout may unload before the address can be read. The verified
      // Whop receipt remains the source of truth for the payment.
    }

    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const { data } = await api.post(`/tenants/purchase/${encodeURIComponent(purchaseId)}/confirm`, {
          receiptId,
          paymentId: receiptId,
          billingAddress
        });
        if (data?.failed) throw new Error(data?.error || 'Your payment could not be completed.');
        if (data?.paid || data?.confirmed) {
          await refreshBilling({ force: true, minIntervalMs: 0 });
          navigate('/tenants?tenant_purchase=success', { replace: true });
          return;
        }
        await wait(1200);
      }
      throw new Error('Whop is still confirming your payment. Please refresh in a moment.');
    } catch (requestError) {
      setError(requestError?.response?.data?.error || requestError.message || 'Your payment is still being confirmed.');
      setStatus('');
      setSubmitting(false);
      confirmingRef.current = false;
    }
  }

  async function submitCheckout() {
    if (submitting || checkoutState !== 'ready' || !controls.current) return;
    setSubmitting(true);
    setError('');
    try {
      await controls.current.submit();
    } catch (requestError) {
      setError(requestError?.message || 'Please check your payment details and try again.');
      setSubmitting(false);
    }
  }

  return (
    <main className="tenant-checkout-page">
      <div className="tenant-checkout-shell">
        <header className="tenant-checkout-heading">
          <span>Secure Checkout</span>
          <h1>Complete Your Tenant Order</h1>
          <p>{user?.email}</p>
        </header>

        {error && <div className="alert error" role="alert">{error}</div>}

        <section className={`tenant-whop-frame ${submitting ? 'is-submitting' : ''}`}>
          <WhopCheckoutEmbed
            ref={controls}
            sessionId={sessionId}
            theme="dark"
            themeOptions={{ accentColor: '#86f7b8', backgroundColor: '#090909', borderRadius: 8 }}
            styles={{ container: { paddingX: 0, paddingY: 0 } }}
            prefill={{ email: user?.email, ...(completeAddress ? { address: savedAddress } : {}) }}
            hideEmail
            hideAddressForm={completeAddress}
            hideSubmitButton
            setupFutureUsage="off_session"
            promoCode={promoCode || undefined}
            skipRedirect
            returnUrl={`${window.location.origin}/tenants/checkout?purchase_id=${encodeURIComponent(purchaseId)}&session_id=${encodeURIComponent(sessionId)}${promoCode ? `&promo_code=${encodeURIComponent(promoCode)}` : ''}`}
            onStateChange={setCheckoutState}
            onAddressValidationError={({ error_message: detail }) => setError(detail)}
            onPaymentError={({ message }) => {
              setSubmitting(false);
              setError(message || 'Your payment could not be completed. Please try again.');
            }}
            onComplete={(_planId, receiptId, result) => {
              void confirmPurchase(result?.receipt_id || receiptId);
            }}
            fallback={(
              <div className="tenant-checkout-loading">
                <div className="spinner" />
                <p>Loading Secure Payment Form...</p>
              </div>
            )}
          />
        </section>

        {status && <p className="tenant-checkout-status">{status}</p>}
        <button
          className="tenant-checkout-action"
          type="button"
          disabled={submitting || checkoutState !== 'ready'}
          onClick={() => void submitCheckout()}
        >
          {submitting ? 'Confirming...' : 'Get Tenants'}
        </button>
      </div>
    </main>
  );
}
