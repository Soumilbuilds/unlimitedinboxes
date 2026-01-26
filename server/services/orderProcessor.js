import { createIncognitoPage, loginToMicrosoft365, createSharedMailbox, ensureExchangeSmtpAuthEnabled } from './puppeteer.js';
import { createZone, addDnsRecord } from './cloudflare.js';
import {
  addDomainToMicrosoft,
  verifyDomain,
  listDomains,
  deleteDomain,
  getAppClient,
  getGlobalAdminRoleIdWithClient,
  updateUserUpnWithClient,
  enableSignInAndSetPasswordWithClient,
  assignGlobalAdminWithClient,
  waitForUserByEmailWithClient
} from './graph.js';
import { generateMailboxName, resetUsedNames } from './nameGenerator.js';
import {
  getOrderById,
  getTenantById,
  updateOrderStatus,
  updateOrderProgress,
  setOrderError,
  addOrderLog,
  updateTenantCloudflare
} from '../db/database.js';

const activeJobs = new Map();

function logMessage(orderId, message) {
  const timestamp = new Date().toISOString();
  addOrderLog(orderId, message, timestamp);
  const job = activeJobs.get(orderId);
  if (job) {
    job.logs.push({ timestamp, message });
  }
  console.log(`[Order ${orderId}] ${message}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableAdminStatus(status) {
  return status === 400 || status === 404 || status === 429 || status === 500 || status === 503;
}

async function createGraphClientProvider(clientId, clientSecret, tenantId) {
  let client = await getAppClient(clientId, clientSecret, tenantId);
  return {
    async run(fn) {
      try {
        return await fn(client);
      } catch (error) {
        if (error?.response?.status === 401) {
          client = await getAppClient(clientId, clientSecret, tenantId);
          return await fn(client);
        }
        throw error;
      }
    }
  };
}

function normalizeGraphError(error) {
  const status = error?.response?.status;
  const message = error?.response?.data?.error?.message || error?.message || 'Unknown error';
  return { success: false, status, error: message };
}

async function runGraphAction(graphProvider, actionFn) {
  try {
    await graphProvider.run(actionFn);
    return { success: true };
  } catch (error) {
    return normalizeGraphError(error);
  }
}

async function resolveUserId(graphProvider, email, fallbackId) {
  if (fallbackId) return fallbackId;
  try {
    const user = await graphProvider.run(client => waitForUserByEmailWithClient(client, email));
    return user?.id || null;
  } catch {
    return null;
  }
}

async function ensureSmtpAuthSetting(orderId, page) {
  const result = await ensureExchangeSmtpAuthEnabled(page, msg => logMessage(orderId, msg));
  if (result?.success === false) {
    logMessage(orderId, `SMTP AUTH setting update failed: ${result.error}`);
  }
}

async function retryAdminAction(orderId, label, actionFn, attempts = 6, delayMs = 5000) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    last = await actionFn();
    if (last?.success) return last;
    const status = last?.status;
    if (!isRetryableAdminStatus(status)) break;
    logMessage(orderId, `${label} retrying (${i + 1}/${attempts}) in ${Math.round(delayMs / 1000)}s...`);
    await sleep(delayMs);
  }
  return last;
}

export function getOrderLogs(orderId) {
  const job = activeJobs.get(orderId);
  return job ? job.logs : null;
}

export function cancelOrder(orderId) {
  const job = activeJobs.get(orderId);
  if (job) {
    job.cancelled = true;
    updateOrderStatus(orderId, 'cancelled');
    logMessage(orderId, 'Order cancelled by user.');
    return true;
  }
  return false;
}

export async function processOrder(orderId) {
  const order = getOrderById(orderId);
  if (!order) return;

  const tenant = getTenantById(order.tenant_id);
  if (!tenant) {
    setOrderError(orderId, 'Tenant not found');
    return;
  }

  if (!tenant.tenant_id) {
    setOrderError(orderId, 'Tenant not connected to Microsoft (missing tenant_id)');
    return;
  }

  const domain = tenant.domain;
  if (!domain) {
    setOrderError(orderId, 'Tenant missing domain');
    return;
  }

  const mailboxPassword = order.mailbox_password;
  if (!mailboxPassword) {
    setOrderError(orderId, 'Order missing mailbox password');
    return;
  }

  const { MASTER_CLIENT_ID, MASTER_CLIENT_SECRET } = process.env;
  if (!MASTER_CLIENT_ID || !MASTER_CLIENT_SECRET) {
    setOrderError(orderId, 'Missing Microsoft app credentials in .env');
    return;
  }

  updateOrderStatus(orderId, 'processing');
  updateOrderProgress(orderId, 0, []);
  activeJobs.set(orderId, { cancelled: false, logs: [] });
  resetUsedNames();

  logMessage(orderId, `Starting order for ${domain}...`);

  let browserContext = null;
  let page = null;
  let graphProvider = null;
  let globalAdminRoleId = null;

  try {
    // Step 1: Ensure Cloudflare zone + verify domain with Microsoft
    logMessage(orderId, 'Ensuring Cloudflare zone...');
    let zoneId = tenant.cloudflare_zone_id;
    if (!zoneId) {
      const zone = await createZone(domain);
      zoneId = zone.id;
      updateTenantCloudflare(tenant.id, zone.id, zone.name_servers);
    }

    const cleanDomains = process.env.CLEAN_DOMAINS_BEFORE_ORDER === 'true';
    if (cleanDomains) {
      logMessage(orderId, 'Cleaning non-default domains before proceeding...');
      try {
        const domains = await listDomains(MASTER_CLIENT_ID, MASTER_CLIENT_SECRET, tenant.tenant_id);
        for (const d of domains) {
          const id = d.id || d.name;
          const isDefault = d.isDefault || d.isInitial;
          if (!isDefault && id && id !== domain) {
            try {
              await deleteDomain(MASTER_CLIENT_ID, MASTER_CLIENT_SECRET, tenant.tenant_id, id);
              logMessage(orderId, `Deleted domain: ${id}`);
            } catch (e) {
              logMessage(orderId, `Failed to delete domain ${id}: ${e.message}`);
            }
          }
        }
      } catch (e) {
        logMessage(orderId, `Domain cleanup failed: ${e.message}`);
      }
    } else {
      try {
        await listDomains(MASTER_CLIENT_ID, MASTER_CLIENT_SECRET, tenant.tenant_id);
      } catch {
        // ignore
      }
    }

    logMessage(orderId, 'Adding domain to Microsoft...');
    const match = await addDomainToMicrosoft(MASTER_CLIENT_ID, MASTER_CLIENT_SECRET, tenant.tenant_id, domain);

    logMessage(orderId, 'Adding verification TXT to Cloudflare...');
    await addDnsRecord(zoneId, 'TXT', match.txt_name, match.txt_text);

    logMessage(orderId, 'Waiting for DNS propagation (15s)...');
    await new Promise(r => setTimeout(r, 15000));

    logMessage(orderId, 'Verifying domain with Microsoft...');
    const verifyResult = await verifyDomain(MASTER_CLIENT_ID, MASTER_CLIENT_SECRET, tenant.tenant_id, domain);

    if (verifyResult?.records?.length) {
      logMessage(orderId, 'Adding Exchange DNS records...');
      for (const rec of verifyResult.records) {
        try {
          await addDnsRecord(
            zoneId,
            rec.recordType.toUpperCase(),
            rec.name,
            rec.text || rec.value || rec.target,
            rec.priority
          );
        } catch (e) {
          // ignore duplicates
        }
      }
    } else {
      logMessage(orderId, 'No service configuration records returned. Domain may already be configured.');
    }

    // Step 2: Graph admin client (app-only)
    logMessage(orderId, 'Preparing Microsoft Graph admin client...');
    graphProvider = await createGraphClientProvider(MASTER_CLIENT_ID, MASTER_CLIENT_SECRET, tenant.tenant_id);
    globalAdminRoleId = await graphProvider.run(client => getGlobalAdminRoleIdWithClient(client));

    // Step 3: Exchange mailbox creation
    logMessage(orderId, 'Launching exchange browser...');
    const { context: exchangeContext, page: newPage } = await createIncognitoPage();
    browserContext = exchangeContext;
    page = newPage;
    page.setDefaultTimeout(60000);

    logMessage(orderId, 'Logging in to Microsoft 365...');
    const loginResult = await loginToMicrosoft365(page, tenant.admin_email, tenant.admin_password, browserContext);
    if (!loginResult.success) {
      throw new Error(`Login failed: ${loginResult.error}`);
    }
    if (loginResult.page) {
      page = loginResult.page;
    }

    const total = order.total_mailboxes || 100;
    const createdMailboxes = [];
    const userIdByEmail = new Map();
    const preflightWeight = 10;
    const creationWeight = 60;
    const signinWeight = 20;
    const adminWeight = 10;

    // Preflight: create 1 mailbox and fully enable sign-in + password + GA
    logMessage(orderId, 'Preflight: creating 1 mailbox and enabling sign-in + Global Admin...');
    {
      const { fullName, alias } = generateMailboxName();
      const result = await createSharedMailbox(page, fullName, alias, domain, (msg) => logMessage(orderId, msg));
      if (!result.success) {
        throw new Error(`Preflight failed during mailbox creation: ${result.error}`);
      }

      const email = result.email;
      createdMailboxes.push({
        name: fullName,
        email,
        password: mailboxPassword,
        createdAt: new Date().toISOString()
      });
      updateOrderProgress(orderId, preflightWeight, createdMailboxes);

      let userId = result.externalDirectoryObjectId || result.objectId;
      userId = await resolveUserId(graphProvider, email, userId);
      if (!userId) {
        throw new Error(`Preflight failed: user object id not returned for ${email}`);
      }
      createdMailboxes[createdMailboxes.length - 1].objectId = userId;
      userIdByEmail.set(email, userId);

      await sleep(5000);

      const upnResult = await retryAdminAction(
        orderId,
        'UPN update',
        () => runGraphAction(graphProvider, client => updateUserUpnWithClient(client, userId, email)),
        4,
        5000
      );
      if (!upnResult?.success) {
        logMessage(orderId, `Preflight: UPN update failed for ${email}: ${upnResult?.error || 'Unknown error'}`);
      }

      const enableResult = await retryAdminAction(
        orderId,
        'Sign-in enable + password',
        () => runGraphAction(graphProvider, client => enableSignInAndSetPasswordWithClient(client, userId, mailboxPassword)),
        6,
        5000
      );
      if (!enableResult?.success) {
        throw new Error(`Preflight sign-in enable failed: ${enableResult?.error || 'Unknown error'}`);
      }
      logMessage(orderId, `Preflight: sign-in enabled for ${email}`);

      const roleResult = await retryAdminAction(
        orderId,
        'Global Admin assign',
        () => runGraphAction(graphProvider, client => assignGlobalAdminWithClient(client, userId, globalAdminRoleId)),
        4,
        5000
      );
      if (!roleResult?.success) {
        throw new Error(`Preflight Global Admin assign failed: ${roleResult?.error || 'Unknown error'}`);
      }
      logMessage(orderId, `Preflight: Global Admin assigned to ${email}`);
    }

    if (total === 1) {
      await ensureSmtpAuthSetting(orderId, page);
      updateOrderProgress(orderId, 100, createdMailboxes);
      updateOrderStatus(orderId, 'completed');
      logMessage(orderId, 'Order completed successfully.');
      return;
    }

    logMessage(orderId, `Preflight complete. Proceeding with remaining ${total - 1} mailboxes...`);

    for (let i = 1; i < total; i += 1) {
      const job = activeJobs.get(orderId);
      if (job?.cancelled) {
        logMessage(orderId, 'Order cancelled mid-run.');
        return;
      }

      const { fullName, alias } = generateMailboxName();
      logMessage(orderId, `[${i + 1}/${total}] Creating mailbox ${fullName}...`);

      const result = await createSharedMailbox(page, fullName, alias, domain, (msg) => logMessage(orderId, msg));
      if (result.success) {
        const email = result.email;
        const userId = result.externalDirectoryObjectId || result.objectId;
        createdMailboxes.push({
          name: fullName,
          email,
          password: mailboxPassword,
          objectId: userId,
          createdAt: new Date().toISOString()
        });
      } else {
        logMessage(orderId, `Mailbox failed: ${result.error}`);
      }

      const remainingCount = Math.max(total - 1, 1);
      const createdCount = i;
      const progress = preflightWeight + Math.round((createdCount / remainingCount) * creationWeight);
      updateOrderProgress(orderId, progress, createdMailboxes);
      await new Promise(r => setTimeout(r, 1500));
    }

    await ensureSmtpAuthSetting(orderId, page);

    logMessage(orderId, 'Enabling sign-in and setting passwords for all mailboxes...');
    for (let i = 0; i < createdMailboxes.length; i += 1) {
      const job = activeJobs.get(orderId);
      if (job?.cancelled) {
        logMessage(orderId, 'Order cancelled before sign-in enablement.');
        return;
      }

      const mailbox = createdMailboxes[i];
      let userId = mailbox.objectId;
      if (!userId) {
        userId = await resolveUserId(graphProvider, mailbox.email, mailbox.objectId);
        if (userId) {
          mailbox.objectId = userId;
        }
      }

      if (!userId) {
        logMessage(orderId, `Missing object id for ${mailbox.email} (sign-in not enabled)`);
      } else {
        const upnResult = await retryAdminAction(
          orderId,
          `UPN update (${mailbox.email})`,
          () => runGraphAction(graphProvider, client => updateUserUpnWithClient(client, userId, mailbox.email)),
          3,
          4000
        );
        if (!upnResult?.success) {
          logMessage(orderId, `UPN update failed for ${mailbox.email}: ${upnResult?.error || 'Unknown error'}`);
        }

        const enableResult = await retryAdminAction(
          orderId,
          `Sign-in + password (${mailbox.email})`,
          () => runGraphAction(graphProvider, client => enableSignInAndSetPasswordWithClient(client, userId, mailboxPassword)),
          4,
          4000
        );
        if (!enableResult?.success) {
          logMessage(orderId, `Sign-in enable failed for ${mailbox.email}: ${enableResult?.error || 'Unknown error'}`);
        } else {
          logMessage(orderId, `Sign-in enabled for ${mailbox.email}`);
        }

        userIdByEmail.set(mailbox.email, userId);
      }

      const progress = preflightWeight + creationWeight + Math.round(((i + 1) / createdMailboxes.length) * signinWeight);
      updateOrderProgress(orderId, progress, createdMailboxes);
      await new Promise(r => setTimeout(r, 800));
    }

    logMessage(orderId, 'Assigning Global Admin role...');
    for (let i = 0; i < createdMailboxes.length; i += 1) {
      const job = activeJobs.get(orderId);
      if (job?.cancelled) {
        logMessage(orderId, 'Order cancelled before role assignment.');
        return;
      }

      const mailbox = createdMailboxes[i];
      const userId = userIdByEmail.get(mailbox.email);
      if (!userId) {
        logMessage(orderId, `Missing object id for ${mailbox.email} (global admin not assigned)`);
      } else {
        const roleResult = await retryAdminAction(
          orderId,
          `Global Admin assign (${mailbox.email})`,
          () => runGraphAction(graphProvider, client => assignGlobalAdminWithClient(client, userId, globalAdminRoleId)),
          4,
          4000
        );
        if (!roleResult?.success) {
          logMessage(orderId, `Global Admin assign failed for ${mailbox.email}: ${roleResult?.error || 'Unknown error'}`);
        } else {
          logMessage(orderId, `Global Admin assigned to ${mailbox.email}`);
        }
      }

      const progress = preflightWeight + creationWeight + signinWeight + Math.round(((i + 1) / createdMailboxes.length) * adminWeight);
      updateOrderProgress(orderId, progress, createdMailboxes);
      await new Promise(r => setTimeout(r, 800));
    }

    updateOrderProgress(orderId, 100, createdMailboxes);
    updateOrderStatus(orderId, 'completed');
    logMessage(orderId, 'Order completed successfully.');
  } catch (error) {
    setOrderError(orderId, error.message);
    logMessage(orderId, `Fatal error: ${error.message}`);
  } finally {
    if (page) {
      try { await page.close(); } catch (e) { }
    }
    if (browserContext) {
      try { await browserContext.close(); } catch (e) { }
    }
    activeJobs.delete(orderId);
  }
}
