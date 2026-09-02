function parseMailboxPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== 'string' || !payload.trim()) return [];

  try {
    const parsed = JSON.parse(payload);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function firstString(...values) {
  const value = values.find(candidate => typeof candidate === 'string' && candidate.trim());
  return value ? value.trim() : '';
}

export function getMailboxCredentialRows(order) {
  return parseMailboxPayload(order?.created_mailboxes)
    .map(mailbox => ({
      email: firstString(mailbox?.email, mailbox?.userPrincipalName, mailbox?.user_principal_name),
      password: firstString(mailbox?.password, mailbox?.mailbox_password, order?.mailbox_password),
    }))
    .filter(mailbox => mailbox.email && mailbox.password);
}

export function getUniqueMailboxCredentialRows(orders) {
  const seen = new Set();
  const rows = [];

  for (const order of Array.isArray(orders) ? orders : []) {
    for (const mailbox of getMailboxCredentialRows(order)) {
      const key = mailbox.email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(mailbox);
    }
  }

  return rows;
}

function escapeCsvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

export function buildMailboxCsv(rows) {
  const lines = ['email,password'];
  for (const row of Array.isArray(rows) ? rows : []) {
    lines.push(`${escapeCsvCell(row.email)},${escapeCsvCell(row.password)}`);
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
