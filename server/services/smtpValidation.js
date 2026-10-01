import { domainToASCII } from 'node:url';

export function smtpError(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}

export function normalizeSmtpDomain(value) {
  if (typeof value !== 'string' || /[\x00-\x20\x7f/@:\\]/.test(value.trim())) throw smtpError('INVALID_DOMAIN');
  const domain = domainToASCII(value.trim().toLowerCase().replace(/\.$/, ''));
  if (!domain || domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) {
    throw smtpError('INVALID_DOMAIN');
  }
  return domain;
}

export function normalizeSmtpMailboxNames(value, domain) {
  // Accept Windows paste newlines before rejecting remaining control characters.
  if (typeof value === 'string') value = value.replace(/\r\n/g, '\n');
  if (typeof value !== 'string' || value.length > 128000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) {
    throw smtpError('INVALID_MAILBOX_NAMES');
  }
  // Ignore a final newline from paste; reject empty lines inside the list.
  const input = value.trim();
  if (!input) throw smtpError('INVALID_MAILBOX_NAMES');
  const lines = input.split('\n');
  if (lines.length > 500) throw smtpError('INVALID_MAILBOX_QUANTITY');
  const names = [];
  const seen = new Set();
  for (const line of lines) {
    let local = line.trim().toLowerCase();
    if (local.includes('@')) {
      const parts = local.split('@');
      if (parts.length !== 2 || parts[1] !== domain) throw smtpError('INVALID_MAILBOX_NAMES');
      local = parts[0];
    }
    if (local.length > 64 || !/^[a-z0-9][a-z0-9._+-]*$/.test(local) || local.endsWith('.') || local.includes('..')) {
      throw smtpError('INVALID_MAILBOX_NAMES');
    }
    if (seen.has(local)) throw smtpError('DUPLICATE_MAILBOX_NAMES');
    seen.add(local);
    names.push(local);
  }
  return names;
}

export function normalizeResendKey(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 512 || !/^re_[A-Za-z0-9_-]+$/.test(value)) {
    throw smtpError('RESEND_INVALID_KEY');
  }
  return value;
}
