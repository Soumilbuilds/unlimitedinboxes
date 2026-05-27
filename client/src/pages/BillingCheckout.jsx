import { useEffect, useMemo } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import BillingCheckoutEmbed from '../components/BillingCheckoutEmbed';
import { useBilling } from '../context/BillingContext';

const VALID_INTENTS = new Set(['intro', 'standard', 'advanced']);

function getBillingCopy(intent, billing) {
  if (intent === 'advanced') {
    return {
      headline: 'Upgrade To Access Advanced',
      subheadline: 'Unlimited Parallel Order Processing'
    };
  }

  if (intent === 'intro') {
    return {
      headline: 'No Active Subscription Found',
      subheadline: 'Start Three-Day Free Trial'
    };
  }

  if (billing?.blockingReason) {
    return {
      headline: 'No Active Subscription Found',
      subheadline: 'Upgrade To Continue'
    };
  }

  return {
    headline: 'Upgrade And Get Limitless Access',
    subheadline: ''
  };
}

function redirectToOrders() {
  if (typeof window !== 'undefined') {
    window.location.replace('/orders');
  }
}

export default function BillingCheckout() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { billing, refreshBilling } = useBilling();

  const intent = useMemo(() => {
    const raw = searchParams.get('intent');
    return VALID_INTENTS.has(raw) ? raw : 'standard';
  }, [searchParams]);

  const copy = getBillingCopy(intent, billing);

  useEffect(() => {
    void refreshBilling({ force: true, minIntervalMs: 0 });
  }, []);

  useEffect(() => {
    if (!billing) {
      return;
    }

    if (
      location.pathname === '/billing'
      && !billing.blockingReason
      && intent === 'intro'
      && !billing.isTrialing
      && billing.plan !== 'intro'
    ) {
      redirectToOrders();
    }
  }, [billing, intent, location.pathname]);

  return (
    <main className="billing-page">
      <div className="billing-page-shell">
        <div className="billing-page-copy">
          <h1>{copy.headline}</h1>
          {copy.subheadline ? <p>{copy.subheadline}</p> : null}
        </div>

        <BillingCheckoutEmbed
          intent={intent}
          onSynced={() => {
            redirectToOrders();
          }}
          onError={(_message, error) => {
            if (error?.response?.status === 409) {
              redirectToOrders();
            }
          }}
        />
      </div>
    </main>
  );
}
