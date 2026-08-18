import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { WhopCheckoutEmbed } from '@whop/checkout/react';
import Sidebar from '../components/Sidebar';
import api from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useBilling } from '../context/BillingContext';

const PLAN_CATALOG = [
  {
    id: 'trial', name: 'Free Trial', priceCents: 0, inboxes: '10 Downloadable Inboxes', sends: '1,500 Cold Emails',
    concurrent: 'Run One Order At Once', ai: false, redirects: false, customNames: false
  },
  {
    id: 'basic', name: 'Tester', priceCents: 999, inboxes: '100 Inboxes', sends: '15,000 Cold Emails',
    concurrent: 'Run One Order At Once', ai: true, redirects: true, customNames: true
  },
  {
    id: 'starter', name: 'Growth', priceCents: 3999, inboxes: '500 Inboxes', sends: '75,000 Cold Emails',
    concurrent: 'Run One Order At Once', ai: true, redirects: true, customNames: true
  },
  {
    id: 'growth', name: 'Pro', priceCents: 9999, inboxes: '1,500 Inboxes', sends: '225,000 Cold Emails',
    concurrent: 'Run One Order At Once', ai: true, redirects: true, customNames: true
  },
  {
    id: 'unlimited', name: 'Scale', priceCents: 19999, inboxes: 'Unlimited Inboxes', sends: 'Unlimited Cold Emails',
    concurrent: 'Run One Order At Once', ai: true, redirects: true, customNames: true
  },
  {
    id: 'agency', name: 'Reseller', priceCents: 29999, inboxes: 'Unlimited Inboxes', sends: 'Unlimited Cold Emails',
    concurrent: 'Run Unlimited Orders Simultaneously', ai: true, redirects: true, customNames: true
  }
];

const TIER_ORDER = Object.fromEntries(PLAN_CATALOG.map((plan, index) => [plan.id, index]));

function money(cents) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 2
  }).format((Number(cents) || 0) / 100);
}

function normalizeCurrentPlan(value) {
  const normalized = String(value || '').toLowerCase();
  const aliases = { tester: 'basic', growth_plan: 'growth', pro: 'growth', scale: 'unlimited', reseller: 'agency' };
  return aliases[normalized] || normalized;
}

function Feature({ available = true, children }) {
  return (
    <li className={available ? '' : 'is-unavailable'}>
      <span aria-hidden="true">{available ? '✓' : '—'}</span>
      <span>{children}</span>
    </li>
  );
}

function PlanCheckout({ sessionId, user, billing, promoCode, onComplete, onError }) {
  const storedAddress = billing?.billingAddress;
  const address = storedAddress ? {
    name: storedAddress.name || storedAddress.fullName || storedAddress.full_name || '',
    country: storedAddress.country || storedAddress.countryCode || storedAddress.country_code || '',
    line1: storedAddress.line1 || storedAddress.addressLine1 || storedAddress.address_line_1 || '',
    line2: storedAddress.line2 || storedAddress.addressLine2 || storedAddress.address_line_2 || '',
    city: storedAddress.city || '',
    state: storedAddress.state || storedAddress.region || '',
    postalCode: storedAddress.postalCode || storedAddress.postal_code || storedAddress.zip || ''
  } : null;
  const completeAddress = Boolean(
    address?.name && address?.country && address?.line1 && address?.city && address?.state && address?.postalCode
  );

  return (
    <div className="plans-checkout-frame">
      <WhopCheckoutEmbed
        sessionId={sessionId}
        theme="dark"
        themeOptions={{ accentColor: '#86f7b8', backgroundColor: '#090909', borderRadius: 8, buttonText: 'Get Access' }}
        styles={{ container: { paddingX: 0, paddingY: 0 } }}
        prefill={{ email: user?.email, ...(completeAddress ? { address } : {}) }}
        hideEmail
        hideAddressForm={completeAddress}
        setupFutureUsage="off_session"
        promoCode={promoCode || undefined}
        skipRedirect
        returnUrl={`${window.location.origin}/plans`}
        onComplete={(_planId, receiptId, result) => onComplete(result?.receipt_id || receiptId)}
        onPaymentError={({ message }) => onError(message || 'Your payment could not be completed.')}
      />
    </div>
  );
}

export default function Plans() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { billing, loading: billingLoading, refreshBilling } = useBilling();
  const [remotePlans, setRemotePlans] = useState([]);
  const [serverState, setServerState] = useState(null);
  const [selectedPlanId, setSelectedPlanId] = useState('');
  const [coupon, setCoupon] = useState('');
  const [promotion, setPromotion] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [sessionId, setSessionId] = useState('');

  useEffect(() => {
    let active = true;
    api.get('/billing/plans')
      .then(({ data }) => {
        if (!active) return;
        setServerState(data || null);
        if (Array.isArray(data?.plans)) setRemotePlans(data.plans);
      })
      .catch(() => {
        // Billing status still renders the catalog while the plans endpoint is being rolled out.
      });
    return () => { active = false; };
  }, []);

  const plans = useMemo(() => PLAN_CATALOG.map((plan) => {
    const remote = remotePlans.find((candidate) => (
      candidate.id === plan.id || candidate.key === plan.id || candidate.plan === plan.id
    ));
    return remote ? { ...plan, ...remote, id: plan.id, name: plan.name } : plan;
  }), [remotePlans]);

  const rawCurrentPlan = serverState?.currentPlan || serverState?.currentPlanId || serverState?.plan
    || billing?.subscriptionTier || billing?.effectivePlan;
  const currentPlanId = normalizeCurrentPlan(
    typeof rawCurrentPlan === 'object' ? (rawCurrentPlan?.key || rawCurrentPlan?.id) : rawCurrentPlan
  );
  const currentRank = TIER_ORDER[currentPlanId] ?? -1;
  const trialConsumed = Boolean(serverState?.trialConsumed ?? serverState?.introOfferUsed ?? billing?.introOfferUsed);
  const selectedPlan = plans.find((plan) => plan.id === selectedPlanId);
  const selectedIsDowngrade = Boolean(selectedPlan && currentRank > TIER_ORDER[selectedPlan.id]);
  const subtotalCents = Number(promotion?.subtotalCents ?? promotion?.originalPriceCents ?? selectedPlan?.priceCents ?? 0);
  const discountCents = Number(promotion?.discountCents ?? promotion?.savingsCents ?? 0);
  const totalCents = selectedIsDowngrade
    ? 0
    : Number(promotion?.totalCents ?? promotion?.priceCents ?? Math.max(0, subtotalCents - discountCents));

  function choosePlan(plan) {
    setError('');
    setNotice('');
    setCoupon('');
    setPromotion(null);
    setSessionId('');

    if (plan.id === 'trial') {
      if (!trialConsumed && currentPlanId !== 'trial') navigate('/billing?intent=intro');
      return;
    }
    setSelectedPlanId(plan.id);
    window.setTimeout(() => document.querySelector('.plans-change-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  }

  async function applyCoupon() {
    if (!selectedPlan || !coupon.trim()) return;
    setBusy('coupon');
    setError('');
    setPromotion(null);
    try {
      const { data } = await api.post('/billing/plans/coupon', {
        code: coupon.trim().toUpperCase(), plan: selectedPlan.id, planId: selectedPlan.id
      });
      const promo = data?.promo || data;
      setPromotion(promo);
      setCoupon(promo?.code || coupon.trim().toUpperCase());
    } catch (requestError) {
      setError(requestError?.response?.data?.error || 'This coupon could not be applied.');
    } finally {
      setBusy('');
    }
  }

  async function changePlan() {
    if (!selectedPlan) return;
    setBusy('change');
    setError('');
    setNotice('');
    try {
      const { data } = await api.post('/billing/plans/change', {
        plan: selectedPlan.id,
        planId: selectedPlan.id,
        couponCode: promotion?.code || ''
      });
      const checkoutSessionId = data?.sessionId || data?.checkoutSessionId || data?.checkout?.sessionId;
      if (checkoutSessionId) {
        setSessionId(checkoutSessionId);
        setNotice(data?.message || 'Complete Secure Checkout Below.');
        return;
      }
      if (data?.checkoutUrl) {
        window.location.assign(data.checkoutUrl);
        return;
      }
      if (data?.paymentPending && data?.paymentId) {
        await confirmPlanChange(data.paymentId);
        return;
      }
      if (data?.success || data?.paid || data?.current || data?.scheduled) {
        await refreshBilling({ force: true, minIntervalMs: 0 });
        setServerState((current) => ({
          ...current,
          ...(data.account || data.billing || {}),
          currentPlan: data.scheduled ? currentPlanId : (data.currentPlan || selectedPlan.id),
          pendingPlan: data.scheduled ? selectedPlan.id : (data.pendingPlan || null)
        }));
        setNotice(data?.message || (selectedPlan.id === currentPlanId ? 'Your Plan Is Active.' : 'Your Plan Change Is Confirmed.'));
        setSelectedPlanId('');
        return;
      }
      throw new Error('The billing provider did not confirm the plan change.');
    } catch (requestError) {
      setError(requestError?.response?.data?.error || requestError.message || 'Could not change your plan.');
    } finally {
      setBusy('');
    }
  }

  async function confirmPlanChange(paymentId) {
    if (!paymentId || !selectedPlan) {
      setError('Whop did not return a payment reference.');
      return;
    }
    setBusy('confirm');
    setError('');
    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const { data } = await api.post('/billing/plans/change/confirm', {
          planKey: selectedPlan.id,
          plan: selectedPlan.id,
          paymentId,
          receiptId: paymentId
        });
        if (data?.failed) throw new Error(data.error || 'Your payment could not be completed.');
        if (data?.paid || data?.success || data?.current) {
          await refreshBilling({ force: true, minIntervalMs: 0 });
          setServerState((current) => ({ ...current, ...(data.billing || data.account || {}), currentPlan: selectedPlan.id }));
          setSessionId('');
          setSelectedPlanId('');
          setNotice('Your Plan Is Active.');
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
      }
      throw new Error('Whop is still confirming your plan. Please refresh in a moment.');
    } catch (requestError) {
      setError(requestError?.response?.data?.error || 'Your payment is still being confirmed. Please refresh in a moment.');
    } finally {
      setBusy('');
    }
  }

  if (billingLoading && !billing) {
    return <div className="center-screen"><div className="spinner" /></div>;
  }

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content plans-page-main">
        <header className="plans-page-heading">
          <span>Choose Your Plan</span>
          <h1>Plans Built To Match Your Volume</h1>
          <p>Upgrade or downgrade without interrupting your inbox workflow.</p>
        </header>

        {notice && <div className="alert success plans-page-message" role="status">{notice}</div>}
        {error && <div className="alert error plans-page-message" role="alert">{error}</div>}

        <section className="plans-catalog" aria-label="Subscription plans">
          {plans.map((plan) => {
            const rank = TIER_ORDER[plan.id];
            const isCurrent = plan.id === currentPlanId;
            const isTrialConsumed = plan.id === 'trial' && trialConsumed && !isCurrent;
            const isDowngrade = currentRank > rank && plan.id !== 'trial';
            const label = isCurrent
              ? 'Current Plan'
              : (isTrialConsumed ? 'Trial Consumed' : (isDowngrade ? 'Downgrade' : (plan.id === 'trial' ? 'Start Trial' : 'Upgrade')));

            return (
              <article className={`plans-catalog-card ${isCurrent ? 'is-current' : ''}`} key={plan.id}>
                <div className="plans-catalog-head">
                  <h2>{plan.name}</h2>
                  <div className="plans-catalog-price">
                    <strong>{plan.id === 'trial' ? 'Free' : money(plan.priceCents)}</strong>
                    {plan.id !== 'trial' && <span>/ 4 Weeks</span>}
                  </div>
                </div>
                <ul className="plans-feature-list">
                  <Feature>{plan.inboxes}</Feature>
                  <Feature>{plan.sends} / Month</Feature>
                  <Feature>{plan.concurrent}</Feature>
                  <Feature available={plan.ai}>{plan.ai ? 'AI And MCP Access' : 'No AI Or MCP Access'}</Feature>
                  <Feature>SPF, DKIM And DMARC Setup</Feature>
                  <Feature available={plan.redirects}>{plan.redirects ? 'Domain Redirect Setup' : 'No Domain Redirects'}</Feature>
                  <Feature available={plan.customNames}>{plan.customNames ? 'Custom Names Supported' : 'No Custom Names'}</Feature>
                </ul>
                <button
                  className={`plans-plan-action ${isDowngrade ? 'is-downgrade' : ''} ${(isCurrent || isTrialConsumed) ? 'is-disabled' : ''}`}
                  type="button"
                  disabled={isCurrent || isTrialConsumed || Boolean(busy)}
                  onClick={() => choosePlan(plan)}
                >
                  {label}
                </button>
              </article>
            );
          })}
        </section>

        {selectedPlan && (
          <section className="plans-change-panel">
            <div className="plans-change-heading">
              <div>
                <span>{currentRank > TIER_ORDER[selectedPlan.id] ? 'Confirm Downgrade' : 'Confirm Upgrade'}</span>
                <h2>{selectedPlan.name}</h2>
              </div>
              <button type="button" onClick={() => { setSelectedPlanId(''); setSessionId(''); setError(''); }}>Close</button>
            </div>

            {!sessionId ? (
              <>
                {!selectedIsDowngrade && (
                  <div className="plans-coupon-field">
                    <label htmlFor="plan-coupon">Coupon Code</label>
                    <div>
                      <input
                        id="plan-coupon"
                        value={coupon}
                        onChange={(event) => { setCoupon(event.target.value.toUpperCase()); setPromotion(null); setError(''); }}
                        placeholder="Enter Code"
                      />
                      <button type="button" onClick={() => void applyCoupon()} disabled={!coupon.trim() || Boolean(busy)}>
                        {busy === 'coupon' ? 'Applying...' : 'Apply'}
                      </button>
                    </div>
                  </div>
                )}

                <dl className="plans-order-summary">
                  <div><dt>Plan Total</dt><dd>{money(subtotalCents)}</dd></div>
                  <div><dt>{selectedIsDowngrade ? 'Plan Change' : 'Coupon Discount'}</dt><dd>{selectedIsDowngrade ? 'At Period End' : (discountCents ? `−${money(discountCents)}` : '—')}</dd></div>
                  <div className="plans-order-total"><dt>Due Today</dt><dd>{money(totalCents)}</dd></div>
                </dl>

                <button className="plans-confirm-action" type="button" onClick={() => void changePlan()} disabled={Boolean(busy)}>
                  {busy === 'change' ? 'Confirming...' : (currentRank > TIER_ORDER[selectedPlan.id] ? 'Confirm Downgrade' : `Get ${selectedPlan.name}`)}
                </button>
                <p className="plans-change-note">
                  {selectedIsDowngrade
                    ? 'Your current plan remains active until the end of this billing period. The lower plan starts after that.'
                    : 'Upgrades use your saved payment method when available. If it cannot be charged, secure checkout opens here.'}
                </p>
              </>
            ) : (
              <>
                <PlanCheckout
                  sessionId={sessionId}
                  user={user}
                  billing={billing}
                  promoCode={promotion?.code}
                  onComplete={(receiptId) => void confirmPlanChange(receiptId)}
                  onError={setError}
                />
                {busy === 'confirm' && <p className="plans-checkout-status">Confirming Your Plan...</p>}
              </>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
