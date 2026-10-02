import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { getUserAccessState } from '../services/access.js';
import { smtpError, normalizeSmtpDomain, normalizeSmtpMailboxNames, normalizeResendKey } from '../services/smtpValidation.js';
import { publicSmtpError, publicSmtpOrder, publicSmtpConnection, parseSmtpJson, safeSmtpLog } from '../services/smtpPublic.js';

const ACTIVE = new Set(['processing', 'waiting_dns', 'waiting_verification']);
const loadRuntime = async () => (await import('../services/smtpRuntime.js')).getSmtpRuntime();
const loadProcessor = async () => (await import('../services/smtpOrderProcessor.js')).getSmtpProcessor();

// No secrets, database, or SMTP configuration are loaded until an authenticated request.
export function createSmtpRouter({ getRuntime = loadRuntime, getProcessor = loadProcessor, getAccessState = getUserAccessState } = {}) {
  const router = Router();
  const fail = (res, error) => {
    const safe = publicSmtpError(error);
    return res.status(safe.status).json(safe);
  };
  const route = handler => async (req, res) => {
    try { await handler(req, res); } catch (error) { fail(res, error); }
  };
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    if (!req.session?.authenticated || !req.session?.user?.id) return fail(res, smtpError('UNAUTHORIZED'));
    next();
  });
  router.use(async (req, res, next) => {
    try {
      req.smtpRuntime = await getRuntime();
      req.smtpUser = req.smtpRuntime.repository.getUser(req.session.user.id);
      if (!req.smtpUser) return fail(res, smtpError('UNAUTHORIZED'));
      req.smtpAccess = getAccessState(req.smtpUser);
      if (!req.smtpAccess.canAccessApp) {
        const safe = publicSmtpError(smtpError('BILLING_REQUIRED'));
        return res.status(safe.status).json({ ...safe, recommendedCheckoutIntent: req.smtpAccess.recommendedCheckoutIntent });
      }
      next();
    } catch (error) { fail(res, error); }
  });
  const repoFor = req => req.smtpRuntime.repository;
  const orderFor = req => {
    const order = repoFor(req).getOrder(req.params.id, req.smtpUser.id);
    if (!order) throw smtpError('NOT_FOUND');
    return order;
  };
  const publicOrder = (req, order) => publicSmtpOrder(order, repoFor(req).getMailboxes(order.id));
  const connectionFor = req => {
    const connection = repoFor(req).getConnection(req.smtpUser.id);
    if (connection?.status !== 'connected') throw smtpError('RESEND_CONNECTION_REQUIRED');
    return connection;
  };
  const removeSecret = async (store, ref) => {
    // A failed cleanup must not roll back a committed connection or delete its replacement.
    try { await store.delete(ref); } catch { /* Orphaned secrets require operational cleanup. */ }
  };
  const keyFor = async (req, connection) => {
    let key;
    try { key = await req.smtpRuntime.secretStore.get(connection.secret_ref); } catch { /* Safe public error below. */ }
    if (!key) throw smtpError('RESEND_CONNECTION_INVALID');
    return key;
  };
  const prepare = async (req, order) => {
    connectionFor(req);
    const processor = await getProcessor(req.smtpRuntime);
    await processor.prepareOrder(order.id);
    // Never trust a processor snapshot after an await.
    return repoFor(req).getOrder(order.id, req.smtpUser.id);
  };

  router.get('/connection', route(async (req, res) => {
    res.json(publicSmtpConnection(repoFor(req).getConnection(req.smtpUser.id)));
  }));
  router.post('/connection', route(async (req, res) => {
    const apiKey = normalizeResendKey(req.body?.api_key);
    const repo = repoFor(req);
    const previous = repo.getConnection(req.smtpUser.id);
    if (repo.busyConnection(req.smtpUser.id)) throw smtpError('CONNECTION_BUSY');
    const { secretStore, resendFactory } = req.smtpRuntime;
    const domains = await resendFactory(apiKey).listDomains();
    const secretRef = `resend:${req.smtpUser.id}:${randomUUID()}`;
    let committed = false;
    try {
      await secretStore.set(secretRef, apiKey);
      const value = { secret_ref: secretRef, validated_at: Date.now(), connected_domain_count: domains.length };
      if (!repo.swapConnection(req.smtpUser.id, value, previous?.secret_ref || null)) throw smtpError('CONNECTION_BUSY');
      committed = true;
      const response = publicSmtpConnection({ ...value, status: 'connected' });
      if (previous?.secret_ref) await removeSecret(secretStore, previous.secret_ref);
      res.status(201).json(response);
    } finally {
      if (!committed) await removeSecret(secretStore, secretRef);
    }
  }));
  router.post('/connection/refresh', route(async (req, res) => {
    const repo = repoFor(req);
    const connection = repo.getConnection(req.smtpUser.id);
    if (!connection) throw smtpError('RESEND_CONNECTION_REQUIRED');
    let domains;
    try {
      domains = await req.smtpRuntime.resendFactory(await keyFor(req, connection)).listDomains();
    } catch (error) {
      const safe = publicSmtpError(error);
      if (['RESEND_INVALID_KEY', 'RESEND_FULL_ACCESS_REQUIRED', 'RESEND_CONNECTION_INVALID'].includes(safe.code)) {
        if (!repo.updateConnection(req.smtpUser.id, connection.secret_ref, { ...connection, status: 'invalid' })) {
          throw smtpError('CONNECTION_BUSY');
        }
      }
      throw error;
    }
    const value = { status: 'connected', connected_domain_count: domains.length, validated_at: Date.now() };
    if (!repo.updateConnection(req.smtpUser.id, connection.secret_ref, value)) throw smtpError('CONNECTION_BUSY');
    res.json(publicSmtpConnection(value));
  }));
  router.delete('/connection', route(async (req, res) => {
    const repo = repoFor(req);
    const connection = repo.getConnection(req.smtpUser.id);
    if (connection) {
      if (!repo.disconnectConnection(req.smtpUser.id, connection.secret_ref)) throw smtpError('CONNECTION_BUSY');
      await removeSecret(req.smtpRuntime.secretStore, connection.secret_ref);
    }
    res.status(204).send();
  }));

  router.get('/orders', route(async (req, res) => {
    res.json(repoFor(req).listOrders(req.smtpUser.id).map(order => publicOrder(req, order)));
  }));
  router.get('/orders/:id', route(async (req, res) => res.json(publicOrder(req, orderFor(req)))));
  router.post('/orders', route(async (req, res) => {
    const domain = normalizeSmtpDomain(req.body?.domain);
    connectionFor(req);
    let order = repoFor(req).createDraft(req.smtpUser.id, domain);
    if (order.status === 'draft' || (order.status === 'failed' && !order.started_at)) order = await prepare(req, order);
    res.status(201).json(publicOrder(req, order));
  }));
  router.patch('/orders/:id/mailboxes', route(async (req, res) => {
    const order = orderFor(req);
    const names = normalizeSmtpMailboxNames(req.body?.names, order.domain);
    const updated = repoFor(req).reserveMailboxes(order.id, req.smtpUser.id, names, req.smtpAccess.inboxesLimit);
    res.json(publicOrder(req, updated));
  }));
  router.post('/orders/:id/nameservers/check', route(async (req, res) => {
    let order = orderFor(req);
    if (order.status === 'draft' || (order.status === 'failed' && !order.started_at)) order = await prepare(req, order);
    if (!['pending_nameservers', 'ready'].includes(order.status) || order.started_at) throw smtpError('ORDER_STATE_CONFLICT');
    const repo = repoFor(req);
    const token = randomUUID();
    if (!repo.acquireLease(order.id, token)) throw smtpError('ORDER_STATE_CONFLICT');
    try {
      repo.assertOwnership(order.id, token);
      const result = await req.smtpRuntime.dns.checkSmtpNameservers({
        domain: order.domain, zoneId: order.cloudflare_zone_id, nameServers: parseSmtpJson(order.cloudflare_ns),
      });
      // Delegation does not prove the claim survived the network wait or its expiry.
      const current = repo.assertOwnership(order.id, token);
      if (current.status !== order.status || current.started_at ||
          current.cloudflare_zone_id !== order.cloudflare_zone_id || current.cloudflare_ns !== order.cloudflare_ns) {
        throw smtpError('ORDER_STATE_CONFLICT');
      }
      const updated = repo.updateOrder(order.id, {
        nameservers_connected: Number(result.connected), status: result.connected ? 'ready' : 'pending_nameservers',
      }, token);
      res.json({ order: publicOrder(req, updated), connected: Boolean(result.connected) });
    } finally {
      repo.releaseLease(order.id, token);
    }
  }));
  router.post('/orders/:id/start', route(async (req, res) => {
    let order = orderFor(req);
    if (ACTIVE.has(order.status)) return res.json(publicOrder(req, order));
    connectionFor(req);
    // Preparation failures have no inboxes yet; retry setup instead of attempting provisioning.
    if (order.status === 'draft' || (order.status === 'failed' && !order.started_at)) {
      order = await prepare(req, order);
      return res.json(publicOrder(req, order));
    }
    if (!['ready', 'failed', 'cancelled'].includes(order.status)) throw smtpError('ORDER_STATE_CONFLICT');
    if (!order.nameservers_connected) throw smtpError('NAMESERVERS_PENDING');
    if (!order.total_mailboxes) throw smtpError('INVALID_MAILBOX_QUANTITY');
    const updated = repoFor(req).startOrder(order.id, req.smtpUser.id, {
      inboxesLimit: req.smtpAccess.inboxesLimit, maxConcurrentOrders: req.smtpAccess.maxConcurrentOrders,
    });
    res.json(publicOrder(req, updated));
  }));
  router.post('/orders/:id/cancel', route(async (req, res) => {
    const order = orderFor(req);
    if (!ACTIVE.has(order.status)) throw smtpError('ORDER_STATE_CONFLICT');
    res.json(publicOrder(req, repoFor(req).cancelOrder(order.id, req.smtpUser.id)));
  }));
  router.delete('/orders/:id', route(async (req, res) => {
    const order = orderFor(req);
    if (ACTIVE.has(order.status)) throw smtpError('ORDER_STATE_CONFLICT');
    if (publicOrder(req, order).created_mailboxes_count) throw smtpError('ORDER_NOT_DELETABLE');
    const repo = repoFor(req);
    // Best-effort cleanup of provisioned external infrastructure.
    if (order.cloudflare_zone_id || order.resend_domain_id) {
      try {
        const runtime = req.smtpRuntime;
        const connection = repo.getConnection(req.smtpUser.id);
        if (order.cloudflare_zone_id) {
          try { await runtime.dns.deleteSmtpZone(order.cloudflare_zone_id); } catch { /* best-effort */ }
        }
        if (order.resend_domain_id && connection) {
          try {
            const key = await runtime.secretStore.get(connection.secret_ref);
            if (key) await runtime.resendFactory(key).deleteDomain(order.resend_domain_id);
          } catch { /* best-effort */ }
        }
      } catch { /* best-effort cleanup never blocks deletion */ }
    }
    // Clear the side_effects flag regardless so deleteOrder will proceed.
    repo.updateOrder(order.id, { side_effects: 0 });
    repo.deleteOrder(order.id, req.smtpUser.id);
    res.status(204).send();
  }));
  router.get('/orders/:id/logs', route(async (req, res) => {
    const order = orderFor(req);
    res.json(repoFor(req).getLogs(order.id).map(log => ({
      id: log.id, timestamp: log.timestamp, message: safeSmtpLog(log.message),
    })));
  }));
  router.get('/orders/:id/download', route(async (req, res) => {
    const order = orderFor(req);
    if (order.status !== 'completed') throw smtpError('DOWNLOAD_NOT_READY');
    const mailboxes = repoFor(req).getMailboxes(order.id);
    if (!mailboxes.length || mailboxes.length !== order.total_mailboxes ||
        mailboxes.some(row => row.status !== 'verified' || row.email !== `${row.local_part}@${order.domain}` || row.credential_ref !== `mailbox:${row.email}`)) throw smtpError('DOWNLOAD_NOT_READY');
    const { secretStore, buildCsv, config } = req.smtpRuntime;
    const rows = [];
    for (const mailbox of mailboxes) {
      const password = await secretStore.get(mailbox.credential_ref);
      if (!password) throw smtpError('MAIL_INFRASTRUCTURE_UNAVAILABLE');
      rows.push({ email: mailbox.email, password });
    }
    // Validate credentials/configuration before consuming the shared trial allowance.
    const fullCsv = buildCsv(rows, config);
    const allowed = repoFor(req).selectCredentialRowsForAllowance(req.smtpUser.id, 'smtp', rows, req.smtpAccess);
    if (!allowed.length) throw smtpError('DOWNLOAD_ALLOWANCE_REACHED');
    const csv = allowed.length === rows.length ? fullCsv : buildCsv(allowed, config);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="inboxes-${order.domain}.csv"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(csv);
  }));
  return router;
}

export default createSmtpRouter();
