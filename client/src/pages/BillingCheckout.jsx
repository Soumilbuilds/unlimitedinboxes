import { useEffect, useMemo } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import BillingCheckoutEmbed from '../components/BillingCheckoutEmbed';
import { useBilling } from '../context/BillingContext';

const VALID_INTENTS = new Set(['trial', 'starter', 'growth', 'unlimited', 'retry', 'concurrent']);

function getBillingCopy(intent, billing) {
 if (intent === 'retry' || billing?.blockingReason === 'payment_overdue') {
 return {
 kind: 'overdue',
 headline: 'Invoice Overdue',
 primaryLine: 'Pay the open invoice to restore access.'
 };
 }

 // Every entry point for an account without access leads to the same initial
 // Whop checkout. Keep the offer copy in sync with that checkout, even when a
 // caller uses the legacy "standard" intent or visits /billing directly.
 if (!billing?.canAccessApp) {
 const usedIntroOffer = billing?.introOfferUsed || billing?.needsPaidSubscription;
 return {
 kind: 'initial',
 headline: usedIntroOffer
 ? 'Create 100 Inboxes And Send 15,000 Emails For $9.99'
 : 'Create 100 Inboxes And Send 15,000 Emails For Free',
 primaryLine: 'No Active Subscription Found',
 terms: usedIntroOffer
 ? ['$9.99 Every 4 Weeks', '1 Click Cancel']
 : ['5 Day Free Trial', '$1 Authorisation Amount (Refunded)', '$9/mo After Trial', '1 Click Cancel', 'No Charge During Trial']
 };
 }

 if (intent === 'unlimited') {
 return {
 kind: 'upgrade',
 headline: 'Upgrade To Access Advanced',
 primaryLine: 'Unlimited parallel order processing.'
 };
 }

 if (intent === 'trial' || intent === 'starter') {
 const usedIntroOffer = billing?.introOfferUsed || billing?.needsPaidSubscription;
 return {
 kind: 'initial',
 headline: usedIntroOffer
 ? 'Create 100 Inboxes And Send 15,000 Emails For $9.99'
 : 'Create 100 Inboxes And Send 15,000 Emails For Free',
 primaryLine: 'No Active Subscription Found',
 terms: usedIntroOffer
 ? ['$9.99 Every 4 Weeks', '1 Click Cancel']
 : ['5 Day Free Trial', '$1 Authorisation Amount (Refunded)', '$9/mo After Trial', '1 Click Cancel', 'No Charge During Trial']
 };
 }

 if (intent === 'concurrent') {
 return {
 kind: 'upgrade',
 headline: 'Add Multiple Order Processing',
 primaryLine: 'Run multiple orders simultaneously for $29 per month.'
 };
 }

 if (billing?.blockingReason) {
 return {
 kind: 'initial',
 headline: 'Create 100 Inboxes And Send 15,000 Emails For Free',
 primaryLine: 'No Active Subscription Found',
 terms: ['5 Day Free Trial', '$1 Authorisation Amount (Refunded)', '$9/mo After Trial', '1 Click Cancel', 'No Charge During Trial']
 };
 }

 return {
 kind: 'upgrade',
 headline: 'Upgrade And Get Limitless Access',
 primaryLine: ''
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
 <div className={`billing-page-shell billing-page-shell--${copy.kind}`}>
 <header className="billing-page-header">
 <div className="billing-page-copy">
 <h1>{copy.headline}</h1>
 {copy.primaryLine ? <p>{copy.primaryLine}</p> : null}
 </div>

 {copy.terms?.length ? (
 <div className="billing-page-terms" aria-label={copy.terms.join(', ')}>
 {copy.terms.map((term) => <span key={term}>{term}</span>)}
 </div>
 ) : null}
 </header>

 {loading || !billing ? (
 <section className="billing-page-loading">
 <div className="spinner" />
 <p>Checking your billing status...</p>
 </section>
 ) : intent === 'retry' || billing?.blockingReason === 'payment_overdue' ? (
 <OverdueInvoiceRecovery
 billing={billing}
 refreshBilling={refreshBilling}
 />
 ) : (
 <section className="billing-checkout-surface">
 <BillingCheckoutEmbed
 billing={billing}
 intent={intent === 'standard' ? 'starter' : intent}
 onSynced={() => {
 redirectToOrders();
 }}
 onError={(_message, error) => {
 if (error?.response?.status === 409) {
 redirectToOrders();
 }
 }}
 />
 </section>
 )}
 </div>
 </main>
 );
}
