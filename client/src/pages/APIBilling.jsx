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
  const [mounted, setMounted] = useState(false);

  const plan = (() => {
    const raw = searchParams.get('plan');
    return VALID_PLANS.has(raw) ? raw : null;
  })();

  const isReseller = Boolean(billing?.isReseller);
  const remainingOrders = billing?.remainingOrders;
  const totalOrders = billing?.totalOrders;
  const canAccessApi = billing?.canAccessApi;

  useEffect(() => {
    void refreshBilling({ force: true, minIntervalMs: 0 });
    setMounted(true);
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

  const showResellerOnly = plan === 'reseller';
  const showPerOrderOnly = plan === 'perOrder';

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content api-billing">
        {/* Ambient background effects */}
        <div className="api-billing-bg">
          <div className="bg-gradient-1" />
          <div className="bg-gradient-2" />
          <div className="bg-grid" />
        </div>

        <div className={`api-billing-container ${mounted ? 'mounted' : ''}`}>
          {/* Header Section */}
          <header className="api-billing-header">
            <div className="header-badge">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
              </svg>
              API Access
            </div>
            <h1 className="header-title">
              Unlock Enterprise-Grade
              <span className="title-accent"> API Access</span>
            </h1>
            <p className="header-subtitle">
              Scale your operations with unlimited API calls, multi-order processing, and dedicated infrastructure.
            </p>

            {/* Trust indicators */}
            <div className="trust-badges">
              <div className="trust-badge">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  <path d="M9 12l2 2 4-4"/>
                </svg>
                SOC 2 Compliant
              </div>
              <div className="trust-badge">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10"/>
                  <path d="M12 6v6l4 2"/>
                </svg>
                99.99% Uptime SLA
              </div>
              <div className="trust-badge">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
                24/7 Support
              </div>
            </div>
          </header>

          {/* Available Orders Section */}
          {!showPerOrderOnly && !showResellerOnly && (
            <section className="orders-status-section">
              <div className="orders-status-card">
                <div className="status-icon">
                  {isReseller ? (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
                    </svg>
                  ) : (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="3" width="18" height="18" rx="2"/>
                      <path d="M3 9h18M9 21V9"/>
                    </svg>
                  )}
                </div>
                <div className="status-content">
                  <span className="status-label">Available Orders</span>
                  <div className="status-value">
                    {isReseller ? (
                      <span className="unlimited-text">Unlimited</span>
                    ) : (
                      <span className="orders-count">{remainingOrders ?? 0}</span>
                    )}
                    {!isReseller && totalOrders > 0 && (
                      <span className="orders-total">/ {totalOrders}</span>
                    )}
                  </div>
                </div>
                {!isReseller && remainingOrders === 0 && (
                  <button className="btn-topup" onClick={handleTopUp}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 5v14M5 12h14"/>
                    </svg>
                    Top Up
                  </button>
                )}
              </div>
            </section>
          )}

          {/* Plan Comparison */}
          <section className="plans-section">
            <h2 className="plans-title">
              {showResellerOnly ? 'Reseller Plan' : showPerOrderOnly ? 'Pay As You Go' : 'Choose Your Plan'}
            </h2>
            <p className="plans-subtitle">
              {showResellerOnly ? 'Everything you need to scale' : showPerOrderOnly ? 'Flexible pay-as-you-grow pricing' : 'Select the plan that fits your needs'}
            </p>

            <div className={`plans-grid ${showResellerOnly || showPerOrderOnly ? 'single-plan' : ''}`}>
              {/* Reseller Plan */}
              {!showPerOrderOnly && (
                <div className={`plan-card reseller ${showResellerOnly ? 'focused' : ''}`}>
                  <div className="plan-glow" />
                  <div className="plan-badge">Most Popular</div>

                  <div className="plan-header">
                    <h3>Reseller Plan</h3>
                    <div className="plan-pricing">
                      <span className="price-main">$299</span>
                      <span className="price-period">/mo</span>
                    </div>
                    <p className="plan-tagline">For agencies and high-volume operators</p>
                  </div>

                  <ul className="plan-features">
                    <li className="feature-item">
                      <span className="feature-icon">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                          <polyline points="22 4 12 14.01 9 11.01"/>
                        </svg>
                      </span>
                      <span className="feature-text">Unlimited Orders</span>
                      <span className="feature-tag">No limits</span>
                    </li>
                    <li className="feature-item">
                      <span className="feature-icon">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                          <polyline points="22 4 12 14.01 9 11.01"/>
                        </svg>
                      </span>
                      <span className="feature-text">Multiple Order Processing</span>
                      <span className="feature-tag">Parallel</span>
                    </li>
                    <li className="feature-item">
                      <span className="feature-icon">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                          <polyline points="22 4 12 14.01 9 11.01"/>
                        </svg>
                      </span>
                      <span className="feature-text">Unlimited API Access</span>
                      <span className="feature-tag">REST + Webhooks</span>
                    </li>
                    <li className="feature-item">
                      <span className="feature-icon">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                          <polyline points="22 4 12 14.01 9 11.01"/>
                        </svg>
                      </span>
                      <span className="feature-text">Dedicated Support</span>
                      <span className="feature-tag">Priority</span>
                    </li>
                  </ul>

                  <button
                    className={`plan-cta ${showResellerOnly ? 'primary' : ''}`}
                    onClick={handleUpgrade}
                    disabled={loading}
                  >
                    <span className="cta-text">
                      {loading ? (
                        <>
                          <span className="spinner-small" />
                          Processing...
                        </>
                      ) : (
                        <>
                          Start Reseller Plan
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M5 12h14M12 5l7 7-7 7"/>
                          </svg>
                        </>
                      )}
                    </span>
                  </button>

                  {!showResellerOnly && (
                    <a href="/api-billing?plan=perOrder" className="plan-alt-link">
                      Or pay per order instead
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M9 18l6-6-6-6"/>
                      </svg>
                    </a>
                  )}
                </div>
              )}

              {/* Pay As You Go Plan */}
              {!showResellerOnly && (
                <div className={`plan-card paygo ${showPerOrderOnly ? 'focused' : ''}`}>
                  <div className="plan-header">
                    <h3>Pay As You Go</h3>
                    <div className="plan-pricing">
                      <span className="price-main">$14</span>
                      <span className="price-period">/order</span>
                    </div>
                    <p className="plan-tagline">Pay only for what you use</p>
                  </div>

                  <ul className="plan-features">
                    <li className="feature-item">
                      <span className="feature-icon">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                          <polyline points="22 4 12 14.01 9 11.01"/>
                        </svg>
                      </span>
                      <span className="feature-text">Pay Per Order</span>
                      <span className="feature-tag">No commitment</span>
                    </li>
                    <li className="feature-item">
                      <span className="feature-icon">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                          <polyline points="22 4 12 14.01 9 11.01"/>
                        </svg>
                      </span>
                      <span className="feature-text">Multiple Order Processing</span>
                      <span className="feature-tag">Parallel</span>
                    </li>
                    <li className="feature-item">
                      <span className="feature-icon">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                          <polyline points="22 4 12 14.01 9 11.01"/>
                        </svg>
                      </span>
                      <span className="feature-text">Unlimited API Access</span>
                      <span className="feature-tag">REST + Webhooks</span>
                    </li>
                    <li className="feature-item">
                      <span className="feature-icon">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                          <polyline points="22 4 12 14.01 9 11.01"/>
                        </svg>
                      </span>
                      <span className="feature-text">Scale Up Anytime</span>
                      <span className="feature-tag">Instant</span>
                    </li>
                  </ul>

                  <button
                    className={`plan-cta ${showPerOrderOnly ? 'primary' : ''}`}
                    onClick={() => setTopUpModal(true)}
                  >
                    <span className="cta-text">
                      Add Credits
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 5v14M5 12h14"/>
                      </svg>
                    </span>
                  </button>

                  {!showPerOrderOnly && (
                    <a href="/api-billing?plan=reseller" className="plan-alt-link">
                      Or get unlimited with Reseller Plan
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M9 18l6-6-6-6"/>
                      </svg>
                    </a>
                  )}
                </div>
              )}
            </div>

            {/* Money-back guarantee */}
            <div className="guarantee-badge">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              </svg>
              <span>30-day money-back guarantee on all plans</span>
            </div>
          </section>

          {error && (
            <div className="alert-error">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="15" y1="9" x2="9" y2="15"/>
                <line x1="9" y1="9" x2="15" y2="15"/>
              </svg>
              {error}
            </div>
          )}

          {/* Back link */}
          <div className="billing-back">
            <button className="btn-back" onClick={() => window.history.back()}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M19 12H5M12 19l-7-7 7-7"/>
              </svg>
              Back
            </button>
          </div>
        </div>

        {/* Top Up Modal */}
        {topUpModal && (
          <div className="modal-overlay" onClick={() => setTopUpModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-glow" />
              <div className="modal-content">
                <button className="modal-close" onClick={() => setTopUpModal(false)}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18"/>
                    <line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>

                <div className="modal-header">
                  <div className="modal-icon">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <rect x="3" y="3" width="18" height="18" rx="2"/>
                      <path d="M3 9h18M9 21V9"/>
                    </svg>
                  </div>
                  <h3>Add Order Credits</h3>
                  <p>Purchase additional order credits for your Pay As You Go plan</p>
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
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M5 12h14"/>
                        </svg>
                      </button>
                      <span className="quantity-value">{quantity}</span>
                      <button
                        className="quantity-btn"
                        onClick={incrementQuantity}
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M12 5v14M5 12h14"/>
                        </svg>
                      </button>
                    </div>
                    <p className="helper-text">Minimum {MIN_QUANTITY} orders per purchase</p>
                  </div>

                  <div className="price-summary">
                    <div className="price-row">
                      <span>{quantity} orders × $14</span>
                      <span>${totalPrice}</span>
                    </div>
                    <div className="price-divider" />
                    <div className="price-total">
                      <span>Total</span>
                      <span className="total-value">${totalPrice}</span>
                    </div>
                  </div>
                </div>

                <div className="modal-footer">
                  <button className="btn-cancel" onClick={() => setTopUpModal(false)}>
                    Cancel
                  </button>
                  <button
                    className="btn-submit"
                    onClick={handleAddCredits}
                    disabled={loading}
                  >
                    {loading ? (
                      <>
                        <span className="spinner-small" />
                        Processing...
                      </>
                    ) : (
                      <>
                        Add ${totalPrice} Credits
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M5 12h14M12 5l7 7-7 7"/>
                        </svg>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}