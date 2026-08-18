import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import api from '../lib/api';

const TENANT_OPTIONS = [
  { value: 'us', licenseType: 'premium', label: 'US IP', unitPriceCents: 1649 },
  { value: 'asia', licenseType: 'normal', label: 'Asian IP', unitPriceCents: 1349 }
];

const TENANT_GUIDE_PAGES = Array.from(
  { length: 7 },
  (_, index) => `/tenant-guide/page-${index + 1}.webp`
);

function newRequestToken() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `tenant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

function money(cents) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format((Number(cents) || 0) / 100);
}

export default function Tenants() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [quantity, setQuantity] = useState(1);
  const [tenantType, setTenantType] = useState('us');
  const [coupon, setCoupon] = useState('');
  const [promotion, setPromotion] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const requestToken = useRef(newRequestToken());

  const selectedOption = TENANT_OPTIONS.find((option) => option.value === tenantType) || TENANT_OPTIONS[0];
  const subtotalCents = selectedOption.unitPriceCents * quantity;
  const discountCents = Number(promotion?.discountCents ?? promotion?.savingsCents ?? 0);
  const totalCents = Number(
    promotion?.totalCents
    ?? promotion?.priceCents
    ?? Math.max(0, subtotalCents - discountCents)
  );

  useEffect(() => {
    if (searchParams.get('tenant_purchase') === 'success') {
      setNotice('Your Tenant Order Is Confirmed.');
      const next = new URLSearchParams(searchParams);
      next.delete('tenant_purchase');
      setSearchParams(next, { replace: true });
    }
  }, []);

  const purchasePayload = useMemo(() => ({
    quantity,
    tenantType,
    licenseType: selectedOption.licenseType,
    couponCode: promotion?.code || ''
  }), [promotion?.code, quantity, selectedOption.licenseType, tenantType]);

  function resetPromotion() {
    setPromotion(null);
    setError('');
    requestToken.current = newRequestToken();
  }

  function openCheckout(data) {
    const purchaseId = data?.purchaseId || data?.tenantPurchaseId || data?.purchase?.id;
    const sessionId = data?.sessionId || data?.checkoutSessionId || data?.checkout?.sessionId;
    if (!purchaseId || !sessionId) return false;
    const params = new URLSearchParams({
      purchase_id: String(purchaseId),
      session_id: String(sessionId)
    });
    if (data?.promoCode) params.set('promo_code', String(data.promoCode));
    navigate(`/tenants/checkout?${params.toString()}`, {
      state: { quantity, tenantType, unitPriceCents: selectedOption.unitPriceCents, totalCents }
    });
    return true;
  }

  async function confirmPendingPayment(purchaseId, paymentId) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const { data } = await api.post(`/tenants/purchase/${encodeURIComponent(purchaseId)}/confirm`, { paymentId });
      if (data?.paid) return data;
      if (data?.sessionId) return data;
      await wait(1200);
    }
    throw new Error('Whop is still confirming your payment. Please refresh in a moment.');
  }

  async function applyCoupon() {
    if (!coupon.trim()) return;
    setBusy('coupon');
    setError('');
    setNotice('');
    setPromotion(null);
    try {
      const { data } = await api.post('/tenants/coupon', {
        ...purchasePayload,
        couponCode: coupon.trim().toUpperCase(),
        code: coupon.trim().toUpperCase()
      });
      const promo = data?.promo ? { ...data, ...data.promo } : data;
      setPromotion(promo);
      setCoupon(promo?.code || coupon.trim().toUpperCase());
      requestToken.current = newRequestToken();
    } catch (requestError) {
      setError(requestError?.response?.data?.error || 'This coupon could not be applied.');
    } finally {
      setBusy('');
    }
  }

  async function purchaseTenants() {
    setBusy('purchase');
    setError('');
    setNotice('');
    try {
      const { data: initialData } = await api.post('/tenants/purchase-checkout', {
        ...purchasePayload,
        requestToken: requestToken.current
      });
      let data = initialData;
      if (data?.paymentPending && data?.purchaseId && data?.paymentId) {
        data = await confirmPendingPayment(data.purchaseId, data.paymentId);
      }
      if (data?.paid === true) {
        setNotice('Your Tenant Order Is Confirmed.');
        setCoupon('');
        setPromotion(null);
        requestToken.current = newRequestToken();
        return;
      }
      if (!openCheckout(data)) {
        throw new Error('Secure checkout could not be prepared.');
      }
    } catch (requestError) {
      setError(requestError?.response?.data?.error || requestError.message || 'Could not start your tenant order.');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content tenants-page">
        <div className="tenant-page-shell">
          <header className="tenant-page-heading">
            <h1>Get Tenants For Creating Inboxes</h1>
          </header>

          {notice && <div className="alert success tenant-page-message" role="status">{notice}</div>}
          {error && <div className="alert error tenant-page-message" role="alert">{error}</div>}

          <section className="tenant-order-card" aria-labelledby="tenant-order-heading">
            <div className="tenant-card-heading">
              <h2 id="tenant-order-heading">Order Tenants From Us</h2>
            </div>

            <div className="tenant-license-grid" role="radiogroup" aria-label="Tenant IP Location">
              {TENANT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  className={`tenant-license-card ${tenantType === option.value ? 'active' : ''}`}
                  type="button"
                  role="radio"
                  aria-checked={tenantType === option.value}
                  onClick={() => {
                    setTenantType(option.value);
                    resetPromotion();
                  }}
                >
                  <span>{option.label}</span>
                  <div>
                    <strong>{money(option.unitPriceCents)}</strong>
                    <small>Per Tenant</small>
                  </div>
                </button>
              ))}
            </div>

            <div className="tenant-purchase-fields">
              <label className="tenant-field" htmlFor="tenant-quantity">
                <span>Number Of Tenants</span>
                <input
                  id="tenant-quantity"
                  type="number"
                  min="1"
                  max="1000"
                  step="1"
                  inputMode="numeric"
                  value={quantity}
                  onChange={(event) => {
                    const next = Number.parseInt(event.target.value, 10);
                    setQuantity(Number.isInteger(next) ? Math.min(1000, Math.max(1, next)) : 1);
                    resetPromotion();
                  }}
                />
              </label>

              <div className="tenant-coupon-field">
                <label htmlFor="tenant-coupon">Coupon Code</label>
                <div>
                  <input
                    id="tenant-coupon"
                    value={coupon}
                    placeholder="Enter Code"
                    onChange={(event) => {
                      setCoupon(event.target.value.toUpperCase());
                      resetPromotion();
                    }}
                  />
                  <button type="button" disabled={!coupon.trim() || Boolean(busy)} onClick={() => void applyCoupon()}>
                    {busy === 'coupon' ? 'Applying...' : 'Apply'}
                  </button>
                </div>
              </div>
            </div>

            <dl className="tenant-order-summary">
              <div><dt>Subtotal</dt><dd>{money(subtotalCents)}</dd></div>
              <div><dt>Coupon Discount</dt><dd>{discountCents > 0 ? `−${money(discountCents)}` : '—'}</dd></div>
              <div className="tenant-order-total"><dt>Total Amount</dt><dd>{money(totalCents)}</dd></div>
            </dl>

            <button
              className="tenant-submit-btn"
              type="button"
              disabled={Boolean(busy)}
              onClick={() => void purchaseTenants()}
            >
              {busy === 'purchase' ? 'Processing...' : 'Get Tenants'}
            </button>
          </section>

          <section className="tenant-guide" aria-label="Tenant Guide">
            {TENANT_GUIDE_PAGES.map((source, index) => (
              <img
                key={source}
                src={source}
                alt={`Microsoft Tenants Guide Page ${index + 1}`}
                loading={index === 0 ? 'eager' : 'lazy'}
                decoding="async"
              />
            ))}
          </section>
        </div>
      </main>
    </div>
  );
}
