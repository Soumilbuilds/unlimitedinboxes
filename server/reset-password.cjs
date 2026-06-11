// Run this script: node reset-password.cjs
// Then visit http://localhost:5173/login and register a new account with this email
// The existing user's password will be reset when they log in with their new credentials.

import crypto from 'crypto';

const PASSWORD_ITERATIONS = 120000;
const PASSWORD_KEYLEN = 64;
const PASSWORD_DIGEST = 'sha512';

function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, PASSWORD_KEYLEN, PASSWORD_DIGEST).toString('hex');
  return { hash, salt };
}

// Usage: node reset-password.cjs <email> [new-password]
const email = process.argv[2] || 'kodekernel111@gmail.com';
const newPassword = process.argv[3] || 'TempPass123!';

const { hash, salt } = hashPassword(newPassword);
console.log(`Resetting password for: ${email}`);
console.log(`New password: ${newPassword}`);
console.log(`Hash: ${hash}`);
console.log(`Salt: ${salt}`);
console.log('---');
console.log('To apply: manually update the SQLite database:');
console.log(`  UPDATE users SET password_hash = '${hash}', password_salt = '${salt}' WHERE email = '${email}';`);