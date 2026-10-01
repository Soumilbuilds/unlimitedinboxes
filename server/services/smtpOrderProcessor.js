import { randomUUID } from 'node:crypto';
import { getUserAccessState } from './access.js';
import { getSmtpRuntime } from './smtpRuntime.js';
import { parseSmtpJson, publicSmtpError } from './smtpPublic.js';
import { smtpError } from './smtpValidation.js';

const ACTIVE = ['processing', 'waiting_dns', 'waiting_verification'];
const RETRYABLE = new Set(['RESEND_RATE_LIMITED', 'RESEND_UNAVAILABLE', 'DNS_UNAVAILABLE', 'SERVICE_UNAVAILABLE', 'MAIL_INFRASTRUCTURE_UNAVAILABLE']);

export function createSmtpProcessor(dependencies) {
  const { repository: repo, dns, mailInfrastructure: mail, secretStore, resendFactory } = dependencies;
  const accessFor = dependencies.getAccessState || getUserAccessState;
  const jobs = new Map();
  let stopped = false;
  let timer;
  let scanning = false;

  async function withLease(id, operation) {
    if (stopped || jobs.has(id)) return repo.getOrder(id);
    const token = randomUUID();
    if (!repo.acquireLease(id, token)) return repo.getOrder(id);
    const job = { token, lost: false };
    const check = () => {
      if (stopped || job.lost) throw smtpError('LEASE_LOST', 409);
      return repo.assertLease(id, token);
    };
    const call = async action => {
      check();
      repo.assertOwnership(id, token);
      if (check().started_at) repo.assertQuota(id, token);
      const result = await action();
      check();
      return result;
    };
    const update = values => { check(); return repo.updateOrder(id, values, token); };
    const log = message => { check(); repo.addLog(id, message, token); };
    const pulse = setInterval(() => {
      try { if (!repo.heartbeat(id, token)) job.lost = true; } catch { job.lost = true; }
    }, 20000);
    pulse.unref?.();
    const execution = (async () => {
      try {
        const row = check();
        const user = repo.getUser(row.user_id);
        if (!user || !accessFor(user).canAccessApp) throw smtpError('BILLING_REQUIRED', 403);
        const connection = repo.getConnection(row.user_id);
        if (!connection || connection.status !== 'connected') throw smtpError('RESEND_CONNECTION_REQUIRED', 409);
        const key = await call(() => secretStore.get(connection.secret_ref));
        if (!key) throw smtpError('RESEND_CONNECTION_INVALID', 409);
        const resend = resendFactory(key);
        return await operation({ id, token, check, call, update, log, resend, connection });
      } catch (error) {
        try {
          const current = check();
          const safe = publicSmtpError(error);
          if (['RESEND_INVALID_KEY', 'RESEND_FULL_ACCESS_REQUIRED'].includes(safe.code)) {
            const connection = repo.getConnection(current.user_id);
            if (connection) repo.updateConnection(current.user_id, connection.secret_ref, {
              ...connection, status: 'invalid',
            });
          }
          const attempts = Number(current.attempt_count || 0) + 1;
          const retry = (ACTIVE.includes(current.status) || !current.started_at) && RETRYABLE.has(safe.code) && attempts <= 8;
          update({ status: retry ? (current.started_at ? 'waiting_verification' : 'draft') : 'failed', error_code: safe.code, attempt_count: attempts,
            due_at: retry ? Date.now() + Math.max(Number(error.retryAfterMs) || 0, Math.min(1800000, 30000 * 2 ** Math.min(attempts, 6))) : 0 });
          log(retry ? 'Provisioning Paused' : 'Provisioning Could Not Be Completed');
        } catch { /* Cancellation, shutdown or lease loss must never write stale state. */ }
        return repo.getOrder(id);
      } finally {
        clearInterval(pulse);
        try { repo.releaseLease(id, token); } catch { /* The lease expires safely if DB is unavailable. */ }
      }
    })();
    jobs.set(id, execution);
    try { return await execution; } finally { jobs.delete(id); }
  }

  async function ensureOwnedResource(ctx, kind, name, discover, create, remoteId, credentialRef) {
    const { id, token, check, call } = ctx;
    const receipt = repo.getResourceClaim(id, kind, name);
    const existing = await call(discover);
    if (receipt?.remote_id) {
      if (!existing || remoteId(existing) !== receipt.remote_id) throw smtpError('DOMAIN_UNAVAILABLE', 409);
      return { ...existing, credentialRef: receipt.credential_ref };
    }
    // A pending intent or staged password cannot distinguish our lost response
    // from an external creator. Require a confirmed creation, never silent reuse.
    if (existing) throw smtpError('DOMAIN_UNAVAILABLE', 409);
    const intent = repo.beginResourceCreation(id, kind, name, token);
    check();
    repo.assertOwnership(id, token);
    if (check().started_at) repo.assertQuota(id, token);
    const result = await create();
    if (result?.created !== true) throw smtpError('DOMAIN_UNAVAILABLE', 409);
    repo.recordResourceCreation(id, kind, name, intent.operation_token, {
      created: true, remoteId: remoteId(result), credentialRef: credentialRef?.(result),
    });
    check();
    return result;
  }

  async function prepareSteps(ctx) {
    const { call, check, update, log, resend } = ctx;
    let row = check();
    const claim = repo.getDomainClaim(row.domain);
    if (!claim || claim.user_id !== row.user_id || claim.order_id !== row.id) throw smtpError('DOMAIN_UNAVAILABLE', 409);
    log('Preparing Domain');
    // Both shared infrastructure discoveries happen before the first Resend,
    // Cloudflare or mail-provider mutation. A connected API key is not proof
    // that the customer owns a domain already hosted by the platform.
    const existingMail = await call(() => mail.getDomain(row.domain));
    const mailReceipt = repo.getResourceClaim(row.id, 'domain', row.domain);
    if (existingMail && existingMail.id !== mailReceipt?.remote_id) throw smtpError('DOMAIN_UNAVAILABLE', 409);
    const existingZone = await call(() => dns.findSmtpZone(row.domain));
    const zoneReceipt = repo.getResourceClaim(row.id, 'zone', row.domain);
    if (existingZone && existingZone.zoneId !== zoneReceipt?.remote_id) throw smtpError('DOMAIN_UNAVAILABLE', 409);
    update({ ownership_checked: 1 });
    row = check();
    let remote;
    if (!row.resend_domain_id) {
      update({ side_effects: 1 });
      remote = await call(() => resend.ensureDomain(row.domain));
      update({ resend_domain_id: remote.id, resend_status: remote.status });
    } else {
      remote = await call(() => resend.getDomain(row.resend_domain_id));
      if (remote.name !== row.domain) throw smtpError('DOMAIN_UNAVAILABLE', 409);
    }
    row = check();
    if (!row.cloudflare_zone_id) {
      update({ side_effects: 1 });
      const zone = await ensureOwnedResource(ctx, 'zone', row.domain,
        () => dns.findSmtpZone(row.domain), () => dns.ensureSmtpZone(row.domain), zone => zone?.zoneId);
      update({ cloudflare_zone_id: zone.zoneId, cloudflare_ns: JSON.stringify(zone.nameServers) });
    } else {
      if (zoneReceipt?.remote_id !== row.cloudflare_zone_id) throw smtpError('DOMAIN_UNAVAILABLE', 409);
      const zone = await call(() => dns.ensureSmtpZone(row.domain, { ownedZoneId: row.cloudflare_zone_id }));
      update({ cloudflare_ns: JSON.stringify(zone.nameServers) });
    }
    row = check();
    log('Applying DNS Records');
    const records = await call(() => dns.reconcileSmtpDns({ domain: row.domain,
      zoneId: row.cloudflare_zone_id, records: remote.records }));
    update({ required_dns: JSON.stringify(records), status: row.started_at ? 'processing' : (row.nameservers_connected ? 'ready' : 'pending_nameservers'),
      progress: 10, error_code: null, attempt_count: 0, due_at: row.started_at ? Date.now() : 0 });
    log(row.nameservers_connected ? 'Nameservers Connected' : 'Waiting For Nameservers');
    return check();
  }

  const prepareOrder = id => withLease(id, prepareSteps);
  const processOrder = id => withLease(id, async ctx => {
    const { call, check, update, log, resend, token } = ctx;
    let row = check();
    if (row.status === 'draft') return prepareSteps(ctx);
    if (!ACTIVE.includes(row.status)) return row;
    const wait = (status, message, delay = 60000) => {
      const current = check();
      update({ status, due_at: Date.now() + delay, attempt_count: 0, error_code: null });
      log(message);
      return { ...current, status };
    };
    const ns = await call(() => dns.checkSmtpNameservers({ domain: row.domain, zoneId: row.cloudflare_zone_id,
      nameServers: parseSmtpJson(row.cloudflare_ns) }));
    if (!ns.connected) {
      update({ nameservers_connected: 0 });
      return wait('waiting_dns', 'Waiting For Nameservers');
    }
    update({ nameservers_connected: 1 });
    log('Nameservers Connected');
    row = check();
    await ensureOwnedResource(ctx, 'domain', row.domain,
      () => mail.getDomain(row.domain), () => mail.ensureDomain(row.domain), item => item?.id);
    if (!row.mail_domain_owned) {
      update({ mail_domain_owned: 1, progress: 20 });
    }
    log('Configuring Email Authentication');
    const auth = await call(() => mail.ensureDomainAuthentication(row.domain));
    const infrastructureRecords = await call(() => mail.getRequiredDnsRecords(row.domain));
    const resendDomain = await call(() => resend.getDomain(row.resend_domain_id));
    if (resendDomain.name !== row.domain) throw smtpError('DOMAIN_UNAVAILABLE', 409);
    log('Applying DNS Records');
    const required = await call(() => dns.reconcileSmtpDns({ domain: row.domain, zoneId: row.cloudflare_zone_id,
      records: [...resendDomain.records, ...infrastructureRecords, ...auth.records] }));
    update({ required_dns: JSON.stringify(required), progress: Math.max(30, Number(check().progress)) });
    const publicDns = await call(() => dns.verifySmtpDns({ domain: row.domain,
      nameServers: parseSmtpJson(row.cloudflare_ns), records: required }));
    if (!publicDns.ready) {
      update({ dns_verified: 0 });
      return wait('waiting_dns', 'Waiting For DNS');
    }
    update({ dns_verified: 1 });
    if (resendDomain.status !== 'verified') {
      await call(() => resend.verifyDomain(row.resend_domain_id));
      const verified = await call(() => resend.getDomain(row.resend_domain_id));
      update({ resend_status: verified.status, resend_verified: Number(verified.status === 'verified') });
      if (verified.status !== 'verified') return wait('waiting_verification', 'Waiting For Email Authentication', 90000);
    } else update({ resend_status: 'verified', resend_verified: 1 });
    update({ status: 'processing', due_at: 0, progress: Math.max(40, Number(check().progress)) });
    const items = repo.getMailboxes(row.id);
    if (!items.length || items.length !== row.total_mailboxes) throw smtpError('INVALID_MAILBOX_QUANTITY');
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      check();
      log(`Creating Inbox ${index + 1} Of ${items.length}`);
      if (!item.credential_ref) {
        const inbox = await ensureOwnedResource(ctx, 'mailbox', item.email,
          () => mail.getMailbox(item.email), () => mail.ensureMailbox(item.email), item => item?.id,
          item => item?.credentialRef);
        if (!inbox.credentialRef) throw smtpError('MAILBOX_PROVISIONING_FAILED', 503);
        repo.checkpointMailbox(row.id, item.local_part, { credential_ref: inbox.credentialRef, status: 'created' }, token);
      } else {
        const receipt = repo.getResourceClaim(row.id, 'mailbox', item.email);
        const current = await call(() => mail.getMailbox(item.email));
        if (!receipt?.remote_id || current?.id !== receipt.remote_id || receipt.credential_ref !== item.credential_ref) {
          throw smtpError('DOMAIN_UNAVAILABLE', 409);
        }
      }
      log('Testing SMTP');
      log('Testing IMAP');
      const health = await call(() => mail.verifyMailbox(item.email));
      if (!health?.smtp || !health?.imap) throw smtpError('MAILBOX_PROVISIONING_FAILED', 503);
      repo.checkpointMailbox(row.id, item.local_part, { status: 'verified' }, token);
      update({ progress: Math.round(40 + ((index + 1) / items.length) * 50) });
    }
    log('Running Final Checks');
    if (await call(() => mail.verifyRelaySecurity()) !== true) throw smtpError('MAILBOX_PROVISIONING_FAILED', 503);
    update({ relay_verified: 1 });
    // Revalidate public DNS after all side effects before granting completion.
    const finalDns = await call(() => dns.verifySmtpDns({ domain: row.domain,
      nameServers: parseSmtpJson(row.cloudflare_ns), records: required }));
    if (!finalDns.ready) {
      update({ dns_verified: 0 });
      return wait('waiting_dns', 'Waiting For DNS');
    }
    const finalResend = await call(() => resend.getDomain(row.resend_domain_id));
    if (finalResend.name !== row.domain) throw smtpError('DOMAIN_UNAVAILABLE', 409);
    if (finalResend.status !== 'verified') {
      update({ resend_verified: 0, resend_status: finalResend.status });
      return wait('waiting_verification', 'Waiting For Email Authentication', 90000);
    }
    check();
    return repo.completeOrder(row.id, token);
  });

  async function tick() {
    if (stopped || scanning) return;
    scanning = true;
    try {
      const available = Math.max(0, 4 - jobs.size);
      const due = repo.dueOrders(available || 1).filter(row => !jobs.has(row.id)).slice(0, available);
      await Promise.allSettled(due.map(row => processOrder(row.id)));
    } catch { /* Scheduler failures are retried; no provider exceptions are logged. */ }
    finally { scanning = false; }
  }
  return {
    prepareOrder, processOrder,
    hasActiveJob: id => jobs.has(id),
    start() {
      stopped = false;
      if (!timer) { timer = setInterval(() => { void tick(); }, 15000); timer.unref?.(); }
      void tick();
      return this;
    },
    async stop() {
      stopped = true;
      clearInterval(timer); timer = null;
      await Promise.allSettled([...jobs.values()]);
    },
    tick,
  };
}

let defaultProcessor;
export function getSmtpProcessor() { return defaultProcessor ??= createSmtpProcessor(getSmtpRuntime()); }
export function startSmtpWorker() {
  try { return getSmtpProcessor().start(); }
  catch { console.warn('SMTP provisioning configuration is unavailable.'); return null; }
}
export async function stopSmtpWorker() { await defaultProcessor?.stop(); }
