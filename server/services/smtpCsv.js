const HEADERS = [
  'email', 'password', 'smtp_host', 'smtp_port', 'smtp_username', 'smtp_password', 'smtp_security',
  'imap_host', 'imap_port', 'imap_username', 'imap_password', 'imap_security',
];

export function smtpClientConfig(config = {}) {
  const host = config.publicHost ?? config.SMTP_PUBLIC_HOST ?? process.env.SMTP_PUBLIC_HOST;
  const smtpPort = Number(config.smtpPort ?? config.SMTP_PORT ?? process.env.SMTP_PORT ?? 465);
  const imapPort = Number(config.imapPort ?? config.IMAP_PORT ?? process.env.IMAP_PORT ?? 993);
  if (typeof host !== 'string' || !/^(?=.{1,253}$)[a-z0-9][a-z0-9.-]*[a-z0-9]$/i.test(host) ||
      ![smtpPort, imapPort].every(port => Number.isInteger(port) && port > 0 && port <= 65535)) {
    throw new Error('Mail configuration is unavailable.');
  }
  return { host, smtpPort, imapPort };
}

function cell(value) {
  const text = String(value);
  if (/^[\s]*[=+@-]/.test(text) || /[\x00-\x1f\x7f]/.test(text)) throw new Error('Inbox credentials could not be exported.');
  return `"${text.replace(/"/g, '""')}"`;
}

// Only authenticated download handlers call this; the string is never persisted.
export function buildSmtpCsv(rows, config = {}) {
  const { host, smtpPort, imapPort } = smtpClientConfig(config);
  if (!Array.isArray(rows)) throw new Error('Inbox credentials could not be exported.');
  const lines = [HEADERS.join(',')];
  for (const row of rows) {
    if (!row || typeof row.email !== 'string' || typeof row.password !== 'string' || !row.email || !row.password) {
      throw new Error('Inbox credentials could not be exported.');
    }
    lines.push([
      row.email, row.password, host, smtpPort, row.email, row.password, 'SSL/TLS',
      host, imapPort, row.email, row.password, 'SSL/TLS',
    ].map(cell).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
