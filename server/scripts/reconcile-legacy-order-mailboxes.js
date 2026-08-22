#!/usr/bin/env node
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import {
  addOrderLog,
  getOrderById,
  getTenantById,
  persistCreatedMailboxes,
  setOrderError
} from '../db/database.js';
import { getAppClient, getInitialDomainWithClient } from '../services/graph.js';
import { listSharedMailboxesForDomain } from '../services/exchangePowerShell.js';
import { selectLegacyOrderMailboxes } from '../services/legacyOrderReconciliation.js';

function usage() {
  return 'Usage: node scripts/reconcile-legacy-order-mailboxes.js --order-id <id> (--dry-run | --apply)';
}

export function parseArgs(args) {
  let orderId = null;
  let mode = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--order-id') orderId = Number(args[++index]);
    else if (arg === '--dry-run') mode = mode ? 'invalid' : 'dry-run';
    else if (arg === '--apply') mode = mode ? 'invalid' : 'apply';
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(orderId) || orderId < 1 || !['dry-run', 'apply'].includes(mode)) {
    throw new Error(usage());
  }
  return { orderId, mode };
}

async function resolveOrganizationDomain(tenant) {
  const clientId = process.env.MASTER_CLIENT_ID;
  const clientSecret = process.env.MASTER_CLIENT_SECRET;
  if (!clientId || !clientSecret || !tenant.tenant_id) {
    throw new Error('MASTER_CLIENT_ID, MASTER_CLIENT_SECRET, and the tenant Microsoft ID are required');
  }
  const client = await getAppClient(clientId, clientSecret, tenant.tenant_id);
  const orgDomain = await getInitialDomainWithClient(client);
  if (!orgDomain) throw new Error('Could not resolve the tenant onmicrosoft.com organization domain');
  return orgDomain;
}

export async function reconcileLegacyOrder({ orderId, apply = false }) {
  const order = getOrderById(orderId);
  if (!order) throw new Error(`Order ${orderId} was not found`);
  if (order.status !== 'failed') {
    throw new Error(`Order ${orderId} must be failed before legacy reconciliation (current status: ${order.status})`);
  }
  let persisted;
  try { persisted = JSON.parse(order.created_mailboxes || '[]'); } catch { persisted = null; }
  if (!Array.isArray(persisted) || persisted.length !== 0) {
    throw new Error(`Order ${orderId} already has persisted mailbox state; refusing to overwrite it`);
  }
  const tenant = getTenantById(order.tenant_id);
  if (!tenant) throw new Error(`Tenant ${order.tenant_id} was not found`);
  const orgDomain = await resolveOrganizationDomain(tenant);
  const inventory = await listSharedMailboxesForDomain({ orgDomain, domain: tenant.domain });
  const result = selectLegacyOrderMailboxes({
    mailboxes: inventory,
    domain: tenant.domain,
    totalMailboxes: order.total_mailboxes,
    mailboxPassword: order.mailbox_password
  });

  if (apply) {
    persistCreatedMailboxes(order.id, result.selected);
    const message = `Recovered ${result.selected.length} legacy mailbox checkpoints from Exchange. The order is ready for a safe retry.`;
    setOrderError(order.id, message);
    addOrderLog(order.id, message);
  }
  return {
    orderId: order.id,
    domain: tenant.domain,
    organizationDomain: orgDomain,
    candidateCount: result.candidateCount,
    selected: result.selected.map(({ name, email, objectId }) => ({ name, email, objectId })),
    applied: apply
  };
}

async function main() {
  const { orderId, mode } = parseArgs(process.argv.slice(2));
  const result = await reconcileLegacyOrder({ orderId, apply: mode === 'apply' });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
