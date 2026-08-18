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
 subheadline: 'Pay the open invoice to restore access.'
 };
 }

 // Every entry point for an account without access leads to the same initial
 // Whop checkout. Keep the offer copy in sync with that checkout, even when a
 // caller uses the legacy "standard" intent or visits /billing directly.
 if (!billing?.canAccessApp) {
 const usedIntroOffer = billing?.introOfferUsed || billing?.needsPaidSubscription;
 return {
 kind: 'initial',
 headline: 'No Active Subscription Found',
 subheadline: usedIntroOffer
 ? 'Create 100 inboxes and send 15,000 cold emails for $9.99.'
 : 'Create 100 inboxes and send 15,000 cold emails for just $1.',
 description: usedIntroOffer
 ? '$9.99 is billed every four weeks. Cancel anytime in one click.'
 : '$9.99 will be charged after the five-day free trial. Cancel anytime in one click.',
 price: usedIntroOffer ? '$9.99' : '$1',
 priceLabel: usedIntroOffer ? 'Every four weeks' : 'Today for five days'
 };
 }

 if (intent === 'unlimited') {
 return {
 kind: 'upgrade',
 headline: 'Upgrade To Access Advanced',
 subheadline: 'Unlimited parallel order processing.'
 };
 }

 if (intent === 'trial' || intent === 'starter') {
 const usedIntroOffer = billing?.introOfferUsed || billing?.needsPaidSubscription;
 return {
 kind: 'initial',
 headline: 'No Active Subscription Found',
 subheadline: usedIntroOffer
 ? 'Create 100 inboxes and send 15,000 cold emails for $9.99.'
 : 'Create 100 inboxes and send 15,000 cold emails for just $1.',
 description: usedIntroOffer
 ? '$9.99 is billed every four weeks. Cancel anytime in one click.'
 : '$9.99 will be charged after the five-day free trial. Cancel anytime in one click.'
 };
 }

 if (intent === 'concurrent') {
 return {
 kind: 'upgrade',
 headline: 'Add Multiple Order Processing',
 subheadline: 'Run multiple orders simultaneously for $29 per month.'
 };
 }

 if (billing?.blockingReason) {
 return {
 kind: 'initial',
 headline: 'No Active Subscription Found',
 subheadline: 'Create 100 inboxes and send 15,000 cold emails for just $1.',
 description: '$9.99 will be charged after the five-day free trial. Cancel anytime in one click.',
 price: '$1',
 priceLabel: 'Today for five days'
 };
 }

 return {
 kind: 'upgrade',
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
 <div className={`billing-page-shell billing-page-shell--${copy.kind}`}>
 <section className="billing-offer-panel">
 <div className="billing-offer-eyebrow">
 <span aria-hidden="true" />
 {copy.kind === 'initial'
 ? 'Introductory Access'
 : copy.kind === 'overdue'
 ? 'Account Billing'
 : 'Unlimited Inboxes'}
 </div>
 <div className="billing-page-copy">
 <h1>{copy.headline}</h1>
 {copy.subheadline ? <p>{copy.subheadline}</p> : null}
 </div>

 {copy.kind === 'initial' ? (
 <>
 <div className="billing-offer-price" aria-label={`${copy.price}, ${copy.priceLabel}`}>
 <strong>{copy.price}</strong>
 <span>{copy.priceLabel}</span>
 </div>
 <ul className="billing-offer-features">
 <li>100 Outlook Inboxes</li>
 <li>15,000 Cold Emails</li>
 <li>Cancel Anytime</li>
 </ul>
 {copy.description ? (
 <p className="billing-page-description">{copy.description}</p>
 ) : null}
 </>
 ) : null}
 </section>

 {loading || !billing ? (
 <section className="billing-checkout-card billing-page-loading">
 <div className="spinner" />
 <p>Checking your billing status...</p>
 </section>
 ) : intent === 'retry' || billing?.blockingReason === 'payment_overdue' ? (
 <OverdueInvoiceRecovery
 billing={billing}
 refreshBilling={refreshBilling}
 />
 ) : (
 <section className="billing-checkout-card">
 <header className="billing-checkout-heading">
 <div className="billing-security-mark" aria-hidden="true">
 <svg viewBox="0 0 24 24" fill="none">
 <path d="M7.5 10V7.75a4.5 4.5 0 0 1 9 0V10M6.75 10h10.5A1.75 1.75 0 0 1 19 11.75v7.5A1.75 1.75 0 0 1 17.25 21H6.75A1.75 1.75 0 0 1 5 19.25v-7.5A1.75 1.75 0 0 1 6.75 10Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
 </svg>
 </div>
 <div>
 <h2>Secure Checkout</h2>
 <p>Complete your billing details to activate access.</p>
 </div>
 </header>
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
