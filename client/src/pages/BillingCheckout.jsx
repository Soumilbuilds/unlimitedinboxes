import { useEffect, useMemo } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import BillingCheckoutEmbed from '../components/BillingCheckoutEmbed';
import { useBilling } from '../context/BillingContext';

const VALID_INTENTS = new Set(['intro', 'standard', 'advanced', 'retry']);

function getBillingCopy(intent, billing) {
  if (intent === 'retry' || billing?.blockingReason === 'payment_overdue') {
    return {
      headline: 'Invoice Overdue',
      subheadline: 'Pay the open Stripe invoice to restore access'
    };
  }

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

function OverdueInvoiceRecovery({ billing, refreshBilling, openBillingPortal }) {
  const invoiceUrl = billing?.overdueInvoiceUrl;

  return (
    <div className="billing-overdue-panel">
      <div className="alert error billing-page-alert">
        Invoice overdue. Access is paused until the open Stripe invoice is paid.
      </div>
      <div className="billing-overdue-actions">
        {invoiceUrl ? (
          <a className="btn primary" href={invoiceUrl} target="_blank" rel="noreferrer">
            Pay Overdue Invoice
          </a>
        ) : (
          <button className="btn primary" type="button" onClick={() => void openBillingPortal()}>
            Open Billing Portal
          </button>
        )}
        <button
          className="btn ghost"
          type="button"
          onClick={() => void refreshBilling({ force: true, minIntervalMs: 0 })}
        >
          I Paid, Refresh
        </button>
      </div>
    </div>
  );
}

export default function BillingCheckout() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { billing, refreshBilling, openBillingPortal } = useBilling();

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

        {intent === 'retry' || billing?.blockingReason === 'payment_overdue' ? (
          <OverdueInvoiceRecovery
            billing={billing}
            refreshBilling={refreshBilling}
            openBillingPortal={openBillingPortal}
          />
        ) : (
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
        )}
      </div>
    </main>
  );
}
