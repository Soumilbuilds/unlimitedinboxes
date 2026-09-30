import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import path from 'node:path';

const CSV_FIELDS = [
  'email', 'dailyLimit',
  'customSmtpServer', 'customSmtpPort', 'customSmtpUsername', 'customSmtpPass',
  'customImapServer', 'customImapPort', 'customImapUsername', 'customImapPass',
];

function hostname(value) {
  if (typeof value !== 'string' || !/^[a-z0-9.-]+$/i.test(value) || value.startsWith('.') || value.endsWith('.')) {
    throw new TypeError('Valid mail server hostname is required');
  }
  return value.toLowerCase();
}

function port(value) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new TypeError('Valid mail server port is required');
  return value;
}

function emailAddress(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._+-]*@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value)) {
    throw new TypeError('Valid mailbox email is required');
  }
  return value.toLowerCase();
}

// This helper returns credentials only to its caller, in memory. It makes no Manyreach API call.
export async function buildManyreachSenderPayload({
  email, imapHost, imapPort, dailyLimit = 20,
  resendApiKeySecretKey = 'resend:api-key',
}, secretStore) {
  const normalized = emailAddress(email);
  if (!secretStore || typeof secretStore.get !== 'function') throw new TypeError('Secret store is required');
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1) throw new TypeError('Valid daily limit is required');
  if (typeof resendApiKeySecretKey !== 'string' || !/^resend:.+/.test(resendApiKeySecretKey)) {
    throw new TypeError('Resend API key secret reference is required');
  }
  const imapServer = hostname(imapHost);
  const imapPortNumber = port(imapPort);
  const [mailboxPassword, resendApiKey] = await Promise.all([
    secretStore.get(`mailbox:${normalized}`),
    secretStore.get(resendApiKeySecretKey),
  ]);
  if (!mailboxPassword) throw new Error('Mailbox credential is unavailable');
  if (!resendApiKey) throw new Error('Resend credential is unavailable');
  return {
    email: normalized, dailyLimit,
    customSmtpServer: 'smtp.resend.com', customSmtpPort: 465,
    customSmtpUsername: 'resend', customSmtpPass: resendApiKey,
    customImapServer: imapServer, customImapPort: imapPortNumber,
    customImapUsername: normalized, customImapPass: mailboxPassword,
  };
}

function csvCell(value) {
  const text = String(value ?? '');
  // Quoting alone does not stop spreadsheet formula execution. Reject instead of changing credentials.
  if (/^[\t\r\n =+\-@]/.test(text)) throw new TypeError('Unsafe CSV value');
  return `"${text.replace(/"/g, '""')}"`;
}

export function buildManyreachSenderCsv(payloads) {
  if (!Array.isArray(payloads)) throw new TypeError('Sender payloads must be an array');
  const lines = [CSV_FIELDS.join(',')];
  for (const payload of payloads) {
    if (!payload || CSV_FIELDS.some(field => payload[field] === undefined || payload[field] === null)) {
      throw new TypeError('Incomplete sender payload');
    }
    lines.push(CSV_FIELDS.map(field => csvCell(payload[field])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

export async function writeManyreachSenderCsvFile(filename, payloads) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || !filename.endsWith('.credentials.csv')) {
    throw new TypeError('Credential export path must be absolute and end with .credentials.csv');
  }
  const csv = buildManyreachSenderCsv(payloads);
  let handle;
  let created = false;
  try {
    handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    await handle.chmod(0o600);
    await handle.writeFile(csv, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = null;
    return filename;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (created) await unlink(filename).catch(() => {});
    if (error.code === 'EEXIST') throw new Error('Credential export already exists');
    throw new Error('Unable to write credential export');
  }
}
