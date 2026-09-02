import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMailboxCsv,
  getMailboxCredentialRows,
  getUniqueMailboxCredentialRows,
} from '../services/mailboxCsv.js';

test('normalizes stored mailbox shapes and falls back to the order password', () => {
  const rows = getMailboxCredentialRows({
    mailbox_password: 'OrderPassword!',
    created_mailboxes: JSON.stringify([
      { email: 'first@example.com', password: 'FirstPassword!' },
      { userPrincipalName: 'second@example.com' },
      { email: 'missing-password@example.com', password: '' },
      { email: '' },
    ]),
  });

  assert.deepEqual(rows, [
    { email: 'first@example.com', password: 'FirstPassword!' },
    { email: 'second@example.com', password: 'OrderPassword!' },
    { email: 'missing-password@example.com', password: 'OrderPassword!' },
  ]);
});

test('deduplicates consolidated credentials case-insensitively', () => {
  const rows = getUniqueMailboxCredentialRows([
    { created_mailboxes: [{ email: 'Mailbox@Example.com', password: 'One!' }] },
    { created_mailboxes: [{ email: 'mailbox@example.com', password: 'Two!' }] },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].password, 'One!');
});

test('quotes CSV fields and emits a UTF-8 BOM for spreadsheet compatibility', () => {
  const csv = buildMailboxCsv([{ email: 'name@example.com', password: 'a,"b"' }]);
  assert.equal(csv, '\uFEFFemail,password\r\n"name@example.com","a,""b"""\r\n');
});
