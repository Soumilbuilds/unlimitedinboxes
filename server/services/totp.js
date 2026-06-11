import crypto from 'node:crypto';

// Microsoft Entra (Azure AD) Authenticator secrets use a 16-character lowercase
// base32 alphabet (a-z + 2-7). They decode to 80-bit keys (10 bytes), which is
// the only authenticator that supports 80-bit TOTP — Google Authenticator
// requires 128-bit secrets. This module handles both the lowercase MS alphabet
// and the RFC 4648 standard uppercase base32.

const MSOFT_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const RFC_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(secret) {
  if (typeof secret !== 'string') {
    throw new Error('TOTP secret must be a string');
  }
  const cleaned = secret.replace(/=+$/g, '').replace(/\s+/g, '');
  if (!cleaned) {
    throw new Error('TOTP secret is empty');
  }

  // Pick the right alphabet based on character casing
  const hasLower = /[a-z]/.test(cleaned);
  const hasUpper = /[A-Z]/.test(cleaned);
  let alphabet;
  if (hasLower && !hasUpper) {
    alphabet = MSOFT_ALPHABET;
  } else if (hasUpper && !hasLower) {
    alphabet = RFC_ALPHABET;
  } else {
    // Mixed or digits — default to Microsoft lowercase but also map digits
    // The "0/1" characters are invalid in both alphabets; we still want to
    // gracefully handle the most common Microsoft screen formats.
    alphabet = MSOFT_ALPHABET;
  }

  const bytes = [];
  let buffer = 0;
  let bitsLeft = 0;
  for (const ch of cleaned.toUpperCase().replace(/0/g, 'O').replace(/1/g, 'I')) {
    const v = alphabet.toUpperCase().indexOf(ch);
    if (v < 0) {
      throw new Error(`TOTP secret contains invalid base32 character: "${ch}"`);
    }
    buffer = (buffer << 5) | v;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bitsLeft -= 8;
      bytes.push((buffer >> bitsLeft) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

export function isValidTotpSecret(secret) {
  try {
    const decoded = decodeBase32(secret);
    return decoded.length >= 5;
  } catch {
    return false;
  }
}

export function generateTotpCode(secret, { time = Math.floor(Date.now() / 1000), period = 30, digits = 6 } = {}) {
  const key = decodeBase32(secret);
  const counter = Math.floor(time / period);
  const counterBuf = Buffer.alloc(8);
  let v = counter;
  for (let i = 7; i >= 0; i -= 1) {
    counterBuf[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  const hmacResult = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmacResult[hmacResult.length - 1] & 0x0f;
  const code = ((hmacResult[offset] & 0x7f) << 24) |
               ((hmacResult[offset + 1] & 0xff) << 16) |
               ((hmacResult[offset + 2] & 0xff) << 8) |
               (hmacResult[offset + 3] & 0xff);
  return (code % 10 ** digits).toString().padStart(digits, '0');
}
