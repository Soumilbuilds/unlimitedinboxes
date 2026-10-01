import { FileSecretStore } from './fileSecretStore.js';
import { StalwartMailboxProvider } from './stalwartMailboxProvider.js';
import { smtpClientConfig } from './smtpCsv.js';
import { createSmtpConnectivity } from './smtpConnectivity.js';

function normalizeDomain(value) {
  const domain = typeof value === 'string' ? value.trim().toLowerCase().replace(/\.$/, '') : '';
  if (domain.length > 253 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) {
    throw new Error('Enter a valid domain.');
  }
  return domain;
}

function normalizeEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const [local, domain, extra] = email.split('@');
  if (extra !== undefined || !local || local.length > 64 || !/^[a-z0-9][a-z0-9._+-]*$/.test(local) || local.endsWith('.') || local.includes('..')) {
    throw new Error('Enter a valid inbox address.');
  }
  return `${local}@${normalizeDomain(domain)}`;
}

function mailError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// The application must reserve global domain ownership BEFORE calling any writes.
// Discovery is deliberately separate: a provider account or stored secret alone
// never establishes application ownership.
export function createMailInfrastructure(config = {}) {
  const secretStore = config.secretStore ?? new FileSecretStore(config.secretDir ?? config.SMTP_SECRET_DIR ?? process.env.SMTP_SECRET_DIR);
  let provider;
  let connectivity;
  const getProvider = () => {
    provider ??= config.provider ?? new StalwartMailboxProvider({
      baseUrl: config.managementUrl ?? config.SMTP_MANAGEMENT_URL ?? process.env.SMTP_MANAGEMENT_URL,
      tokenSecretKey: config.tokenSecretKey ?? config.SMTP_MANAGEMENT_TOKEN_REF ?? process.env.SMTP_MANAGEMENT_TOKEN_REF,
      secretStore,
      ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
    });
    return provider;
  };
  const getConnectivity = () => {
    connectivity ??= config.connectivity ?? createSmtpConnectivity({ ...smtpClientConfig(config) });
    return connectivity;
  };
  const safe = async (code, message, operation) => {
    try { return await operation(); } catch {
      throw mailError(code, message);
    }
  };
  const credentials = async value => {
    const email = normalizeEmail(value);
    if (!await getProvider().getMailbox(email)) throw new Error('Inbox is unavailable.');
    const password = await secretStore.get(`mailbox:${email}`);
    if (!password) throw new Error('Inbox credentials are unavailable.');
    return { email, password };
  };
  const api = {
    getDomain: value => safe('MAIL_DOMAIN_DISCOVERY', 'Mail infrastructure could not be reached. Try again.', async () => {
      const item = await getProvider().getDomain(normalizeDomain(value));
      return item ? { id: item.id, name: item.name } : null;
    }),
    getMailbox: value => safe('MAIL_INBOX_DISCOVERY', 'Inbox details could not be checked. Try again.', async () => {
      const item = await getProvider().getMailbox(normalizeEmail(value));
      return item ? { id: item.id, email: item.email } : null;
    }),
    ensureDomain: value => safe('MAIL_DOMAIN_SETUP', 'Domain could not be prepared. Try again.', async () => {
      const item = await getProvider().ensureDomain(normalizeDomain(value), { manualDkim: true });
      return { id: item.id, name: item.name, created: item.created };
    }),
    ensureDomainAuthentication: value => safe('MAIL_AUTH_SETUP', 'Email authentication could not be configured. Try again.', () =>
      getProvider().ensureDomainAuthentication(normalizeDomain(value))),
    getRequiredDnsRecords: value => safe('MAIL_DNS_SETUP', 'Email authentication could not be configured. Try again.', async () => {
      const domain = normalizeDomain(value);
      const { host } = smtpClientConfig(config);
      const spf = config.outboundSpf ?? config.SMTP_OUTBOUND_SPF ?? process.env.SMTP_OUTBOUND_SPF;
      if (typeof spf !== 'string' || !/^v=spf1\s+/.test(spf) || /[\x00-\x1f\x7f]/.test(spf)) throw new Error('Invalid mail source configuration.');
      const { records } = await api.ensureDomainAuthentication(domain);
      return [
        { type: 'MX', name: domain, content: host, priority: 10 },
        { type: 'TXT', name: domain, content: spf },
        ...records,
        { type: 'TXT', name: `_dmarc.${domain}`, content: 'v=DMARC1; p=none;' },
      ];
    }),
    ensureMailbox: value => safe('MAIL_INBOX_SETUP', 'One or more inboxes could not be created. Try provisioning again.', async () => {
      const email = normalizeEmail(value);
      const item = await getProvider().ensureMailbox(email);
      return { id: item.id, credentialRef: `mailbox:${email}`, created: item.created };
    }),
    verifyMailbox: value => safe('MAIL_CONNECTIVITY', 'Inbox connectivity checks failed. Try provisioning again.', async () =>
      getConnectivity().verifyMailbox(await credentials(value))),
    verifyRelaySecurity: () => safe('MAIL_RELAY_SECURITY', 'Mail security checks failed. Try provisioning again.', () => getConnectivity().verifyRelaySecurity()),
    getMailboxCredentials: value => safe('MAIL_CREDENTIALS', 'Inbox credentials are unavailable. Try again.', () => credentials(value)),
  };
  return api;
}
