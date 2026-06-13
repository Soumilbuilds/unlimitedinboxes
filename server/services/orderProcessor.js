import { createIncognitoPage, loginToMicrosoft365, createSharedMailbox, ensureExchangeSmtpAuthEnabled, grantAdminConsent, closeBrowser } from './puppeteer.js';
import { createZone, addDnsRecord, updateZoneNameServers } from './cloudflare.js';
import { ensureSpfRecord, ensureDmarcRecord, ensureDkimRecords } from './emailAuth.js';
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
import {
  loginToSecurityCenter,
  ensureDkimSelectors,
  retryEnableDkimSigning
} from './securityCenterDkim.js';
import { generateMailboxName, resetUsedNames } from './nameGenerator.js';
import { generateTotpCode, isValidTotpSecret } from './totp.js';
import { discoverMicrosoftTenantId } from './tenantDiscovery.js';
import {
  getOrderById,
  getOrders,
  getTenantById,
  updateOrderStatus,
  updateOrderProgress,
  setOrderError,
  addOrderLog,
  updateTenantCloudflare,
  updateTenantId
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

function isCancelled(orderId) {
  const job = activeJobs.get(orderId);
  return Boolean(job?.cancelled);
}

function checkCancelled(orderId, message = null) {
  if (!isCancelled(orderId)) return false;
  if (message) {
    logMessage(orderId, message);
  }
  return true;
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

export function hasActiveJob(orderId) {
  return activeJobs.has(orderId);
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

export function resumeInterruptedOrders() {
  const interrupted = getOrders()
    .filter(order => order.status === 'processing' && !activeJobs.has(order.id));

  for (const order of interrupted) {
    logMessage(order.id, 'Resuming interrupted order processing...');
    processOrder(order.id);
  }
}

async function grantConsentIfNeeded(tenant, getTotpCode, orderId) {
  let consentContext = null;
  let consentPage = null;
  try {
    const clientId = process.env.MASTER_CLIENT_ID;
    const redirectUri = process.env.MASTER_REDIRECT_URI;
    const { context, page } = await createIncognitoPage();
    consentContext = context;
    consentPage = page;

    const result = await grantAdminConsent({
      page,
      context,
      email: tenant.admin_email,
      password: tenant.admin_password,
      getTotpCode,
      tenantId: tenant.tenant_id,
      clientId,
      redirectUri,
      state: 'order-' + orderId
    });
    return result || { success: false, error: 'grantAdminConsent returned no result' };
  } catch (err) {
    return { success: false, error: err?.message || String(err) };
  } finally {
    if (consentPage) {
      try { await consentPage.close(); } catch { /* ignore */ }
    }
    if (consentContext) {
      try { await consentContext.close(); } catch { /* ignore */ }
    }
  }
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
    // Try to discover the MS tenant ID on-the-fly (for tenants created before tenant_id was stored)
    if (tenant.admin_email) {
      logMessage(orderId, 'Microsoft tenant_id missing — attempting on-the-fly discovery from admin email...');
      const discoveredGuid = await discoverMicrosoftTenantId(tenant.admin_email);
      if (discoveredGuid) {
        try {
          updateTenantId(tenant.id, discoveredGuid);
          tenant.tenant_id = discoveredGuid;
          logMessage(orderId, `Discovered and saved MS tenant_id: ${discoveredGuid}`);
        } catch (persistError) {
          logMessage(orderId, `Failed to persist discovered tenant_id: ${persistError.message}`);
        }
      }
    }

    if (!tenant.tenant_id) {
      setOrderError(orderId, 'Microsoft tenant ID not found — please re-create the order with the new 2FA flow');
      return;
    }
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

  const { MASTER_CLIENT_ID, MASTER_CLIENT_SECRET, MASTER_REDIRECT_URI } = process.env;
  if (!MASTER_CLIENT_ID || !MASTER_CLIENT_SECRET) {
    setOrderError(orderId, 'Missing Microsoft app credentials in .env');
    return;
  }

  updateOrderStatus(orderId, 'processing');
  updateOrderProgress(orderId, 0, []);
  activeJobs.set(orderId, { cancelled: false, logs: [] });
  resetUsedNames();

  logMessage(orderId, `Starting order for ${domain}...`);

  // Set up TOTP resolver if MFA secret is available
  let getTotpCode = null;
  if (tenant.mfa_secret && isValidTotpSecret(tenant.mfa_secret)) {
    getTotpCode = () => generateTotpCode(tenant.mfa_secret);
    logMessage(orderId, 'Auto-generating 2FA codes from saved secret');
  } else if (tenant.mfa_secret) {
    logMessage(orderId, 'MFA secret not configured — if 2FA is required, login will fail');
  }

  // Force handle MFA even if no secret is stored - this will allow user to manually enter MFA code
  logMessage(orderId, 'Microsoft 365 MFA is now mandatory for all accounts - ensure your account has MFA registered');

  let browserContext = null;
  let page = null;
  let graphProvider = null;
  let globalAdminRoleId = null;
  let zoneId = tenant.cloudflare_zone_id;

  try {
    // Step 1: Ensure Cloudflare zone + verify domain with Microsoft
    logMessage(orderId, 'Ensuring Cloudflare zone...');
    if (!zoneId) {
      try {
        const zone = await createZone(domain);
        zoneId = zone.id;

        // Try to update nameservers to use custom ones if configured
        const customNs = await updateZoneNameServers(zoneId);
        const finalNs = customNs || zone.name_servers;

        updateTenantCloudflare(tenant.id, zone.id, finalNs);
        if (customNs) {
          logMessage(orderId, `Using custom nameservers: ${customNs.join(', ')}`);
        } else {
          logMessage(orderId, `Using Cloudflare nameservers: ${zone.name_servers.join(', ')}`);
        }
      } catch (zoneError) {
        const errorData = zoneError.response?.data;
        if (errorData?.errors?.[0]?.code === 0 &&
            errorData.errors[0].message?.includes('zone.create')) {
          setOrderError(orderId, 'Cloudflare token is missing the "Zone: Create" permission. Please update your Cloudflare API token to include zone creation access.');
          logMessage(orderId, `Fatal error: ${errorData.errors[0].message}`);
          return;
        }
        throw zoneError;
      }
    }
    if (checkCancelled(orderId)) return;

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
    if (checkCancelled(orderId)) return;

    logMessage(orderId, 'Adding domain to Microsoft...');
    let match;
    try {
      match = await addDomainToMicrosoft(MASTER_CLIENT_ID, MASTER_CLIENT_SECRET, tenant.tenant_id, domain);
    } catch (addErr) {
      const msg = String(addErr?.message || addErr || '');
      if (msg.includes('401') || msg.includes('consent') || msg.includes('unauthorized')) {
        logMessage(orderId, 'Microsoft returned 401 — auto-granting admin consent via puppeteer...');
        const consentResult = await grantConsentIfNeeded(tenant, getTotpCode, orderId);
        if (!consentResult.success) {
          logMessage(orderId, `Consent grant failed: ${consentResult.error}`);
          throw addErr;
        }
        logMessage(orderId, 'Consent granted — retrying addDomainToMicrosoft...');
        match = await addDomainToMicrosoft(MASTER_CLIENT_ID, MASTER_CLIENT_SECRET, tenant.tenant_id, domain);
      } else {
        throw addErr;
      }
    }
    if (checkCancelled(orderId)) return;

    logMessage(orderId, 'Adding verification TXT to Cloudflare...');
    await addDnsRecord(zoneId, 'TXT', match.txt_name, match.txt_text);

    logMessage(orderId, 'Waiting for DNS propagation (15s)...');
    await new Promise(r => setTimeout(r, 15000));
    if (checkCancelled(orderId)) return;

    logMessage(orderId, 'Verifying domain with Microsoft...');
    const verifyResult = await verifyDomain(MASTER_CLIENT_ID, MASTER_CLIENT_SECRET, tenant.tenant_id, domain);
    if (checkCancelled(orderId)) return;

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
    if (checkCancelled(orderId)) return;

    // Step 2: Graph admin client (app-only)
    logMessage(orderId, 'Preparing Microsoft Graph admin client...');
    graphProvider = await createGraphClientProvider(MASTER_CLIENT_ID, MASTER_CLIENT_SECRET, tenant.tenant_id);
    globalAdminRoleId = await graphProvider.run(client => getGlobalAdminRoleIdWithClient(client));
    if (checkCancelled(orderId)) return;

    // Step 3: Exchange mailbox creation
    logMessage(orderId, 'Launching exchange browser...');
    const { context: exchangeContext, page: newPage } = await createIncognitoPage();
    browserContext = exchangeContext;
    page = newPage;
    page.setDefaultTimeout(60000);
    if (checkCancelled(orderId)) return;

    // Re-read tenant to get latest MFA secret
    const updatedTenant = getTenantByIdForUser(tenant.id, tenant.user_id);
    logMessage(orderId, 'Re-reading tenant data for latest MFA secret...');

    // Set up TOTP resolver with fresh data
    let freshGetTotpCode = null;
    if (updatedTenant.mfa_secret && isValidTotpSecret(updatedTenant.mfa_secret)) {
      freshGetTotpCode = () => generateTotpCode(updatedTenant.mfa_secret);
      logMessage(orderId, 'Auto-generating 2FA codes from latest secret');
      logMessage(orderId, `MFA secret length: ${updatedTenant.mfa_secret.length} chars, decoded: ${Buffer.from(updatedTenant.mfa_secret, 'base32').length} bytes`);
    } else if (updatedTenant.mfa_secret) {
      logMessage(orderId, 'MFA secret exists but not configured properly - login may fail');
    } else {
      logMessage(orderId, 'No MFA secret configured - if MFA is required, login may fail');
    }

    logMessage(orderId, 'Logging in to Microsoft 365...');
    const loginResult = await loginToMicrosoft365(page, updatedTenant.admin_email, updatedTenant.admin_password, browserContext, freshGetTotpCode);
    if (!loginResult.success) {
      // Provide detailed error guidance based on the error type
      if (loginResult.error.includes('Login page still shown after attempts')) {
        setOrderError(orderId, 'Microsoft 365 login failed - this likely means Multi-Factor Authentication (MFA) is required but not configured. Please:');
        logMessage(orderId, '1. Ensure your admin account has MFA registered');
        logMessage(orderId, '2. If using 2fa.live, add the MFA secret to your tenant');
        logMessage(orderId, '3. Or manually enter the MFA code when prompted during browser automation');
      } else if (loginResult.error.includes('Invalid username or password')) {
        setOrderError(orderId, 'Invalid admin email or password - please check your credentials');
      } else {
        setOrderError(orderId, `Login failed: ${loginResult.error}`);
      }
      throw new Error(`Login failed: ${loginResult.error}`);
    }
    if (loginResult.page) {
      page = loginResult.page;
    }
    if (checkCancelled(orderId)) return;

    const total = order.total_mailboxes || 100;
    const createdMailboxes = [];
    const userIdByEmail = new Map();
    const preflightWeight = 10;
    const creationWeight = 60;
    const signinWeight = 20;
    const adminWeight = 10;

    // Enable SMTP AUTH BEFORE any mailbox creation — PlusVibe requires this
    logMessage(orderId, 'Ensuring SMTP AUTH is enabled before mailbox creation...');
    await ensureSmtpAuthSetting(orderId, page);

    // Preflight: create 1 mailbox and fully enable sign-in + password + GA
    logMessage(orderId, 'Preflight: creating 1 mailbox and enabling sign-in + Global Admin...');
    {
      const { fullName, alias } = generateMailboxName();
      const result = await createSharedMailbox(page, fullName, alias, domain, (msg) => logMessage(orderId, msg));
      if (!result.success) {
        throw new Error(`Preflight failed during mailbox creation: ${result.error}`);
      }
      if (checkCancelled(orderId, 'Order cancelled during preflight.')) return;

      const email = result.email;
      createdMailboxes.push({
        name: fullName,
        email,
        password: mailboxPassword,
        createdAt: new Date().toISOString()
      });
      updateOrderProgress(orderId, preflightWeight, createdMailboxes);
      if (checkCancelled(orderId, 'Order cancelled during preflight.')) return;

      let userId = result.externalDirectoryObjectId || result.objectId;
      userId = await resolveUserId(graphProvider, email, userId);
      if (!userId) {
        throw new Error(`Preflight failed: user object id not returned for ${email}`);
      }
      createdMailboxes[createdMailboxes.length - 1].objectId = userId;
      userIdByEmail.set(email, userId);

      await sleep(5000);
      if (checkCancelled(orderId, 'Order cancelled during preflight.')) return;

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
      if (checkCancelled(orderId, 'Order cancelled during preflight.')) return;

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
    if (checkCancelled(orderId)) return;

    if (total === 1) {
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

    if (checkCancelled(orderId)) return;

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

    logMessage(orderId, 'Configuring SPF / DKIM / DMARC...');
    try {
      const spfValue = process.env.SPF_VALUE || 'v=spf1 include:spf.protection.outlook.com -all';
      const dmarcValue = process.env.DMARC_VALUE || 'v=DMARC1; p=none; pct=100';

      logMessage(orderId, 'Adding SPF record...');
      const spf = await ensureSpfRecord(zoneId, domain, spfValue);
      logMessage(orderId, spf.action === 'created' ? 'SPF record created.' : 'SPF record already present.');

      logMessage(orderId, 'Adding DMARC record...');
      const dmarc = await ensureDmarcRecord(zoneId, domain, dmarcValue);
      logMessage(orderId, dmarc.action === 'created' ? 'DMARC record created.' : 'DMARC record already present.');

      let securitySession = null;
      try {
        logMessage(orderId, 'Fetching DKIM selectors...');
        securitySession = await loginToSecurityCenter(tenant.admin_email, tenant.admin_password, getTotpCode);
        if (!securitySession.success) {
          throw new Error(securitySession.error || 'Security Center login failed');
        }

        const cfg = await ensureDkimSelectors(securitySession.page, tenant.tenant_id, domain, msg => logMessage(orderId, msg));
        logMessage(orderId, 'Adding DKIM DNS records...');
        await ensureDkimRecords(zoneId, domain, cfg.Selector1CNAME, cfg.Selector2CNAME);

        if (cfg.Enabled === true) {
          logMessage(orderId, 'DKIM already enabled.');
        } else {
          logMessage(orderId, 'Enabling DKIM signing...');
          const enable = await retryEnableDkimSigning(securitySession.page, tenant.tenant_id, domain, msg => logMessage(orderId, msg));
          if (!enable?.success) {
            throw new Error(enable?.error || 'Failed to enable DKIM signing');
          }
          logMessage(orderId, 'DKIM enabled.');
        }
      } catch (dkimError) {
        logMessage(orderId, `DKIM setup failed: ${dkimError.message}`);
      } finally {
        if (securitySession?.page) {
          try { await securitySession.page.close(); } catch { /* ignore */ }
        }
        if (securitySession?.context) {
          try { await securitySession.context.close(); } catch { /* ignore */ }
        }
      }
    } catch (emailAuthError) {
      logMessage(orderId, `Email authentication setup failed: ${emailAuthError.message}`);
    }

    if (checkCancelled(orderId)) return;
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
