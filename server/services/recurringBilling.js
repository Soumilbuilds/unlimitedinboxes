import crypto from 'crypto';
import {
  claimDueManagedBillingCycle,
  completeManagedBillingCycle,
  getUserById,
  retryManagedBillingCycle,
  updateUserBillingById,
} from '../db/database.js';
import { PLANS, listLivePaymentMethods, xpay } from './xpay.js';

export const MANAGED_BILLING_INTERVAL_DAYS = 28;
export const MANAGED_BILLING_MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [
  6 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
  72 * 60 * 60 * 1000,
];
const DEFAULT_LEASE_MS = 2 * 60 * 1000;

function addDays(value, days) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

export function isSuccessfulTokenizedCharge(result) {
  const charge = result?.data || result || {};
  return String(charge.status || '').toUpperCase() === 'SUCCESS';
}

export function buildManagedChargePayload(cycle) {
  return {
    pmId: cycle.xpay_default_payment_method_id,
    customerId: cycle.xpay_customer_id,
    currency: String(cycle.currency || 'USD').toUpperCase(),
    amount: Number(cycle.amount_cents),
    receiptId: cycle.receipt_id,
    metadata: {
      purpose: 'starter_recurring_charge',
      user_id: String(cycle.user_id),
      cycle_number: String(cycle.cycle_number),
    },
  };
}

function retryAt(now, priorAttemptCount) {
  const delay = RETRY_DELAYS_MS[Math.min(priorAttemptCount, RETRY_DELAYS_MS.length - 1)];
  return new Date(new Date(now).getTime() + delay);
}

export async function processManagedBillingCycle(cycle, {
  client = xpay,
  now = new Date(),
  complete = completeManagedBillingCycle,
  retry = retryManagedBillingCycle,
  getLatestUser = getUserById,
} = {}) {
  if (!cycle.xpay_recurring_enabled || cycle.xpay_cancel_at_period_end) {
    return { skipped: true, reason: 'recurring_disabled' };
  }

  if (cycle.xpay_customer_id && !cycle.xpay_default_payment_method_id) {
    try {
      const methods = await listLivePaymentMethods(client, cycle.xpay_customer_id);
      const method = methods[0];
      const pmId = method?.paymentMethodId || method?.pmId || method?.id;
      if (pmId) {
        cycle.xpay_default_payment_method_id = String(pmId);
        updateUserBillingById(cycle.user_id, {
          xpay_default_payment_method_id: String(pmId),
        });
      }
    } catch (error) {
      console.warn('[billing-worker] Could not reconcile payment method token:', error.message);
    }
  }

  const latestUser = getLatestUser(cycle.user_id);
  if (!latestUser?.xpay_recurring_enabled || latestUser?.xpay_cancel_at_period_end) {
    return { skipped: true, reason: 'recurring_disabled' };
  }

  if (!cycle.xpay_customer_id || !cycle.xpay_default_payment_method_id) {
    retry(cycle.id, {
      error: 'No live payment method is available for this customer.',
      nextAttemptAt: retryAt(now, cycle.attempt_count),
      terminal: true,
    });
    return { success: false, actionRequired: true, reason: 'missing_payment_method' };
  }

  try {
    const response = await client.request(
      'POST',
      '/payments/charge-tokenised-pm',
      buildManagedChargePayload(cycle),
      cycle.idempotency_key
    );
    const charge = response?.data || response || {};
    const intentId = charge.intentId || charge.xIntentId || charge.id || null;

    if (!isSuccessfulTokenizedCharge(charge)) {
      const nextAttemptCount = Number(cycle.attempt_count || 0) + 1;
      retry(cycle.id, {
        error: charge.errorDescription || charge.errorCode || charge.message || `xPay status: ${charge.status || 'unknown'}`,
        nextAttemptAt: retryAt(now, cycle.attempt_count),
        terminal: nextAttemptCount >= MANAGED_BILLING_MAX_ATTEMPTS,
        providerIntentId: intentId,
      });
      return { success: false, intentId, status: charge.status || null };
    }

    const nextDueAt = addDays(cycle.due_at, MANAGED_BILLING_INTERVAL_DAYS);
    complete(cycle.id, {
      providerIntentId: intentId,
      paidAt: now,
      nextDueAt,
      intervalAmountCents: PLANS.starter.amountCents,
    });
    return { success: true, intentId, nextDueAt: nextDueAt.toISOString() };
  } catch (error) {
    const nextAttemptCount = Number(cycle.attempt_count || 0) + 1;
    retry(cycle.id, {
      error: error.message || 'xPay charge request failed.',
      nextAttemptAt: retryAt(now, cycle.attempt_count),
      terminal: error.status >= 400 && error.status < 500
        ? nextAttemptCount >= MANAGED_BILLING_MAX_ATTEMPTS
        : false,
    });
    return { success: false, retrying: true, error };
  }
}

export function createManagedBillingWorker({
  client = xpay,
  intervalMs = Math.max(Number(process.env.BILLING_WORKER_INTERVAL_MS || 60000) || 60000, 10000),
  leaseMs = Math.max(Number(process.env.BILLING_WORKER_LEASE_MS || DEFAULT_LEASE_MS) || DEFAULT_LEASE_MS, 60000),
  enabled = process.env.BILLING_WORKER_ENABLED !== 'false',
  now = () => new Date(),
  claim = claimDueManagedBillingCycle,
} = {}) {
  const lockOwner = `${process.pid}.${crypto.randomUUID()}`;
  let running = false;
  let timer = null;

  async function tick() {
    if (!enabled || running || !client.configured) return;
    running = true;
    try {
      while (true) {
        const current = now();
        const cycle = claim({
          now: current.toISOString(),
          staleBefore: new Date(current.getTime() - leaseMs).toISOString(),
          lockOwner,
        });
        if (!cycle) break;
        await processManagedBillingCycle(cycle, { client, now: current });
      }
    } catch (error) {
      console.error('[billing-worker] Tick failed:', error);
    } finally {
      running = false;
    }
  }

  function start() {
    if (!enabled) {
      console.log('Managed billing worker disabled.');
      return null;
    }
    void tick();
    timer = setInterval(() => void tick(), intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, tick };
}
