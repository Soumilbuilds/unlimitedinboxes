import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import api from '../lib/api';
import { useBilling } from '../context/BillingContext';

const PRICE_PER_ORDER = 14;
const MIN_QUANTITY = 3;

const VALID_PLANS = new Set(['reseller', 'perOrder']);

function redirectToApiDocs() {
  if (typeof window !== 'undefined') {
    window.location.replace('/api-docs');
  }
}

function redirectToOrders() {
  if (typeof window !== 'undefined') {
    window.location.replace('/orders');
  }
}

export default function APIBilling() {
  const [searchParams] = useSearchParams();
  const { billing, refreshBilling } = useBilling();
  const [topUpModal, setTopUpModal] = useState(false);
  const [quantity, setQuantity] = useState(MIN_QUANTITY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const plan = (() => {
    const raw = searchParams.get('plan');
    return VALID_PLANS.has(raw) ? raw : null;
  })();

  const isReseller = Boolean(billing?.isReseller);
  const remainingOrders = billing?.remainingOrders;
  const totalOrders = billing?.totalOrders;

  useEffect(() => {
    void refreshBilling({ force: true, minIntervalMs: 0 });
  }, []);

  // Redirect if already has API access
  useEffect(() => {
    if (billing?.canAccessApi) {
      redirectToApiDocs();
    }
  }, [billing?.canAccessApi]);

  const handleUpgrade = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.post('/billing/checkout', { intent: 'reseller' });
      if (res.data?.url) {
        window.location.href = res.data.url;
      }
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to start checkout');
      setLoading(false);
    }
  };

  const handleAddCredits = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.post('/billing/checkout-additional-orders', { quantity });
      if (res.data?.url) {
        window.location.href = res.data.url;
      }
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to start checkout');
      setLoading(false);
    }
  };

  const handleTopUp = () => {
    setTopUpModal(true);
  };

  const incrementQuantity = () => {
    setQuantity(prev => prev + 1);
  };

  const decrementQuantity = () => {
    setQuantity(prev => Math.max(MIN_QUANTITY, prev - 1));
  };

  const totalPrice = quantity * PRICE_PER_ORDER;

  // Show focused view based on plan param
  const showResellerOnly = plan === 'reseller';
  const showPerOrderOnly = plan === 'perOrder';

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>API Access</h1>
            <p>Upgrade to unlock unlimited API access and order processing.</p>
          </div>
        </div>

        {/* Available Orders Section - only show if not focusing on a specific plan */}
        {!showPerOrderOnly && !showResellerOnly && (
          <section className="billing-section">
            <h2>Available Orders</h2>
            <div className="orders-remaining-card">
              <div className="orders-remaining-value">
                {isReseller ? (
                  <span className="unlimited-badge">Unlimited</span>
                ) : (
                  <span>{remainingOrders ?? 0} remaining out of {totalOrders ?? 0}</span>
                )}
              </div>
              {!isReseller && remainingOrders === 0 && (
                <button className="btn primary" onClick={handleTopUp}>
                  Top Up
                </button>
              )}
            </div>
          </section>
        )}

        {/* Plan Comparison */}
        <section className="billing-section">
          <h2>{showResellerOnly ? 'Reseller Plan' : showPerOrderOnly ? 'Pay As You Go' : 'Choose Your Plan'}</h2>
          <div className={`plans-grid ${showResellerOnly || showPerOrderOnly ? 'single-plan' : ''}`}>
            {/* Reseller Plan */}
            {(!showPerOrderOnly) && (
              <div className={`plan-card ${showResellerOnly ? 'focused' : ''}`}>
                <div className="plan-header">
                  <h3>Reseller Plan</h3>
                  <div className="plan-price">
                    <span className="price-amount">$299</span>
                    <span className="price-period">/mo</span>
                  </div>
                </div>
                <ul className="plan-features">
                  <li>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                    Unlimited Orders
                  </li>
                  <li>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                    Multiple Order Processing
                  </li>
                  <li>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                    Unlimited API Access
                  </li>
                </ul>
                <button
                  className="btn primary plan-btn"
                  onClick={handleUpgrade}
                  disabled={loading}
                >
                  {loading ? 'Processing...' : showResellerOnly ? 'Start Reseller Plan' : 'Upgrade'}
                </button>
                {!showResellerOnly && (
                  <a href="/api-billing?plan=perOrder" className="plan-alt-link">
                    Or pay per order instead
                  </a>
                )}
              </div>
            )}

            {/* Pay As You Go Plan */}
            {(!showResellerOnly) && (
              <div className={`plan-card ${showPerOrderOnly ? 'focused' : ''}`}>
                <div className="plan-header">
                  <h3>Pay As You Go</h3>
                  <div className="plan-price">
                    <span className="price-amount">$14</span>
                    <span className="price-period">/order</span>
                  </div>
                </div>
                <ul className="plan-features">
                  <li>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                    Pay Per Order
                  </li>
                  <li>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                    Multiple Order Processing
                  </li>
                  <li>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                    Unlimited API Access
                  </li>
                </ul>
                <button
                  className={showPerOrderOnly ? 'btn primary plan-btn' : 'btn ghost plan-btn'}
                  onClick={() => setTopUpModal(true)}
                >
                  {showPerOrderOnly ? 'Add Credits' : 'Add Credits'}
                </button>
                {!showPerOrderOnly && (
                  <a href="/api-billing?plan=reseller" className="plan-alt-link">
                    Or get unlimited with Reseller Plan
                  </a>
                )}
              </div>
            )}
          </div>
        </section>

        {error && <div className="alert error">{error}</div>}

        {/* Top Up Modal */}
        {topUpModal && (
          <div className="modal-overlay" onClick={() => setTopUpModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h3>Add Credits</h3>
                <button className="icon-btn" onClick={() => setTopUpModal(false)} title="Close">X</button>
              </div>
              <div className="modal-body">
                <div className="quantity-selector">
                  <label>Number of Orders</label>
                  <div className="quantity-controls">
                    <button
                      className="quantity-btn"
                      onClick={decrementQuantity}
                      disabled={quantity <= MIN_QUANTITY}
                    >
                      -
                    </button>
                    <span className="quantity-value">{quantity}</span>
                    <button
                      className="quantity-btn"
                      onClick={incrementQuantity}
                    >
                      +
                    </button>
                  </div>
                  <p className="helper-text">Minimum {MIN_QUANTITY} orders</p>
                </div>
                <div className="total-price">
                  <span>Total</span>
                  <span className="price-value">${totalPrice}</span>
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn ghost" onClick={() => setTopUpModal(false)}>
                  Cancel
                </button>
                <button
                  className="btn primary"
                  onClick={handleAddCredits}
                  disabled={loading}
                >
                  {loading ? 'Processing...' : 'Add Credits'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Back link */}
        <div className="billing-back">
          <button className="btn ghost" onClick={() => window.history.back()}>
            Back
          </button>
        </div>
      </main>
    </div>
  );
}