import defaultDb, { selectCredentialRowsForAllowance } from './database.js';
import { smtpError, normalizeSmtpDomain, normalizeSmtpMailboxNames } from '../services/smtpValidation.js';
import { getUserAccessState } from '../services/access.js';
import { safeSmtpLog } from '../services/smtpPublic.js';

const ACTIVE = ['processing', 'waiting_dns', 'waiting_verification'];
const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
const ORDER_FIELDS = new Set([
  'status', 'progress', 'cloudflare_zone_id', 'cloudflare_ns', 'resend_domain_id', 'resend_status',
  'ownership_checked', 'mail_domain_owned', 'side_effects', 'started_at', 'nameservers_connected',
  'required_dns', 'dns_verified', 'resend_verified', 'relay_verified', 'error_code', 'due_at', 'attempt_count',
]);

export function createSmtpRepository(db = defaultDb) {
  db.exec(`CREATE TABLE IF NOT EXISTS smtp_resource_claims (
    kind TEXT NOT NULL, resource_name TEXT NOT NULL,
    order_id INTEGER NOT NULL REFERENCES smtp_orders(id),
    operation_token TEXT NOT NULL, remote_id TEXT, credential_ref TEXT,
    PRIMARY KEY(kind, resource_name)
  )`);
  const transaction = fn => db.transaction(fn).immediate();
  const getOrder = (id, userId) => userId === undefined
    ? db.prepare('SELECT * FROM smtp_orders WHERE id = ?').get(id)
    : db.prepare('SELECT * FROM smtp_orders WHERE id = ? AND user_id = ?').get(id, userId);
  const mailboxes = id => db.prepare('SELECT * FROM smtp_mailboxes WHERE order_id = ? ORDER BY id').all(id);
  const busyConnection = userId => Boolean(db.prepare(`SELECT 1 FROM smtp_orders WHERE user_id = ?
    AND (status IN ('processing','waiting_dns','waiting_verification') OR
    (processing_token IS NOT NULL AND lease_until > ?)) LIMIT 1`).get(userId, Date.now()));
  const assertLease = (id, token) => {
    const row = getOrder(id);
    if (!token || !row || row.processing_token !== token || !row.lease_until || row.lease_until <= Date.now() || row.status === 'cancelled') {
      throw smtpError('LEASE_LOST', 409);
    }
    return row;
  };
  const reserved = userId => {
    settleCancelledReservations();
    const user = db.prepare('SELECT COALESCE(inboxes_used,0) AS used FROM users WHERE id = ?').get(userId);
    const ms = db.prepare(`SELECT COALESCE(SUM(total_mailboxes),0) AS total FROM orders
      WHERE user_id = ? AND status IN ('pending','processing')`).get(userId).total;
    const smtp = db.prepare(`SELECT COALESCE(SUM(reserved_inboxes),0) AS total FROM smtp_orders
      WHERE user_id = ? AND charged_inboxes = 0`).get(userId).total;
    return Number(user?.used || 0) + Number(ms) + Number(smtp);
  };
  const limitFor = (userId, supplied, key) => {
    const access = getUserAccessState(db.prepare('SELECT * FROM users WHERE id=?').get(userId));
    if (!access.canAccessApp) throw smtpError('BILLING_REQUIRED', 403);
    const actual = access[key];
    if (supplied !== undefined && supplied !== Infinity && (!Number.isFinite(supplied) || supplied < 0)) {
      throw smtpError('ORDER_STATE_CONFLICT', 409);
    }
    return Math.min(actual, supplied ?? actual);
  };
  const expired = (row, claim) => {
    const created = Date.parse(`${claim.created_at.replace(' ', 'T').replace(/Z$/, '')}Z`);
    return !row.started_at && !row.nameservers_connected && (!Number.isFinite(created) || created + CLAIM_TTL_MS <= Date.now());
  };
  const assertClaim = (row) => {
    const claim = db.prepare('SELECT * FROM smtp_domain_claims WHERE domain=?').get(row.domain);
    if (!claim || claim.order_id !== row.id || claim.user_id !== row.user_id ||
      db.prepare("SELECT 1 FROM tenants WHERE lower(rtrim(trim(domain), '.'))=?").get(row.domain)) {
      throw smtpError('DOMAIN_UNAVAILABLE', 409);
    }
  };
  const settleCancelledReservations = (id = null) => {
    // No provider calls: untouched rows with no creation intent are certainly
    // uncreated. Any receipt/intent or legacy checkpoint remains reserved.
    db.prepare(`UPDATE smtp_orders SET reserved_inboxes=(
      SELECT COUNT(*) FROM smtp_mailboxes m WHERE m.order_id=smtp_orders.id AND
      (m.status != 'pending' OR m.credential_ref IS NOT NULL OR EXISTS (
        SELECT 1 FROM smtp_resource_claims r WHERE r.order_id=m.order_id AND r.kind='mailbox' AND r.resource_name=m.email)))
      WHERE status='cancelled' AND charged_inboxes=0 AND (? IS NULL OR id=?)
      AND (processing_token IS NULL OR lease_until <= ?)`)
      .run(id, id, Date.now());
  };
  return {
    db,
    getUser: id => db.prepare('SELECT * FROM users WHERE id = ?').get(id),
    getConnection: userId => db.prepare('SELECT * FROM resend_connections WHERE user_id = ?').get(userId),
    busyConnection,
    swapConnection(userId, value, expectedRef = null) {
      return transaction(() => {
        if (busyConnection(userId)) throw smtpError('CONNECTION_BUSY', 409);
        const existing = this.getConnection(userId);
        if ((existing?.secret_ref || null) !== expectedRef) return false;
        db.prepare(`INSERT INTO resend_connections(user_id,secret_ref,status,validated_at,connected_domain_count)
          VALUES(?,?,'connected',?,?) ON CONFLICT(user_id) DO UPDATE SET
          secret_ref=excluded.secret_ref,status='connected',validated_at=excluded.validated_at,
          connected_domain_count=excluded.connected_domain_count,updated_at=CURRENT_TIMESTAMP`)
          .run(userId, value.secret_ref, value.validated_at, value.connected_domain_count);
        return true;
      });
    },
    disconnectConnection(userId, expectedRef) {
      return transaction(() => {
        if (busyConnection(userId)) throw smtpError('CONNECTION_BUSY', 409);
        return db.prepare('DELETE FROM resend_connections WHERE user_id = ? AND secret_ref = ?').run(userId, expectedRef).changes === 1;
      });
    },
    updateConnection(userId, expectedRef, value) {
      return db.prepare(`UPDATE resend_connections SET status=?,connected_domain_count=?,validated_at=?,updated_at=CURRENT_TIMESTAMP
        WHERE user_id=? AND secret_ref=?`).run(value.status, value.connected_domain_count, value.validated_at, userId, expectedRef).changes === 1;
    },
    createDraft(userId, domain) {
      domain = normalizeSmtpDomain(domain);
      return transaction(() => {
        if (db.prepare("SELECT 1 FROM tenants WHERE lower(rtrim(trim(domain), '.'))=?").get(domain)) {
          throw smtpError('DOMAIN_UNAVAILABLE', 409);
        }
        const claim = db.prepare('SELECT * FROM smtp_domain_claims WHERE domain = ?').get(domain);
        let reclaimed;
        let zone;
        if (claim) {
          const old = getOrder(claim.order_id);
          if (claim.user_id === userId) {
            return getOrder(claim.order_id, userId);
          }
          if (!expired(old, claim)) {
            throw smtpError('DOMAIN_UNAVAILABLE', 409);
          }
          // Repeating createDraft cannot renew an attacker's original deadline.
          if (old.started_at || old.mail_domain_owned ||
            (old.processing_token && old.lease_until > Date.now()) ||
            db.prepare("SELECT 1 FROM smtp_resource_claims WHERE order_id=? AND kind IN ('domain','mailbox')").get(old.id) ||
            mailboxes(old.id).some(item => item.status !== 'pending' || item.credential_ref)) throw smtpError('DOMAIN_UNAVAILABLE', 409);
          zone = this.getResourceClaim(old.id, 'zone', domain);
          // An unknown remote result must never become a transferable receipt.
          if ((zone && !zone.remote_id) || (old.cloudflare_zone_id && old.cloudflare_zone_id !== zone?.remote_id)) {
            throw smtpError('DOMAIN_UNAVAILABLE', 409);
          }
          reclaimed = old;
          db.prepare("UPDATE smtp_orders SET status='cancelled',reserved_inboxes=0,due_at=0,processing_token=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(old.id);
          db.prepare('DELETE FROM smtp_mailboxes WHERE order_id=?').run(old.id);
          db.prepare('DELETE FROM smtp_domain_claims WHERE order_id=?').run(old.id);
        }
        const id = db.prepare('INSERT INTO smtp_orders(user_id,domain,order_name,due_at) VALUES(?,?,?,?)')
          .run(userId, domain, domain, Date.now()).lastInsertRowid;
        db.prepare('INSERT INTO smtp_domain_claims(domain,user_id,order_id) VALUES(?,?,?)').run(domain, userId, id);
        if (zone) {
          db.prepare("UPDATE smtp_resource_claims SET order_id=? WHERE order_id=? AND kind='zone' AND resource_name=? AND remote_id=?")
            .run(id, reclaimed.id, domain, zone.remote_id);
          db.prepare('UPDATE smtp_orders SET cloudflare_zone_id=?,cloudflare_ns=?,side_effects=1 WHERE id=?')
            .run(zone.remote_id, reclaimed.cloudflare_ns, id);
        }
        return getOrder(id, userId);
      });
    },
    getDomainClaim: domain => db.prepare('SELECT * FROM smtp_domain_claims WHERE domain = ?').get(domain),
    assertOwnership(id, token) {
      const row = assertLease(id, token);
      assertClaim(row);
      if ((row.cloudflare_zone_id && this.getResourceClaim(id, 'zone', row.domain)?.remote_id !== row.cloudflare_zone_id) ||
        (row.mail_domain_owned && !this.getResourceClaim(id, 'domain', row.domain)?.remote_id)) {
        throw smtpError('DOMAIN_UNAVAILABLE', 409);
      }
      return row;
    },
    getResourceClaim(id, kind, name) {
      return db.prepare('SELECT * FROM smtp_resource_claims WHERE order_id=? AND kind=? AND resource_name=?').get(id, kind, name);
    },
    beginResourceCreation(id, kind, name, token) {
      return transaction(() => {
        const row = assertLease(id, token);
        assertClaim(row);
        if (!['zone','domain','mailbox'].includes(kind) ||
          (kind === 'mailbox' ? !mailboxes(id).some(item => item.email === name) : name !== row.domain)) {
          throw smtpError('DOMAIN_UNAVAILABLE', 409);
        }
        const existing = db.prepare('SELECT * FROM smtp_resource_claims WHERE kind=? AND resource_name=?').get(kind, name);
        if (existing && existing.order_id !== id) throw smtpError('DOMAIN_UNAVAILABLE', 409);
        if (existing) return existing;
        db.prepare('INSERT INTO smtp_resource_claims(kind,resource_name,order_id,operation_token) VALUES(?,?,?,?)').run(kind, name, id, token);
        db.prepare('UPDATE smtp_orders SET side_effects=1 WHERE id=?').run(id);
        return this.getResourceClaim(id, kind, name);
      });
    },
    recordResourceCreation(id, kind, name, token, { created, remoteId, credentialRef = null }) {
      // A successful provider response is a receipt even after cancellation or
      // lease expiry. It grants no access and cannot overwrite a newer operation.
      return transaction(() => {
        const row = getOrder(id);
        if (!row) throw smtpError('DOMAIN_UNAVAILABLE', 409);
        if (created !== true || typeof remoteId !== 'string' || !remoteId ||
          (kind === 'mailbox' && credentialRef !== `mailbox:${name}`)) throw smtpError('DOMAIN_UNAVAILABLE', 409);
        const result = db.prepare(`UPDATE smtp_resource_claims SET remote_id=?,credential_ref=?
          WHERE order_id=? AND kind=? AND resource_name=? AND operation_token=? AND remote_id IS NULL`)
          .run(remoteId, credentialRef, id, kind, name, token);
        if (!result.changes) {
          const receipt = this.getResourceClaim(id, kind, name);
          if (receipt?.operation_token !== token || receipt.remote_id !== remoteId || receipt.credential_ref !== credentialRef) {
            throw smtpError('LEASE_LOST', 409);
          }
        }
        return this.getResourceClaim(id, kind, name);
      });
    },
    assertQuota(id, token, suppliedLimit) {
      return transaction(() => {
        const row = assertLease(id, token);
        assertClaim(row);
        const limit = limitFor(row.user_id, suppliedLimit, 'inboxesLimit');
        if (row.reserved_inboxes !== row.total_mailboxes || reserved(row.user_id) > limit) throw smtpError('INBOX_LIMIT_REACHED', 403);
        return row;
      });
    },
    listOrders: userId => db.prepare('SELECT * FROM smtp_orders WHERE user_id = ? ORDER BY id DESC').all(userId),
    getOrder,
    getMailboxes: mailboxes,
    getLogs: id => db.prepare('SELECT id,timestamp,message FROM smtp_order_logs WHERE order_id = ? ORDER BY id').all(id),
    updateOrder(id, values, token) {
      return transaction(() => {
        if (token !== undefined) assertLease(id, token);
        if (values.status === 'ready' || values.nameservers_connected) assertClaim(getOrder(id));
        const entries = Object.entries(values).filter(([key]) => ORDER_FIELDS.has(key));
        if (!entries.length) return;
        db.prepare(`UPDATE smtp_orders SET ${entries.map(([key]) => `${key}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .run(...entries.map(([, value]) => value), id);
        return getOrder(id);
      });
    },
    addLog(id, message, token) {
      return transaction(() => {
        if (token !== undefined) assertLease(id, token);
        const safe = safeSmtpLog(message);
        const last = db.prepare('SELECT message FROM smtp_order_logs WHERE order_id=? ORDER BY id DESC LIMIT 1').get(id);
        if (last?.message !== safe) db.prepare('INSERT INTO smtp_order_logs(order_id,message) VALUES(?,?)').run(id, safe);
      });
    },
    reserveMailboxes(id, userId, names, inboxesLimit) {
      return transaction(() => {
        const row = getOrder(id, userId);
        if (!row) throw smtpError('NOT_FOUND', 404);
        assertClaim(row);
        if (row.started_at || (row.processing_token && row.lease_until > Date.now()) || !['draft', 'ready', 'pending_nameservers'].includes(row.status)) {
          throw smtpError('ORDER_STATE_CONFLICT', 409);
        }
        if (!Array.isArray(names) || !names.length || names.length > 500 || new Set(names).size !== names.length) {
          throw smtpError('INVALID_MAILBOX_QUANTITY');
        }
        const normalized = normalizeSmtpMailboxNames(names.join('\n'), row.domain);
        if (normalized.length !== names.length || normalized.some((name, i) => name !== names[i])) throw smtpError('INVALID_MAILBOX_NAMES');
        assertClaim(row);
        inboxesLimit = limitFor(userId, inboxesLimit, 'inboxesLimit');
        const committed = reserved(userId) - row.reserved_inboxes;
        if (Number.isFinite(inboxesLimit) && committed + names.length > inboxesLimit) throw smtpError('INBOX_LIMIT_REACHED', 403);
        db.prepare('DELETE FROM smtp_mailboxes WHERE order_id=?').run(id);
        for (const name of names) db.prepare('INSERT INTO smtp_mailboxes(order_id,local_part,email) VALUES(?,?,?)')
          .run(id, name, `${name}@${row.domain}`);
        db.prepare('UPDATE smtp_orders SET total_mailboxes=?,reserved_inboxes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
          .run(names.length, names.length, id);
        return getOrder(id);
      });
    },
    startOrder(id, userId, { inboxesLimit, maxConcurrentOrders }) {
      return transaction(() => {
        // Read the reservation only after lease-drain settlement. Otherwise
        // reserved() could release this order after `needed` was computed.
        settleCancelledReservations();
        const row = getOrder(id, userId);
        if (!row) throw smtpError('NOT_FOUND', 404);
        assertClaim(row);
        if (ACTIVE.includes(row.status)) return row;
        if (!['ready', 'failed', 'cancelled'].includes(row.status) || !row.nameservers_connected || !row.total_mailboxes || !row.cloudflare_zone_id) {
          throw smtpError('ORDER_STATE_CONFLICT', 409);
        }
        if (row.processing_token && row.lease_until > Date.now()) throw smtpError('ORDER_STATE_CONFLICT', 409);
        assertClaim(row);
        inboxesLimit = limitFor(userId, inboxesLimit, 'inboxesLimit');
        maxConcurrentOrders = limitFor(userId, maxConcurrentOrders, 'maxConcurrentOrders');
        const needed = row.total_mailboxes - row.reserved_inboxes;
        if (row.charged_inboxes || mailboxes(id).length !== row.total_mailboxes || needed < 0) throw smtpError('ORDER_STATE_CONFLICT', 409);
        if (reserved(userId) + needed > inboxesLimit) throw smtpError('INBOX_LIMIT_REACHED', 403);
        const ms = db.prepare("SELECT COUNT(*) AS total FROM orders WHERE user_id=? AND status='processing'").get(userId).total;
        const smtp = db.prepare("SELECT COUNT(*) AS total FROM smtp_orders WHERE user_id=? AND status IN ('processing','waiting_dns','waiting_verification')").get(userId).total;
        if (Number.isFinite(maxConcurrentOrders) && ms + smtp >= maxConcurrentOrders) throw smtpError('ORDER_CONCURRENCY_LIMIT', 409);
        db.prepare(`UPDATE smtp_orders SET status='processing',error_code=NULL,started_at=COALESCE(started_at,CURRENT_TIMESTAMP),
          reserved_inboxes=total_mailboxes,due_at=?,processing_token=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(Date.now(), id);
        return getOrder(id);
      });
    },
    cancelOrder(id, userId) {
      return transaction(() => {
        const row = getOrder(id, userId);
        if (!row) throw smtpError('NOT_FOUND', 404);
        if (row.status === 'completed') throw smtpError('ORDER_STATE_CONFLICT', 409);
        // Keep any in-flight lease until it releases/expires: connection deletion
        // must not remove a key from a still-running provider request.
        db.prepare("UPDATE smtp_orders SET status='cancelled',due_at=0,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
        settleCancelledReservations(id);
        this.addLog(id, 'Order Stopped');
        return getOrder(id);
      });
    },
    deleteOrder(id, userId) {
      return transaction(() => {
        const row = getOrder(id, userId);
        if (!row) throw smtpError('NOT_FOUND', 404);
        if (row.side_effects || row.started_at || (row.processing_token && row.lease_until > Date.now())) throw smtpError('ORDER_NOT_DELETABLE', 409);
        db.prepare('DELETE FROM smtp_order_logs WHERE order_id=?').run(id);
        db.prepare('DELETE FROM smtp_mailboxes WHERE order_id=?').run(id);
        db.prepare('DELETE FROM smtp_domain_claims WHERE order_id=?').run(id);
        db.prepare('DELETE FROM smtp_resource_claims WHERE order_id=?').run(id);
        db.prepare('DELETE FROM smtp_orders WHERE id=? AND user_id=?').run(id, userId);
        return true;
      });
    },
    acquireLease(id, token, leaseMs = 120000) {
      return db.prepare(`UPDATE smtp_orders SET processing_token=?,lease_until=?,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND status IN ('draft','pending_nameservers','ready','processing','waiting_dns','waiting_verification','failed')
        AND (processing_token IS NULL OR lease_until <= ? OR processing_token=?)`)
        .run(token, Date.now() + leaseMs, id, Date.now(), token).changes === 1;
    },
    heartbeat(id, token, leaseMs = 120000) {
      return db.prepare(`UPDATE smtp_orders SET lease_until=? WHERE id=? AND processing_token=?
        AND lease_until > ? AND status != 'cancelled'`).run(Date.now() + leaseMs, id, token, Date.now()).changes === 1;
    },
    assertLease,
    releaseLease(id, token) {
      return transaction(() => {
        const released = db.prepare('UPDATE smtp_orders SET processing_token=NULL,lease_until=NULL WHERE id=? AND processing_token=?').run(id, token).changes === 1;
        settleCancelledReservations(id);
        return released;
      });
    },
    dueOrders(limit = 20) {
      return transaction(() => {
        settleCancelledReservations();
        return db.prepare(`SELECT * FROM smtp_orders WHERE status IN ('draft','processing','waiting_dns','waiting_verification')
          AND due_at <= ? AND (processing_token IS NULL OR lease_until <= ?) ORDER BY due_at,id LIMIT ?`)
          .all(Date.now(), Date.now(), limit);
      });
    },
    checkpointMailbox(id, localPart, { credential_ref, status }, token) {
      return transaction(() => {
        assertLease(id, token);
        db.prepare(`UPDATE smtp_mailboxes SET credential_ref=COALESCE(?,credential_ref),status=?
          WHERE order_id=? AND local_part=?`).run(credential_ref || null, status, id, localPart);
      });
    },
    completeOrder(id, token) {
      return transaction(() => {
        const row = assertLease(id, token);
        if (row.status === 'completed' && row.charged_inboxes === row.total_mailboxes) return row;
        if (!ACTIVE.includes(row.status)) throw smtpError('ORDER_STATE_CONFLICT', 409);
        this.assertQuota(id, token);
        const items = mailboxes(id);
        const resource = (kind, name) => this.getResourceClaim(id, kind, name);
        if (resource('zone', row.domain)?.remote_id !== row.cloudflare_zone_id || !resource('domain', row.domain)?.remote_id ||
          items.some(item => !resource('mailbox', item.email)?.remote_id || resource('mailbox', item.email)?.credential_ref !== item.credential_ref)) {
          throw smtpError('DOMAIN_UNAVAILABLE', 409);
        }
        if (!row.started_at || !row.dns_verified || !row.resend_verified || !row.relay_verified || !row.nameservers_connected ||
          items.length !== row.total_mailboxes || !items.length || items.some(item => item.status !== 'verified' || !item.credential_ref)) {
          throw smtpError('ORDER_STATE_CONFLICT', 409);
        }
        if (!row.charged_inboxes) db.prepare(`UPDATE users SET inboxes_used=COALESCE(inboxes_used,0)+?,
          lifetime_completed_orders=COALESCE(lifetime_completed_orders,0)+1,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .run(items.length, row.user_id);
        db.prepare(`UPDATE smtp_orders SET status='completed',progress=100,charged_inboxes=?,reserved_inboxes=0,
          error_code=NULL,due_at=0,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(items.length, id);
        this.addLog(id, 'Provisioning Complete', token);
        return getOrder(id);
      });
    },
    selectCredentialRowsForAllowance: (userId, provider, rows, access) => {
      // Default runtime uses the same ledger as Microsoft. Injected repositories
      // use their own DB, allowing isolation tests without touching production.
      if (db === defaultDb) return selectCredentialRowsForAllowance(userId, provider, rows, access);
      if (!access?.canAccessApp || access.downloadAllowance <= 0) return [];
      if (access.canDownloadAll && !Number.isFinite(access.downloadAllowance)) return rows;
      return transaction(() => {
        let used = db.prepare('SELECT COUNT(*) AS total FROM inbox_download_allocations WHERE user_id=?').get(userId).total;
        return rows.filter(row => {
          const key = row.email.toLowerCase();
          const exists = db.prepare("SELECT 1 FROM inbox_download_allocations WHERE user_id=? AND provider=? AND order_id='credentials' AND mailbox_key=?").get(userId, provider, key);
          if (exists) return true;
          if (used >= Math.min(10, access.downloadAllowance)) return false;
          db.prepare("INSERT INTO inbox_download_allocations(user_id,provider,order_id,mailbox_key) VALUES(?,?,'credentials',?)").run(userId, provider, key);
          used += 1;
          return true;
        });
      });
    },
  };
}

export default createSmtpRepository();
