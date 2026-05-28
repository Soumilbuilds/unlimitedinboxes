import { useEffect, useMemo, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import api from '../lib/api';

export default function TenantCheckout() {
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [checkoutUrl, setCheckoutUrl] = useState(null);
  const [error, setError] = useState('');

  const quantity = useMemo(() => {
    const raw = Number.parseInt(searchParams.get('quantity') || '', 10);
    return Number.isInteger(raw) && raw > 0 ? raw : null;
  }, [searchParams]);

  const licenseType = useMemo(() => {
    const raw = String(searchParams.get('license') || '').trim().toLowerCase();
    return raw === 'premium' || raw === 'normal' ? raw : null;
  }, [searchParams]);

  useEffect(() => {
    if (!quantity || !licenseType) return;

    let cancelled = false;
    setLoading(true);
    setError('');
    setCheckoutUrl(null);

    api.post('/tenants/purchase-checkout', { quantity, licenseType })
      .then((response) => {
        if (cancelled) return;
        if (response.data?.paid) {
          window.location.replace('/tenants?tenant_purchase=success');
          return;
        }
        const url = response.data?.purchaseUrl || response.data?.checkoutUrl;
        if (url) {
          setCheckoutUrl(url);
          window.location.assign(url);
        } else {
          setError('Failed to get checkout URL.');
        }
      })
      .catch((requestError) => {
        if (cancelled) return;
        setError(requestError.response?.data?.error || 'Failed to load tenant checkout.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [quantity, licenseType]);

  useEffect(() => {
    if (!checkoutUrl) return;

    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session_id');
    const success = params.get('billing') === 'success';

    if (success && sessionId) {
      window.location.replace('/tenants');
    }
  }, [checkoutUrl]);

  if (!quantity || !licenseType) {
    return <Navigate to="/tenants" replace />;
  }

  return (
    <main className="tenant-checkout-page">
      {loading ? (
        <div className="tenant-checkout-loading">
          <div className="spinner" />
        </div>
      ) : error ? (
        <div className="tenant-checkout-shell">
          <div className="alert error">{error}</div>
        </div>
      ) : checkoutUrl ? (
        <div className="tenant-checkout-shell">
          <div style={{ textAlign: 'center', padding: '40px 20px' }}>
            <div className="spinner" style={{ margin: '0 auto 20px' }} />
            <p style={{ color: '#fff', marginBottom: '20px', fontSize: '16px' }}>
              Opening secure Stripe checkout...
            </p>
            <a
              href={checkoutUrl}
              className="btn btn-primary"
              style={{
                display: 'inline-block',
                padding: '14px 32px',
                fontSize: '16px',
                textDecoration: 'none',
                borderRadius: '8px',
              }}
            >
              Continue to Secure Checkout
            </a>
          </div>
        </div>
      ) : (
        <div className="tenant-checkout-loading">
          <div className="spinner" />
        </div>
      )}
    </main>
  );
}
