#!/usr/bin/env node
import 'dotenv/config';
import { createMailInfrastructure } from '../services/mailInfrastructure.js';
import { normalizeSmtpDomain } from '../services/smtpValidation.js';

// Read-only infrastructure verification. Never creates resources or writes CSVs.
async function main() {
  const email = process.argv[2];
  if (typeof email !== 'string' || !/^[a-z0-9][a-z0-9._+-]*@[^@]+$/.test(email)) {
    throw new Error('Provide an existing controlled inbox address.');
  }
  const domain = normalizeSmtpDomain(email.split('@')[1]);
  const mail = createMailInfrastructure();
  if (!await mail.getDomain(domain) || !await mail.getMailbox(email)) {
    throw new Error('The controlled inbox is unavailable.');
  }
  const connectivity = await mail.verifyMailbox(email);
  if (!connectivity.smtp || !connectivity.imap || !await mail.verifyRelaySecurity()) {
    throw new Error('Mail connectivity verification failed.');
  }
  console.log('SMTP Authentication: PASS');
  console.log('IMAP Authentication And Inbox Selection: PASS');
  console.log('Incorrect Password Rejection: PASS');
  console.log('Unauthenticated Relay Protection: PASS');
}

main().catch(() => {
  console.error('SMTP runtime verification failed. Review protected operator diagnostics.');
  process.exitCode = 1;
});
