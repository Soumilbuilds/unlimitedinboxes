import { createIncognitoPage, loginToMicrosoft365, createSharedMailbox, ensureExchangeSmtpAuthEnabled, grantAdminConsent } from './puppeteer.js';
import { createZone, addDnsRecord, listDnsRecords, updateZoneNameServers, upsertZoneRedirect } from './cloudflare.js';
import { ensureSpfRecord, ensureDmarcRecord, ensureDkimRecords } from './emailAuth.js';
import {
 addDomainToMicrosoft,
 verifyDomain,
 disableSecurityDefaultsWithClient,
 listDomains,
 deleteDomain,
 getAppClient,
 getInitialDomainWithClient,
 getGlobalAdminRoleIdWithClient,
 ensureExchangeAdministratorAssignmentWithClient,
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
 ensureExchangeOnlineServicePrincipal,
 isMissingExchangeServicePrincipalError
} from './microsoftBootstrap.js';
import {
 isExchangePowerShellConfigured,
 testExchangeOnlineConnection,
 ensureOrganizationSmtpAuthEnabled,
 ensureSharedMailbox,
 ensureSharedMailboxes
} from './exchangePowerShell.js';
import { createDelegatedExchangeSession } from './exchangeDelegatedPowerShell.js';
import {
 getOrderById,
 getOrders,
 getTenantById,
 getTenantByIdForUser,
 updateOrderStatus,
 updateOrderProgress,
 setOrderError,
 clearOrderError,
 addOrderLog,
 updateTenantCloudflare,
 updateTenantId,
 acquireOrderProcessingLease,
 touchOrderProcessingLease,
 releaseOrderProcessingLease,
 persistCreatedMailboxes
} from '../db/database.js';
import crypto from 'node:crypto';

const activeJobs = new Map();
const PROCESSING_HEARTBEAT_INTERVAL_MS = 30_000;

function logMessage(orderId, message) {
 const job = activeJobs.get(orderId);
 if (job?.leaseLost) {
 throw new Error('Order execution lease was lost to another worker');
 }
 const timestamp = new Date().toISOString();
 addOrderLog(orderId, message, timestamp);
 if (job) {
 job.logs.push({ timestamp, message });
 const heartbeat = touchOrderProcessingLease(orderId, job.token);
 if (heartbeat.changes !== 1) {
 job.leaseLost = true;
 throw new Error('Order execution lease was lost to another worker');
 }
 }
 console.log(`[Order ${orderId}] ${message}`);
}

function startProcessingHeartbeat(orderId, job) {
 const timer = setInterval(() => {
 if (activeJobs.get(orderId) !== job || job.leaseLost) return;
 try {
 const heartbeat = touchOrderProcessingLease(orderId, job.token);
 if (heartbeat.changes !== 1) {
 job.leaseLost = true;
 job.cancelled = true;
 console.error(`[Order ${orderId}] Heartbeat stopped because another worker owns the execution lease.`);
 }
 } catch (error) {
 // A transient SQLite error must not surrender ownership. The next heartbeat
 // or normal log write will retry before the lease can become stale.
 console.error(`[Order ${orderId}] Could not refresh processing heartbeat: ${error.message}`);
 }
 }, PROCESSING_HEARTBEAT_INTERVAL_MS);
 if (typeof timer.unref === 'function') timer.unref();
 job.heartbeatTimer = timer;
}

function logStep(orderId, stepNumber, stepDescription) {
 logMessage(orderId, `STEP ${stepNumber}: ${stepDescription}`);
}

function sleep(ms = 0) {
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

export function isExternalDirectoryMemberCreationError(error) {
 const message = String(error?.message || error || '');
 return /ExternalDirectoryObjectId/i.test(message) && /Member Creation/i.test(message);
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
 throw new Error(result.error || 'SMTP AUTH setting update failed');
 }
 return result;
}

async function retryAdminAction(orderId, label, actionFn, attempts = 6, delayMs = 5000) {
 let last = null;
 for (let i = 0; i < attempts; i++) {
 last = await actionFn();
 if (last?.success) return last;
 const status = last?.status;
 if (!isRetryableAdminStatus(status)) break;
 logMessage(orderId, `${label} retrying (${i + 1}/${attempts}) in ${Math.round(delayMs / 1000)}s...`);
 await sleep(delayMs);
 }
 return last;
}

async function grantConsentIfNeeded(tenant, getTotpCode, orderId, scope = null) {
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
 mfaSecret: tenant.mfa_secret,
 tenantId: tenant.tenant_id,
 clientId,
 redirectUri,
 state: 'order-' + orderId,
 scope
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

async function runPreflightChecks(orderId, order, tenant) {
 logStep(orderId, 1, 'Preflight: verify tenant, domain, credentials, and tenant_id');

 if (!tenant.domain) {
 throw new Error('Tenant missing domain -- cannot proceed with order');
 }

 if (!order.mailbox_password) {
 throw new Error('Order missing mailbox password -- cannot create mailboxes');
 }

 const { MASTER_CLIENT_ID, MASTER_CLIENT_SECRET } = process.env;
 if (!MASTER_CLIENT_ID || !MASTER_CLIENT_SECRET) {
 throw new Error('Missing Microsoft app credentials (MASTER_CLIENT_ID / MASTER_CLIENT_SECRET) in .env');
 }

 if (!tenant.tenant_id) {
 const discoveredGuid = await discoverMicrosoftTenantId(tenant.admin_email);
 if (discoveredGuid) {
 try {
 updateTenantId(tenant.id, discoveredGuid);
 logMessage(orderId, `Discovered and saved MS tenant_id: ${discoveredGuid}`);
 tenant.tenant_id = discoveredGuid;
 } catch (persistError) {
 logMessage(orderId, `Failed to persist discovered tenant_id: ${persistError.message}`);
 }
 }
 if (!tenant.tenant_id) {
 throw new Error('Microsoft tenant ID not found -- please re-create the order with the new 2FA flow');
 }
 }

 logMessage(orderId, `Preflight OK -- domain: ${tenant.domain}, tenant_id: ${tenant.tenant_id}`);
 return tenant;
}

async function runSetupCloudflareZone(orderId, domain, tenant) {
 logStep(orderId, 2, 'Cloudflare: create/verify zone for domain');
 let zoneId = tenant.cloudflare_zone_id;

 if (!zoneId) {
 try {
 const zone = await createZone(domain);
 zoneId = zone.id;
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
 throw new Error('Cloudflare token is missing the "Zone: Create" permission. Please update your Cloudflare API token to include zone creation access.');
 }
 throw zoneError;
 }
 }

 logMessage(orderId, `Cloudflare zone ready: ${zoneId}`);
 return zoneId;
}

async function runUpdateNameservers(orderId, zoneId, tenant) {
 logStep(orderId, 3, 'Nameservers: ensure domain NS records point to Cloudflare');
 const tenantNs = tenant.cloudflare_ns ? JSON.parse(tenant.cloudflare_ns) : null;
 if (tenantNs && tenantNs.length >= 2) {
 logMessage(orderId, `Nameservers configured on tenant: ${tenantNs.join(', ')}`);
 logMessage(orderId, 'NOTE: Domain nameserver changes must be made at your domain registrar (GoDaddy, Namecheap, etc.)');
 logMessage(orderId, 'Update your domain NS records to point to the Cloudflare nameservers listed above.');
 } else {
 logMessage(orderId, 'Nameservers not yet confirmed on tenant -- ensure domain NS records point to Cloudflare');
 }
}

async function runAddDomainToMicrosoft(orderId, tenant, getTotpCode) {
 logStep(orderId, 4, 'Microsoft: grant admin consent and add domain to tenant');
 const { MASTER_CLIENT_ID, MASTER_CLIENT_SECRET } = process.env;
 try {
 const existingAuthorizationMatch = await addDomainToMicrosoft(
 MASTER_CLIENT_ID,
 MASTER_CLIENT_SECRET,
 tenant.tenant_id,
 tenant.domain,
 true
 );
 logMessage(orderId, 'Microsoft authorization is already active; interactive consent was not needed.');
 return existingAuthorizationMatch;
 } catch (authorizationProbeError) {
 const status = authorizationProbeError?.response?.status;
 const details = String(
 authorizationProbeError?.response?.data?.error_description ||
 authorizationProbeError?.response?.data?.error?.message ||
 authorizationProbeError?.message ||
 ''
 );
 const requiresConsent = status === 401 || status === 403 ||
 /AADSTS65001|AADSTS650052|AADSTS7000229|consent|service principal/i.test(details);
 if (!requiresConsent) {
 throw authorizationProbeError;
 }
 logMessage(orderId, 'Microsoft authorization is missing; opening isolated admin consent.');
 }

 let consentResult = await grantConsentIfNeeded(tenant, getTotpCode, orderId);
 if (!consentResult.success && isMissingExchangeServicePrincipalError(consentResult.error)) {
 logMessage(orderId, 'Microsoft reported AADSTS650052; retrying with the documented Exchange Online consent scope...');
 const exchangeConsent = await grantConsentIfNeeded(
 tenant,
 getTotpCode,
 orderId,
 'https://outlook.office365.com/.default'
 );
 if (exchangeConsent.success) {
 logMessage(orderId, 'Exchange Online scoped consent succeeded; completing application consent...');
 consentResult = await grantConsentIfNeeded(tenant, getTotpCode, orderId);
 } else if (isMissingExchangeServicePrincipalError(exchangeConsent.error)) {
 logMessage(orderId, 'Scoped consent still reports a missing Exchange service; trying directory bootstrap...');
 await ensureExchangeOnlineServicePrincipal({
 tenantId: tenant.tenant_id,
 email: tenant.admin_email,
 password: tenant.admin_password,
 mfaSecret: tenant.mfa_secret,
 getTotpCode,
 log: message => logMessage(orderId, message)
 });
 logMessage(orderId, 'Directory bootstrap complete; retrying Exchange Online scoped consent...');
 consentResult = await grantConsentIfNeeded(
 tenant,
 getTotpCode,
 orderId,
 'https://outlook.office365.com/.default'
 );
 } else {
 consentResult = exchangeConsent;
 }
 }
 if (!consentResult.success) {
 throw new Error(`Consent grant failed: ${consentResult.error}`);
 }
 logMessage(orderId, 'Microsoft admin consent confirmed; adding the domain...');
 const match = await addDomainToMicrosoft(
 MASTER_CLIENT_ID,
 MASTER_CLIENT_SECRET,
 tenant.tenant_id,
 tenant.domain
 );

 logMessage(orderId, `Domain added to Microsoft 365 -- TXT record: ${match.txt_name} = "${match.txt_text}"`);
 return match;
}

async function runVerifyDomain(orderId, zoneId, tenant, match) {
 logStep(orderId, 5, 'Microsoft: verify domain ownership via TXT record');
 const hasVerificationToken = /^MS=.+/i.test(String(match?.txt_text || ''));
 if (!match?.already_verified && hasVerificationToken) {
 logMessage(orderId, 'Adding verification TXT to Cloudflare...');
 await addDnsRecord(zoneId, 'TXT', match.txt_name, match.txt_text);

 logMessage(orderId, 'Waiting for DNS propagation (15s)...');
 await sleep(15000);
 if (checkCancelled(orderId)) return;
 } else {
 logMessage(orderId, 'Domain is already verified; skipping verification TXT and DNS wait.');
 }

 logMessage(orderId, 'Verifying domain with Microsoft...');
 const { MASTER_CLIENT_ID, MASTER_CLIENT_SECRET } = process.env;
 const verifyResult = await verifyDomain(MASTER_CLIENT_ID, MASTER_CLIENT_SECRET, tenant.tenant_id, tenant.domain);
 logMessage(orderId, 'Domain verified successfully with Microsoft 365');
 return verifyResult;
}

export function normalizeMicrosoftEmailDnsRecord(record) {
 const recordType = String(record?.recordType || '').toUpperCase();
 const name = String(record?.label || record?.name || '').trim();
 let content = '';
 let priority;

 if (recordType === 'MX') {
 content = String(record?.mailExchange || record?.value || record?.target || '').trim();
 priority = record?.preference ?? record?.priority;
 } else if (recordType === 'TXT') {
 content = String(record?.text || record?.value || '').trim();
 } else if (recordType === 'CNAME') {
 content = String(record?.canonicalName || record?.value || record?.target || '').trim();
 } else {
 return null;
 }

 if (!name || !content) {
 return null;
 }

 return { type: recordType, name, content, priority };
}

async function runAddExchangeDnsRecords(orderId, zoneId, domain, verifyResult) {
 logStep(orderId, 6, 'DNS: add MX, SPF, DKIM, and DMARC records');

 if (verifyResult?.records?.length) {
 const recordFailures = [];
 for (const rec of verifyResult.records) {
 const normalized = normalizeMicrosoftEmailDnsRecord(rec);
 if (!normalized) {
 if (rec?.isOptional === false) {
 throw new Error(
 `Microsoft returned an unsupported or incomplete required Email DNS record (${rec?.recordType || 'unknown type'})`
 );
 }
 logMessage(orderId, ` Skipped unsupported optional Email DNS record (${rec?.recordType || 'unknown type'})`);
 continue;
 }
 try {
 await addDnsRecord(
 zoneId,
 normalized.type,
 normalized.name,
 normalized.content,
 normalized.priority
 );
 logMessage(orderId, ` Added ${normalized.type} ${normalized.name}`);
 } catch (e) {
 recordFailures.push({ normalized, error: e.message });
 }
 }
 if (recordFailures.length) {
 logMessage(orderId, `DNS add had ${recordFailures.length} failure(s) -- verifying records:`);
 for (const { normalized, error } of recordFailures) {
 const rType = normalized.type;
 const rName = normalized.name;
 const rContent = normalized.content;
 const existing = await listDnsRecords(zoneId, { type: rType, name: rName });
 const present = existing.some(r => r.content === rContent);
 if (present) {
 logMessage(orderId, ` ${rType} ${rName} already present (retry-safe)`);
 } else {
 logMessage(orderId, ` ${rType} ${rName} missing: ${error}`);
 if (rType === 'MX') {
 try {
 await addDnsRecord(zoneId, rType, rName, rContent, normalized.priority);
 logMessage(orderId, ` MX record added on retry`);
 } catch (retryErr) {
 throw new Error(`Critical: failed to add MX record for ${rName}: ${retryErr.message}`);
 }
 } else {
 throw new Error(`Failed to add required DNS ${rType} ${rName}: ${error}`);
 }
 }
 }
 }
 } else {
 logMessage(orderId, 'No service configuration records returned. Domain may already be configured.');
 }

 try {
 const mxRecords = await listDnsRecords(zoneId, { type: 'MX', name: domain });
 if (!mxRecords.length) {
 logMessage(orderId, 'Post-loop check: MX record missing -- adding fallback MX');
 await addDnsRecord(zoneId, 'MX', domain, `${domain.replace(/\./g, '-')}.mail.protection.outlook.com`, 0);
 logMessage(orderId, 'Fallback MX record added');
 } else {
 logMessage(orderId, `MX record verified: ${mxRecords[0].content} (priority ${mxRecords[0].priority})`);
 }
 } catch (mxVerifyErr) {
 throw new Error(`MX verification failed: ${mxVerifyErr.message}`);
 }
}

async function runPrepareGraphAdminClient(orderId, tenant) {
 logStep(orderId, 7, 'Microsoft: prepare secure admin permissions');
 const { MASTER_CLIENT_ID, MASTER_CLIENT_SECRET } = process.env;
 const graphProvider = await createGraphClientProvider(MASTER_CLIENT_ID, MASTER_CLIENT_SECRET, tenant.tenant_id);

 let globalAdminRoleId;
 try {
 globalAdminRoleId = await graphProvider.run(client => getGlobalAdminRoleIdWithClient(client));
 } catch (roleErr) {
 throw new Error(`Failed to resolve Global Administrator role: ${roleErr.message}`);
 }

 let exchangeOrgDomain;
 try {
 exchangeOrgDomain = await graphProvider.run(client => getInitialDomainWithClient(client));
 if (!exchangeOrgDomain) {
 throw new Error('Initial onmicrosoft.com domain was not found');
 }
 const assignment = await graphProvider.run(client =>
 ensureExchangeAdministratorAssignmentWithClient(client, MASTER_CLIENT_ID)
 );
 logMessage(
 orderId,
 assignment.action === 'created'
 ? 'Mailbox administration permissions prepared.'
 : 'Mailbox administration permissions already prepared.'
 );
 } catch (exchangeRoleError) {
 throw new Error(`Failed to prepare mailbox administration access: ${exchangeRoleError.message}`);
 }

 logMessage(orderId, 'Microsoft admin permissions are ready.');
 return { graphProvider, globalAdminRoleId, exchangeOrgDomain };
}

async function runDisableSecurityDefaults(orderId, graphProvider) {
 logStep(orderId, 8, 'Security: disable Security Defaults (graceful if not possible)');
 try {
 await graphProvider.run(client => disableSecurityDefaultsWithClient(client));
 logMessage(orderId, 'Security Defaults disabled -- no MFA prompt on first login');
 } catch (sdErr) {
 logMessage(orderId, `Security Defaults disable skipped (non-fatal -- some tenants require them): ${sdErr.message}`);
 }
}

function parseRequestedMailboxNames(order, total) {
 let names = null;
 try {
 names = order.mailbox_names ? JSON.parse(order.mailbox_names) : null;
 } catch {
 throw new Error('Saved custom mailbox names are invalid');
 }
 if (names == null) return null;
 if (!Array.isArray(names) || names.length !== total) {
 throw new Error(`Expected ${total} custom mailbox names but found ${Array.isArray(names) ? names.length : 0}`);
 }

 const aliases = new Set();
 return names.map((rawName, index) => {
 const fullName = String(rawName || '').trim().replace(/\s+/g, ' ');
 const baseAlias = fullName
 .normalize('NFKD')
 .replace(/[\u0300-\u036f]/g, '')
 .toLowerCase()
 .replace(/[^a-z0-9]/g, '') || `mailbox${index + 1}`;
 let alias = baseAlias;
 let suffix = 2;
 while (aliases.has(alias)) {
 alias = `${baseAlias}${suffix}`;
 suffix += 1;
 }
 aliases.add(alias);
 return { fullName, alias };
 });
}

async function createMailbox(orderId, page, exchangeOrgDomain, fullName, alias, domain, mailboxPassword, delegatedExchangeSession = null) {
 if (delegatedExchangeSession) {
 const [result] = await delegatedExchangeSession.ensureSharedMailboxes({
 domain,
 mailboxes: [{ displayName: fullName, alias, password: mailboxPassword }]
 });
 if (!result?.success) {
 throw new Error(result?.error || `Mailbox creation failed for ${alias}@${domain}`);
 }
 logMessage(orderId, result.created ? ` Mailbox created: ${result.email}` : ` Existing mailbox confirmed: ${result.email}`);
 return result;
 }
 if (exchangeOrgDomain) {
 const result = await ensureSharedMailbox({
 orgDomain: exchangeOrgDomain,
 displayName: fullName,
 alias,
 domain,
 password: mailboxPassword
 });
 logMessage(
 orderId,
 result.created
 ? ` Mailbox created: ${result.email}`
 : ` Existing mailbox confirmed: ${result.email}`
 );
 return result;
 }
 return createSharedMailbox(page, fullName, alias, domain, (msg) => logMessage(orderId, msg));
}

async function runCreateMailboxes(
 orderId,
 totalMailboxes,
 domain,
 mailboxPassword,
 page,
 identities = null,
 exchangeOrgDomain = null,
 delegatedExchangeSession = null
) {
 logStep(orderId, 9, `Create ${totalMailboxes} mailboxes`);
 const createdMailboxes = [];

 for (let i = 0; i < totalMailboxes; i++) {
 if (checkCancelled(orderId, 'Order cancelled during mailbox creation.')) {
 throw new Error('Order cancelled by user');
 }

 const { fullName, alias } = identities?.[i] || generateMailboxName();
 logMessage(orderId, `[${i + 1}/${totalMailboxes}] Creating mailbox: ${fullName} (${alias}@${domain})`);

 const result = await createMailbox(orderId, page, exchangeOrgDomain, fullName, alias, domain, mailboxPassword, delegatedExchangeSession);
 if (result.success) {
 const email = result.email;
 createdMailboxes.push({
 name: fullName,
 email,
 password: mailboxPassword,
 objectId: result.externalDirectoryObjectId || result.objectId,
 createdAt: new Date().toISOString()
 });
 logMessage(orderId, ` Created: ${email}`);
 } else {
 logMessage(orderId, ` FAILED: ${result.error}`);
 }

 await sleep(5000);
 }

 logMessage(orderId, `Mailbox creation complete: ${createdMailboxes.length}/${totalMailboxes} created`);
 return createdMailboxes;
}

async function runEnableSignIn(orderId, createdMailboxes, mailboxPassword, graphProvider) {
 logStep(orderId, 10, 'Enable sign-in and set passwords on all mailboxes');

 for (let i = 0; i < createdMailboxes.length; i++) {
 if (checkCancelled(orderId, 'Order cancelled during sign-in enablement.')) {
 throw new Error('Order cancelled by user');
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
 throw new Error(`Missing Microsoft user object id for ${mailbox.email}`);
 }

 const upnResult = await retryAdminAction(
 orderId,
 `UPN update (${mailbox.email})`,
 () => runGraphAction(graphProvider, client => updateUserUpnWithClient(client, userId, mailbox.email)),
 3,
 4000
 );
 if (!upnResult?.success) {
 throw new Error(`UPN update failed for ${mailbox.email}: ${upnResult?.error || 'Unknown error'}`);
 }

 const enableResult = await retryAdminAction(
 orderId,
 `Sign-in + password (${mailbox.email})`,
 () => runGraphAction(graphProvider, client => enableSignInAndSetPasswordWithClient(client, userId, mailboxPassword)),
 4,
 4000
 );
 if (!enableResult?.success) {
 throw new Error(`Sign-in enable failed for ${mailbox.email}: ${enableResult?.error || 'Unknown error'}`);
 } else {
 logMessage(orderId, ` Sign-in enabled for ${mailbox.email}`);
 }
 }
}

async function runReconcileExchangeMailboxes(orderId, createdMailboxes, domain, exchangeOrgDomain, delegatedExchangeSession = null) {
 if (!exchangeOrgDomain && !delegatedExchangeSession) return;

 const batchSize = 10;
 for (let start = 0; start < createdMailboxes.length; start += batchSize) {
 const batch = createdMailboxes.slice(start, start + batchSize);
 const mailboxRequests = batch.map(mailbox => ({
 displayName: mailbox.name,
 alias: String(mailbox.email || '').split('@')[0],
 password: mailbox.password
 }));
 const results = delegatedExchangeSession
 ? await delegatedExchangeSession.ensureSharedMailboxes({ domain, mailboxes: mailboxRequests })
 : await ensureSharedMailboxes({ orgDomain: exchangeOrgDomain, domain, mailboxes: mailboxRequests });
 const failures = results.filter(result => !result.success);
 if (failures.length) {
 throw new Error(
 `Exchange reconciliation failed for ${failures.map(result => (
 result.email || `batch item ${result.index + 1}`
 )).join(', ')}`
 );
 }
 for (const result of results) {
 const mailbox = batch[result.index];
 if (mailbox && result.externalDirectoryObjectId) {
 mailbox.objectId = result.externalDirectoryObjectId;
 }
 }
 logMessage(
 orderId,
 `Exchange primary SMTP and mailbox SMTP AUTH reconciled for ${Math.min(start + batch.length, createdMailboxes.length)}/${createdMailboxes.length}.`
 );
 }
}

async function runConfigureSmtpAuth(orderId, page, exchangeOrgDomain = null) {
 logStep(orderId, 11, 'Prepare mailbox sending access');
 if (exchangeOrgDomain) {
 const result = await ensureOrganizationSmtpAuthEnabled(exchangeOrgDomain);
 logMessage(
 orderId,
 result.Changed
 ? 'Organization SMTP AUTH enabled.'
 : 'Organization SMTP AUTH was already enabled.'
 );
 return;
 }
 await ensureSmtpAuthSetting(orderId, page);
}

async function runConfigureEmailAuth(orderId, zoneId, domain, tenant, getTotpCode) {
 logStep(orderId, 12, 'Configure email authentication (SPF, DKIM, DMARC)');
 const spfValue = process.env.SPF_VALUE || 'v=spf1 include:spf.protection.outlook.com -all';
 const dmarcValue = process.env.DMARC_VALUE || 'v=DMARC1; p=none; pct=100';

 logMessage(orderId, 'Adding SPF record...');
 const spf = await ensureSpfRecord(zoneId, domain, spfValue);
 logMessage(orderId, spf.action === 'created' ? 'SPF record created.' : 'SPF record already present.');

 logMessage(orderId, 'Adding DMARC record...');
 const dmarc = await ensureDmarcRecord(zoneId, domain, dmarcValue);
 logMessage(orderId, dmarc.action === 'created' ? 'DMARC record created.' : 'DMARC record already present.');

 let dkimSuccess = false;
 let lastDkimError = null;

 for (let attempt = 1; attempt <= 3; attempt++) {
 let securitySession = null;
 try {
 logMessage(orderId, `Fetching DKIM selectors via Security Center (Attempt ${attempt}/3)...`);
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

 dkimSuccess = true;
 break;
 } catch (dkimError) {
 lastDkimError = dkimError;
 logMessage(orderId, `DKIM setup issue on attempt ${attempt}: ${dkimError.message}`);
 if (attempt < 3) {
 logMessage(orderId, 'Retrying DKIM setup in 30 seconds...');
 await sleep(30000);
 }
 } finally {
 if (securitySession?.page) {
 try { await securitySession.page.close(); } catch { /* ignore */ }
 }
 if (securitySession?.context) {
 try { await securitySession.context.close(); } catch { /* ignore */ }
 }
 }
 }

 // DKIM failure is treated as a fatal error because inboxes without DKIM
 // will have severe deliverability issues and customers will see 'DKIM missing' errors.
 if (!dkimSuccess) {
 throw new Error(`Critical: DKIM setup failed after 3 attempts. Last error: ${lastDkimError?.message}`);
 }
}

async function runFinalizeOrder(orderId, createdMailboxes, totalMailboxes) {
 logStep(orderId, 13, 'Finalize order');
 if (createdMailboxes.length !== totalMailboxes) {
 throw new Error(`Mailbox creation incomplete: ${createdMailboxes.length}/${totalMailboxes} mailboxes were created`);
 }
 updateOrderProgress(orderId, 100, createdMailboxes);
 updateOrderStatus(orderId, 'completed');
 logMessage(orderId, `Order completed successfully. ${createdMailboxes.length}/${totalMailboxes} mailboxes created and configured.`);
}

export async function processOrder(orderId) {
 if (activeJobs.has(orderId)) {
 return false;
 }
 const order = getOrderById(orderId);
 if (!order) {
 console.error(`Order ${orderId} not found`);
 return false;
 }

 const tenant = getTenantById(order.tenant_id);
 if (!tenant) {
 setOrderError(orderId, 'Tenant not found -- cannot process order');
 return;
 }

 const domain = tenant.domain;
 if (!domain) {
 setOrderError(orderId, 'Tenant missing domain -- cannot process order');
 return;
 }

 const mailboxPassword = order.mailbox_password;
 if (!mailboxPassword) {
 setOrderError(orderId, 'Order missing mailbox password -- cannot create mailboxes');
 return;
 }

 let persistedMailboxes = [];
 try {
 persistedMailboxes = JSON.parse(order.created_mailboxes || '[]');
 } catch {
 setOrderError(
 orderId,
 'Automatic retry blocked because the persisted mailbox state is malformed. Repair or reconcile the order before retrying.'
 );
 return;
 }
 if (!Array.isArray(persistedMailboxes)) {
 setOrderError(
 orderId,
 'Automatic retry blocked because the persisted mailbox state is not a mailbox list. Repair or reconcile the order before retrying.'
 );
 return;
 }
 const { MASTER_CLIENT_ID, MASTER_CLIENT_SECRET } = process.env;
 if (!MASTER_CLIENT_ID || !MASTER_CLIENT_SECRET) {
 setOrderError(orderId, 'Missing Microsoft app credentials (MASTER_CLIENT_ID / MASTER_CLIENT_SECRET) in .env');
 return;
 }

 // MFA is mandatory because the unattended browser flow cannot pause for a
 // person to enter a code.
 if (!tenant.mfa_secret || !isValidTotpSecret(tenant.mfa_secret)) {
 setOrderError(orderId, 'A valid MFA secret is required before this order can be processed');
 return;
 }
 const getTotpCode = () => generateTotpCode(tenant.mfa_secret);
 logMessage(orderId, 'Automatic MFA code generation is configured');

 const total = order.total_mailboxes || 100;
 let requestedMailboxIdentities;
 try {
 requestedMailboxIdentities = parseRequestedMailboxNames(order, total);
 } catch (error) {
 setOrderError(orderId, error.message);
 return;
 }

 const leaseToken = crypto.randomUUID();
 if (!acquireOrderProcessingLease(orderId, leaseToken)) {
 console.log(`[Order ${orderId}] Processing lease is already held; duplicate start ignored.`);
 return false;
 }
 const job = { cancelled: false, logs: [], token: leaseToken, leaseLost: false, heartbeatTimer: null };
 activeJobs.set(orderId, job);
 startProcessingHeartbeat(orderId, job);

 updateOrderStatus(orderId, 'processing');
 clearOrderError(orderId);
 updateOrderProgress(orderId, persistedMailboxes.length ? Number(order.progress || 0) : 0, persistedMailboxes);
 resetUsedNames();
 const preflightWeight = 5;
 const cloudflareWeight = 5;
 const dnsSetupWeight = 10;
 const mailboxCreationWeight = 50;

 logMessage(orderId, `Starting order for ${domain} -- ${total} mailboxes requested`);

 let zoneId = tenant.cloudflare_zone_id;
 let graphProvider = null;
 let globalAdminRoleId = null;
 let exchangeOrgDomain = null;
 let browserContext = null;
 let page = null;
 let mailboxAdminSessionPromise = null;
 let delegatedExchangeSession = null;
 let delegatedExchangeSessionPromise = null;
 let createdMailboxes = persistedMailboxes;
 const claimedAliases = new Set(createdMailboxes.map(mailbox => String(mailbox.email || '').split('@')[0].toLowerCase()));
 const identityForIndex = (index) => {
 const requested = requestedMailboxIdentities?.[index];
 if (requested) {
 claimedAliases.add(requested.alias.toLowerCase());
 return requested;
 }
 for (let attempt = 0; attempt < 2000; attempt++) {
 const generated = generateMailboxName();
 if (!claimedAliases.has(generated.alias.toLowerCase())) {
 claimedAliases.add(generated.alias.toLowerCase());
 return generated;
 }
 }
 throw new Error('Could not generate a unique mailbox identity');
 };
 const ensureDelegatedExchangeSession = async () => {
 if (delegatedExchangeSession) return delegatedExchangeSession;
 if (delegatedExchangeSessionPromise) return delegatedExchangeSessionPromise;
 const updatedTenant = getTenantByIdForUser(tenant.id, tenant.user_id);
 if (!updatedTenant?.mfa_secret || !isValidTotpSecret(updatedTenant.mfa_secret)) {
 throw new Error('The tenant MFA secret is missing or invalid');
 }
 delegatedExchangeSessionPromise = createDelegatedExchangeSession({
 email: updatedTenant.admin_email,
 password: updatedTenant.admin_password,
 mfaSecret: updatedTenant.mfa_secret,
 getTotpCode: () => generateTotpCode(updatedTenant.mfa_secret),
 log: message => logMessage(orderId, message)
 });
 try {
 delegatedExchangeSession = await delegatedExchangeSessionPromise;
 logMessage(orderId, 'Alternate secure Microsoft connection established.');
 return delegatedExchangeSession;
 } catch (error) {
 delegatedExchangeSessionPromise = null;
 throw error;
 }
 };
 const ensureMailboxAdminSession = async () => {
 if (page && browserContext) return page;
 if (mailboxAdminSessionPromise) return mailboxAdminSessionPromise;

 mailboxAdminSessionPromise = (async () => {
 let newContext = null;
 let newPage = null;
 try {
 const session = await createIncognitoPage();
 newContext = session.context;
 newPage = session.page;
 newPage.setDefaultTimeout(60000);

 const updatedTenant = getTenantByIdForUser(tenant.id, tenant.user_id);
 if (!updatedTenant?.mfa_secret || !isValidTotpSecret(updatedTenant.mfa_secret)) {
 throw new Error('The tenant MFA secret is missing or invalid');
 }
 const freshGetTotpCode = () => generateTotpCode(updatedTenant.mfa_secret);
 logMessage(orderId, 'Automatic MFA code generation is ready for Microsoft login');
 logMessage(orderId, 'Establishing a secure Microsoft 365 admin session...');

 const loginResult = await loginToMicrosoft365(
 newPage,
 updatedTenant.admin_email,
 updatedTenant.admin_password,
 newContext,
 freshGetTotpCode
 );
 if (!loginResult?.success) {
 const loginError = String(loginResult?.error || 'Unknown login error');
 let errorMsg = `Login failed: ${loginError}`;
 if (loginError.includes('Login page still shown after attempts')) {
 errorMsg = 'Microsoft 365 login failed -- MFA is required. Please ensure your admin account has MFA registered and the MFA secret is added to the tenant.';
 } else if (loginError.includes('Invalid username or password')) {
 errorMsg = 'Invalid admin email or password -- please check your credentials in the tenant settings.';
 }
 throw new Error(errorMsg);
 }

 browserContext = newContext;
 page = loginResult.page || newPage;
 logMessage(orderId, 'Microsoft 365 admin session established successfully.');
 return page;
 } catch (error) {
 if (newPage) {
 try { await newPage.close(); } catch { /* ignore */ }
 }
 if (newContext) {
 try { await newContext.close(); } catch { /* ignore */ }
 }
 throw error;
 }
 })();

 try {
 return await mailboxAdminSessionPromise;
 } catch (error) {
 mailboxAdminSessionPromise = null;
 throw error;
 }
 };

 try {
 // STEP 1: Preflight checks
 try {
 logStep(orderId, 1, 'Preflight: verify tenant, domain, credentials, and tenant_id');
 const validatedTenant = await runPreflightChecks(orderId, order, tenant);
 if (validatedTenant.tenant_id !== tenant.tenant_id) {
 tenant.tenant_id = validatedTenant.tenant_id;
 }
 updateOrderProgress(orderId, Math.max(preflightWeight, Number(order.progress || 0)), createdMailboxes);
 if (checkCancelled(orderId)) return;
 } catch (err) {
 logMessage(orderId, `STEP 1 FAILED: ${err.message}`);
 throw new Error(`Preflight checks failed: ${err.message}`);
 }

 // STEP 2: Cloudflare zone setup
 try {
 logStep(orderId, 2, 'Cloudflare: create/verify zone for domain');
 zoneId = await runSetupCloudflareZone(orderId, domain, tenant);
 updateOrderProgress(orderId, Math.max(preflightWeight + cloudflareWeight, Number(order.progress || 0)), createdMailboxes);
 if (checkCancelled(orderId)) return;
 } catch (err) {
 logMessage(orderId, `STEP 2 FAILED: ${err.message}`);
 throw new Error(`Cloudflare zone setup failed: ${err.message}`);
 }

 // STEP 3: Update nameservers
 try {
 logStep(orderId, 3, 'Nameservers: ensure domain NS records point to Cloudflare');
 await runUpdateNameservers(orderId, zoneId, tenant);
 if (tenant.redirect_url) {
 await upsertZoneRedirect(zoneId, domain, tenant.redirect_url);
 logMessage(orderId, 'Domain redirect configured.');
 }
 if (checkCancelled(orderId)) return;
 } catch (err) {
 logMessage(orderId, `STEP 3 FAILED: ${err.message}`);
 throw new Error(`Nameserver update failed: ${err.message}`);
 }

 // STEP 4: Add domain to Microsoft 365
 try {
 logStep(orderId, 4, 'Microsoft: add domain to tenant (with auto-consent on 401)');
 const match = await runAddDomainToMicrosoft(orderId, tenant, getTotpCode);
 if (checkCancelled(orderId)) return;
 tenant._domainMatch = match;
 } catch (err) {
 logMessage(orderId, `STEP 4 FAILED: ${err.message}`);
 throw new Error(`Add domain to Microsoft failed: ${err.message}`);
 }

 // STEP 5: Verify domain ownership
 try {
 logStep(orderId, 5, 'Microsoft: verify domain ownership via TXT record');
 const verifyResult = await runVerifyDomain(orderId, zoneId, tenant, tenant._domainMatch);
 if (checkCancelled(orderId)) return;
 tenant._verifyResult = verifyResult;
 } catch (err) {
 logMessage(orderId, `STEP 5 FAILED: ${err.message}`);
 throw new Error(`Domain verification failed: ${err.message}`);
 }

 // STEP 6: Add Exchange DNS records
 try {
 logStep(orderId, 6, 'DNS: add MX, SPF, DKIM, and DMARC records');
 await runAddExchangeDnsRecords(orderId, zoneId, domain, tenant._verifyResult);
 if (checkCancelled(orderId)) return;
 } catch (err) {
 logMessage(orderId, `STEP 6 FAILED: ${err.message}`);
 throw new Error(`Exchange DNS records setup failed: ${err.message}`);
 }

 // STEP 7: Prepare Graph admin client
 try {
 logStep(orderId, 7, 'Microsoft: prepare secure admin permissions');
 const graphSetup = await runPrepareGraphAdminClient(orderId, tenant);
 graphProvider = graphSetup.graphProvider;
 globalAdminRoleId = graphSetup.globalAdminRoleId;
 exchangeOrgDomain = isExchangePowerShellConfigured() ? graphSetup.exchangeOrgDomain : null;
 if (checkCancelled(orderId)) return;
 } catch (err) {
 logMessage(orderId, `STEP 7 FAILED: ${err.message}`);
 throw new Error(`Microsoft admin permission setup failed: ${err.message}`);
 }

 // STEP 8: Disable Security Defaults
 try {
 logStep(orderId, 8, 'Security: disable Security Defaults (graceful if not possible)');
 await runDisableSecurityDefaults(orderId, graphProvider);
 if (checkCancelled(orderId)) return;
 } catch (err) {
 logMessage(orderId, `STEP 8 info: ${err.message}`);
 logMessage(orderId, 'Continuing despite Security Defaults disable failure -- some tenants require them');
 }

 // STEP 9: Connect to Exchange Online
 try {
 logStep(orderId, 9, exchangeOrgDomain
 ? 'Microsoft 365: validate secure mailbox connection'
 : 'Microsoft 365: establish a secure admin session');
 if (exchangeOrgDomain) {
 const connection = await testExchangeOnlineConnection(exchangeOrgDomain);
 logMessage(orderId, `Secure mailbox connection ready (${connection.AcceptedDomainCount} accepted domain(s)).`);
 } else {
 logMessage(orderId, 'Using automatic Microsoft 365 connection fallback.');
 if (checkCancelled(orderId)) return;
 await ensureMailboxAdminSession();
 }
 if (checkCancelled(orderId)) return;
 } catch (err) {
 logMessage(orderId, `STEP 9 FAILED: ${err.message}`);
 throw new Error(`Exchange connection failed: ${err.message}`);
 }

 // STEP 10: Enable SMTP AUTH before mailbox creation
 try {
 logStep(orderId, 10, 'Prepare mailbox sending access');
 await runConfigureSmtpAuth(orderId, page, exchangeOrgDomain);
 if (checkCancelled(orderId)) return;
 } catch (err) {
 logMessage(orderId, `STEP 10 FAILED: ${err.message}`);
 throw new Error(`SMTP AUTH configuration failed: ${err.message}`);
 }

 // STEP 11: Preflight mailbox creation + full enablement
 try {
 logStep(orderId, 11, 'Preflight: create 1 mailbox and fully enable sign-in + Global Admin');
 let preflight;
 if (createdMailboxes.length) {
 preflight = [createdMailboxes[0]];
 } else {
 const preflightIdentity = identityForIndex(0);
 try {
 preflight = await runCreateMailboxes(
 orderId,
 1,
 domain,
 mailboxPassword,
 page,
 [preflightIdentity],
 exchangeOrgDomain,
 delegatedExchangeSession
 );
 } catch (preflightError) {
 if (!exchangeOrgDomain || !isExternalDirectoryMemberCreationError(preflightError)) {
 throw preflightError;
 }
 logMessage(orderId, 'Mailbox provisioning needs automatic recovery; establishing an alternate secure connection.');
 await ensureDelegatedExchangeSession();
 exchangeOrgDomain = null;
 preflight = await runCreateMailboxes(
 orderId,
 1,
 domain,
 mailboxPassword,
 page,
 [preflightIdentity],
 exchangeOrgDomain,
 delegatedExchangeSession
 );
 }
 }
 if (preflight.length === 0) {
 throw new Error('Preflight mailbox creation returned no mailboxes');
 }
 if (!createdMailboxes.length) createdMailboxes = preflight;
 updateOrderProgress(orderId, preflightWeight + cloudflareWeight + dnsSetupWeight, createdMailboxes);

 const pfMailbox = createdMailboxes[0];
 let userId = pfMailbox.objectId;
 userId = await resolveUserId(graphProvider, pfMailbox.email, userId);
 if (!userId) {
 throw new Error(`Preflight failed: user object id not returned for ${pfMailbox.email}`);
 }
 createdMailboxes[0].objectId = userId;
 persistCreatedMailboxes(orderId, createdMailboxes);

 await sleep(5000);
 if (checkCancelled(orderId, 'Order cancelled during preflight.')) return;

 const upnResult = await retryAdminAction(
 orderId,
 'UPN update (preflight)',
 () => runGraphAction(graphProvider, client => updateUserUpnWithClient(client, userId, pfMailbox.email)),
 4,
 5000
 );
 if (!upnResult?.success) {
 logMessage(orderId, `Preflight: UPN update issue for ${pfMailbox.email}: ${upnResult?.error || 'Unknown'}`);
 }

 const enableResult = await retryAdminAction(
 orderId,
 'Sign-in enable + password (preflight)',
 () => runGraphAction(graphProvider, client => enableSignInAndSetPasswordWithClient(client, userId, mailboxPassword)),
 6,
 5000
 );
 if (!enableResult?.success) {
 throw new Error(`Preflight sign-in enable failed: ${enableResult?.error || 'Unknown error'}`);
 }
 logMessage(orderId, `Preflight: sign-in enabled for ${pfMailbox.email}`);

 const roleResult = await retryAdminAction(
 orderId,
 'Global Admin assign (preflight)',
 () => runGraphAction(graphProvider, client => assignGlobalAdminWithClient(client, userId, globalAdminRoleId)),
 4,
 5000
 );
 if (!roleResult?.success) {
 throw new Error(`Preflight Global Admin assign failed: ${roleResult?.error || 'Unknown error'}`);
 }
 logMessage(orderId, `Preflight: Global Admin assigned to ${pfMailbox.email}`);
 } catch (err) {
 logMessage(orderId, `STEP 11 FAILED: ${err.message}`);
 throw new Error(`Preflight mailbox creation failed: ${err.message}`);
 }

 // STEP 12: Create remaining mailboxes
 if (total > 1) {
 try {
 logStep(orderId, 12, `Create remaining ${total - 1} mailboxes`);
 const remainingCount = total - 1;
 const persistedEmails = new Set(createdMailboxes.map(mailbox => String(mailbox.email || '').toLowerCase()));
 const remainingIndexes = requestedMailboxIdentities
 ? requestedMailboxIdentities
 .map((identity, index) => ({ identity, index }))
 .filter(({ identity }) => !persistedEmails.has(`${identity.alias}@${domain}`.toLowerCase()))
 .map(({ index }) => index)
 : Array.from({ length: Math.max(0, total - createdMailboxes.length) }, (_, offset) => createdMailboxes.length + offset);
 if (exchangeOrgDomain || delegatedExchangeSession) {
 const batchSize = 10;
 for (let batchOffset = 0; batchOffset < remainingIndexes.length; batchOffset += batchSize) {
 if (checkCancelled(orderId, 'Order cancelled during mailbox creation.')) {
 throw new Error('Order cancelled by user');
 }

 const batch = [];
 const batchIndexes = remainingIndexes.slice(batchOffset, batchOffset + batchSize);
 for (const i of batchIndexes) {
 const { fullName, alias } = identityForIndex(i);
 batch.push({ fullName, alias });
 logMessage(orderId, `[${i + 1}/${total}] Queued mailbox: ${fullName} (${alias}@${domain})`);
 }

 const mailboxRequests = batch.map(item => ({
 displayName: item.fullName,
 alias: item.alias,
 password: mailboxPassword
 }));
 const results = delegatedExchangeSession
 ? await delegatedExchangeSession.ensureSharedMailboxes({ domain, mailboxes: mailboxRequests })
 : await ensureSharedMailboxes({ orgDomain: exchangeOrgDomain, domain, mailboxes: mailboxRequests });
 const failures = [];
 for (const result of results) {
 const request = batch[result.index];
 if (!request) {
 failures.push(`Exchange returned an invalid batch index: ${result.index}`);
 continue;
 }
 if (!result.success) {
 failures.push(`${result.email || `${request.alias}@${domain}`}: ${result.error || 'Unknown error'}`);
 logMessage(orderId, ` FAILED: ${failures[failures.length - 1]}`);
 continue;
 }
 createdMailboxes.push({
 name: request.fullName,
 email: result.email,
 password: mailboxPassword,
 objectId: result.externalDirectoryObjectId,
 createdAt: new Date().toISOString()
 });
 logMessage(
 orderId,
 result.created
 ? ` Created: ${result.email}`
 : ` Confirmed existing: ${result.email}`
 );
 }

 const processedRemaining = Math.max(0, createdMailboxes.length - 1);
 const progress = preflightWeight + cloudflareWeight + dnsSetupWeight
 + Math.round((processedRemaining / remainingCount) * mailboxCreationWeight);
 updateOrderProgress(orderId, progress, createdMailboxes);
 logMessage(orderId, `Persisted mailbox batch (${createdMailboxes.length}/${total} ready).`);
 if (failures.length) {
 throw new Error(`Mailbox batch had ${failures.length} failure(s): ${failures.join('; ')}`);
 }
 }
 } else {
 for (const i of remainingIndexes) {
 if (checkCancelled(orderId, 'Order cancelled during mailbox creation.')) {
 throw new Error('Order cancelled by user');
 }

 const { fullName, alias } = identityForIndex(i);
 logMessage(orderId, `[${i + 1}/${total}] Creating mailbox: ${fullName} (${alias}@${domain})`);

 const result = await createMailbox(orderId, page, exchangeOrgDomain, fullName, alias, domain, mailboxPassword, delegatedExchangeSession);
 if (result.success) {
 const email = result.email;
 createdMailboxes.push({
 name: fullName,
 email,
 password: mailboxPassword,
 objectId: result.externalDirectoryObjectId || result.objectId,
 createdAt: new Date().toISOString()
 });
 logMessage(orderId, ` Created: ${email}`);
 } else {
 logMessage(orderId, ` FAILED: ${result.error}`);
 }

 const createdCount = Math.max(0, createdMailboxes.length - 1);
 const progress = preflightWeight + cloudflareWeight + dnsSetupWeight + Math.round((createdCount / remainingCount) * mailboxCreationWeight);
 updateOrderProgress(orderId, progress, createdMailboxes);
 await sleep(1500);
 }
 }
 logMessage(orderId, `Mailbox creation complete: ${createdMailboxes.length}/${total} created`);
 } catch (err) {
 logMessage(orderId, `STEP 12 FAILED: ${err.message}`);
 throw new Error(`Mailbox creation failed: ${err.message}`);
 }
 }

 // STEP 13: Enable sign-in and set passwords
 try {
 logStep(orderId, 13, 'Enable sign-in and set passwords for all mailboxes');
 await runEnableSignIn(orderId, createdMailboxes, mailboxPassword, graphProvider);
 if (checkCancelled(orderId)) return;
 } catch (err) {
 logMessage(orderId, `STEP 13 FAILED: ${err.message}`);
 throw new Error(`Sign-in enablement failed: ${err.message}`);
 }

 // Reconcile Exchange after Graph UPN updates. Microsoft can briefly restore
 // the onmicrosoft.com address as primary while the backing user converges.
 try {
 logStep(orderId, 14, 'Reconcile Exchange primary SMTP and mailbox SMTP AUTH');
 await runReconcileExchangeMailboxes(orderId, createdMailboxes, domain, exchangeOrgDomain, delegatedExchangeSession);
 updateOrderProgress(orderId, 70, createdMailboxes);
 if (checkCancelled(orderId)) return;
 } catch (err) {
 logMessage(orderId, `STEP 14 FAILED: ${err.message}`);
 throw new Error(`Exchange mailbox reconciliation failed: ${err.message}`);
 }

 // STEP 14: Assign Global Admin roles
 try {
 logStep(orderId, 14, 'Assign Global Admin role to all mailboxes');
 const userIdByEmail = new Map();
 for (const mailbox of createdMailboxes) {
 const userId = mailbox.objectId || await resolveUserId(graphProvider, mailbox.email, mailbox.objectId);
 if (userId) {
 userIdByEmail.set(mailbox.email, userId);
 mailbox.objectId = userId;
 }
 }

 for (let i = 0; i < createdMailboxes.length; i++) {
 if (checkCancelled(orderId, 'Order cancelled before role assignment.')) {
 throw new Error('Order cancelled by user');
 }

 const mailbox = createdMailboxes[i];
 const userId = userIdByEmail.get(mailbox.email);
 if (!userId) {
 throw new Error(`Missing Microsoft user object id for ${mailbox.email} during role assignment`);
 }

 const roleResult = await retryAdminAction(
 orderId,
 `Global Admin assign (${mailbox.email})`,
 () => runGraphAction(graphProvider, client => assignGlobalAdminWithClient(client, userId, globalAdminRoleId)),
 4,
 4000
 );
 if (!roleResult?.success) {
 throw new Error(`Global Admin assign failed for ${mailbox.email}: ${roleResult?.error || 'Unknown error'}`);
 } else {
 logMessage(orderId, ` Global Admin assigned to ${mailbox.email}`);
 }
 }
 } catch (err) {
 logMessage(orderId, `STEP 14 FAILED: ${err.message}`);
 throw new Error(`Global Admin assignment failed: ${err.message}`);
 }

 // STEP 15: Email authentication
 try {
 logStep(orderId, 15, 'Configure email authentication (SPF, DKIM, DMARC)');
 await runConfigureEmailAuth(orderId, zoneId, domain, tenant, getTotpCode);
 if (checkCancelled(orderId)) return;
 } catch (err) {
 logMessage(orderId, `STEP 15 FAILED: ${err.message}`);
 throw new Error(`Email authentication setup failed: ${err.message}`);
 }

 // FINAL: Complete order
 await runFinalizeOrder(orderId, createdMailboxes, total);

 } catch (error) {
 const job = activeJobs.get(orderId);
 if (job?.leaseLost) {
 console.error(`[Order ${orderId}] Stopped because another worker owns the execution lease.`);
 } else {
 if (createdMailboxes.length) {
 try { persistCreatedMailboxes(orderId, createdMailboxes); } catch { /* Preserve the original failure. */ }
 }
 logMessage(orderId, `FATAL ERROR: ${error.message}`);
 setOrderError(orderId, error.message);
 updateOrderStatus(orderId, 'failed');
 }
 } finally {
 if (delegatedExchangeSession) {
 try { await delegatedExchangeSession.close(); } catch { /* ignore */ }
 }
 if (page) {
 try { await page.close(); } catch (e) { }
 }
 if (browserContext) {
 try { await browserContext.close(); } catch (e) { }
 }
 const job = activeJobs.get(orderId);
 if (job?.heartbeatTimer) clearInterval(job.heartbeatTimer);
 activeJobs.delete(orderId);
 releaseOrderProcessingLease(orderId, leaseToken);
 logMessage(orderId, 'Order processing finished.');
 }
 return true;
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
 const staleCutoffMs = Date.now() - (15 * 60 * 1000);
 const interrupted = getOrders()
 .filter(order => {
 if (order.status !== 'processing' || activeJobs.has(order.id)) return false;
 if (!order.updated_at) return true;
 const normalized = String(order.updated_at).includes('T')
 ? String(order.updated_at)
 : `${order.updated_at}Z`;
 const updatedAtMs = Date.parse(normalized);
 return !Number.isFinite(updatedAtMs) || updatedAtMs < staleCutoffMs;
 });

 for (const order of interrupted) {
 logMessage(order.id, 'Processing was interrupted. Resuming from the last persisted mailbox checkpoint.');
 void processOrder(order.id);
 }
}
