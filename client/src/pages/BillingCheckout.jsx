import { useEffect, useMemo } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import BillingCheckoutEmbed from '../components/BillingCheckoutEmbed';
import { useBilling } from '../context/BillingContext';

const VALID_INTENTS = new Set(['trial', 'starter', 'growth', 'unlimited', 'retry', 'concurrent']);

function getBillingCopy(intent, billing) {
 if (intent === 'retry' || billing?.blockingReason === 'payment_overdue') {
 return {
 headline: 'Invoice Overdue',
 subheadline: 'Pay the open invoice to restore access'
 };
 }

 if (intent === 'unlimited') {
 return {
 headline: 'Upgrade To Access Advanced',
 subheadline: 'Unlimited Parallel Order Processing'
 };
 }

 if (intent === 'trial' || intent === 'starter') {
 return {
 headline: '100 inboxes for $1 today',
 subheadline: 'One secure checkout. Your saved card is charged $49.99 after 7 days, then every 4 weeks until cancelled.'
 };
 }

 if (intent === 'concurrent') {
 return {
 headline: 'Add Multiple Order Processing',
 subheadline: 'Run multiple orders simultaneously for $29/month'
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

function OverdueInvoiceRecovery({ billing, refreshBilling }) {
 const invoiceUrl = billing?.invoiceUrl;
 const invoiceId = billing?.invoiceId;

 return (
 <div className="billing-overdue-panel">
 <div className="alert error billing-page-alert">
 Invoice overdue. Access is paused until the open payment is settled.
 {invoiceId && <span style={{ display: 'block', fontSize: '0.85em', marginTop: '4px', opacity: 0.8 }}>Invoice: {invoiceId}</span>}
 </div>
 <div className="billing-overdue-actions">
 {invoiceUrl && (
 <a
 className="btn primary"
 href={invoiceUrl}
 target="_blank"
 rel="noopener noreferrer"
 style={{ textDecoration: 'none', marginRight: '8px' }}
 >
 Pay Invoice
 </a>
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
 const { billing, loading, refreshBilling } = useBilling();

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

 if (location.pathname === '/billing' && billing.canAccessApp) {
 redirectToOrders();
 }
 }, [billing, location.pathname]);

 return (
 <main className="billing-page">
 <div className="billing-page-shell">
 <div className="billing-page-copy">
 <h1>{copy.headline}</h1>
 {copy.subheadline ? <p>{copy.subheadline}</p> : null}
 </div>

 {loading || !billing ? (
 <div className="billing-page-loading">
 <div className="spinner" />
 <p>Checking your billing status...</p>
 </div>
 ) : intent === 'retry' || billing?.blockingReason === 'payment_overdue' ? (
 <OverdueInvoiceRecovery
 billing={billing}
 refreshBilling={refreshBilling}
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
