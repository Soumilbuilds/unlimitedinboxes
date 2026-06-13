require('dotenv').config({ path: '/opt/unlimited-inboxes/shared/.env' });
const axios = require('axios');
const Database = require('better-sqlite3');

const MASTER_CLIENT_ID = process.env.MASTER_CLIENT_ID;
const MASTER_CLIENT_SECRET = process.env.MASTER_CLIENT_SECRET;
const TENANT_ID = '596b57cc-3894-47fd-8718-895f111b14fd';
const DOMAIN = 'trykodekernel.us';
const ADMIN_EMAIL = 'admin@meetsaasy.onmicrosoft.com';
const ADMIN_PASSWORD = 'K^611947986007os';
const PASSWORD = 'K^611947986007os';

const db = new Database('/opt/unlimited-inboxes/shared/db/app.db');

// Full list of mailbox names that the system uses
const MAILBOX_NAMES = [
  { firstName: 'Evelyn', lastName: 'Collins' },
  { firstName: 'Evelyn', lastName: 'Howard' },
  { firstName: 'Avery', lastName: 'White' },
  { firstName: 'Lily', lastName: 'Brown' },
  { firstName: 'Claire', lastName: 'Price' },
  { firstName: 'Charlotte', lastName: 'Anderson' },
  { firstName: 'Anna', lastName: 'Young' },
  { firstName: 'Raelynn', lastName: 'Anderson' },
  { firstName: 'Ruby', lastName: 'Cox' },
  { firstName: 'Isabelle', lastName: 'Smith' },
  { firstName: 'Caroline', lastName: 'Brown' },
  { firstName: 'Ellie', lastName: 'Reed' },
  { firstName: 'Arianna', lastName: 'Garcia' },
  { firstName: 'Isabelle', lastName: 'Jenkins' },
  { firstName: 'Scarlett', lastName: 'Harris' },
  { firstName: 'Brielle', lastName: 'Thompson' },
  { firstName: 'Layla', lastName: 'Reed' },
  { firstName: 'Athena', lastName: 'Wood' },
  { firstName: 'Natalie', lastName: 'Edwards' },
  { firstName: 'Ivy', lastName: 'Moore' },
  { firstName: 'Riley', lastName: 'Baker' },
  { firstName: 'Sophia', lastName: 'Mitchell' },
  { firstName: 'Alexis', lastName: 'Long' },
  { firstName: 'Alexandra', lastName: 'Morris' },
  { firstName: 'Emily', lastName: 'Price' },
  { firstName: 'Serenity', lastName: 'Mitchell' },
  { firstName: 'Victoria', lastName: 'Flores' },
  { firstName: 'Kennedy', lastName: 'Foster' },
  { firstName: 'Kinsley', lastName: 'Jones' },
  { firstName: 'Quinn', lastName: 'Hall' },
  { firstName: 'Gabriella', lastName: 'Moore' },
  { firstName: 'Alexandra', lastName: 'Hughes' },
  { firstName: 'Sophia', lastName: 'Evans' },
  { firstName: 'Taylor', lastName: 'Martin' },
  { firstName: 'Kaylee', lastName: 'Thompson' },
  { firstName: 'Chloe', lastName: 'Richardson' },
  { firstName: 'Luna', lastName: 'Morgan' },
  { firstName: 'Eliana', lastName: 'Morris' },
  { firstName: 'Eva', lastName: 'Clark' },
  { firstName: 'Ella', lastName: 'Brooks' },
  { firstName: 'Maya', lastName: 'Butler' },
  { firstName: 'Amelia', lastName: 'Miller' },
  { firstName: 'Ellie', lastName: 'Martinez' },
  { firstName: 'Grace', lastName: 'Lee' },
  { firstName: 'Josephine', lastName: 'Walker' },
  { firstName: 'Gabriella', lastName: 'Rivera' },
  { firstName: 'Abigail', lastName: 'Morgan' },
  { firstName: 'Bailey', lastName: 'Adams' },
  { firstName: 'Grace', lastName: 'Evans' },
  { firstName: 'Taylor', lastName: 'Evans' },
  { firstName: 'Evelyn', lastName: 'Peterson' },
  { firstName: 'Emma', lastName: 'Powell' },
  { firstName: 'Eve', lastName: 'Lewis' },
  { firstName: 'Luna', lastName: 'Robinson' },
  { firstName: 'Maya', lastName: 'Turner' },
  { firstName: 'Caroline', lastName: 'Martinez' },
  { firstName: 'Nova', lastName: 'Martin' },
  { firstName: 'Caroline', lastName: 'Clark' },
  { firstName: 'Ella', lastName: 'Peterson' },
  { firstName: 'Eva', lastName: 'Powell' },
  { firstName: 'Savannah', lastName: 'Lee' },
  { firstName: 'Ella', lastName: 'Ward' },
  { firstName: 'Leah', lastName: 'Davis' },
  { firstName: 'Bella', lastName: 'Hughes' },
  { firstName: 'Adeline', lastName: 'Campbell' },
  { firstName: 'Avery', lastName: 'Rodriguez' },
  { firstName: 'Isabelle', lastName: 'Price' },
  { firstName: 'Avery', lastName: 'Brooks' },
  { firstName: 'Kaylee', lastName: 'Harris' },
  { firstName: 'Naomi', lastName: 'Cox' },
  { firstName: 'Mackenzie', lastName: 'Turner' },
  { firstName: 'Emilia', lastName: 'Cooper' },
  { firstName: 'Melanie', lastName: 'Cox' },
  { firstName: 'Aubree', lastName: 'Perry' },
  { firstName: 'Ellie', lastName: 'Murphy' },
  { firstName: 'Stella', lastName: 'Young' },
  { firstName: 'Arianna', lastName: 'Rodriguez' },
  { firstName: 'Arianna', lastName: 'Campbell' },
  { firstName: 'Avery', lastName: 'Richardson' },
  { firstName: 'Natalia', lastName: 'Cox' },
  { firstName: 'Aaliyah', lastName: 'Moore' },
  { firstName: 'Ella', lastName: 'Mitchell' },
  { firstName: 'Brianna', lastName: 'White' },
  { firstName: 'Aria', lastName: 'Nelson' },
  { firstName: 'Aaliyah', lastName: 'Rogers' },
  { firstName: 'Emery', lastName: 'Adams' },
  { firstName: 'Caroline', lastName: 'Ward' },
  { firstName: 'Ariana', lastName: 'Bennett' },
  { firstName: 'Leah', lastName: 'Long' },
  { firstName: 'Sarah', lastName: 'Williams' },
  { firstName: 'Hailey', lastName: 'Cooper' },
  { firstName: 'Mia', lastName: 'Baker' },
  { firstName: 'Ellie', lastName: 'Johnson' },
  { firstName: 'Ruby', lastName: 'James' },
  { firstName: 'Maya', lastName: 'Robinson' },
  { firstName: 'Rylee', lastName: 'Allen' },
  { firstName: 'Genesis', lastName: 'Lee' },
  { firstName: 'Josephine', lastName: 'Green' },
  { firstName: 'Ava', lastName: 'Cooper' },
  { firstName: 'Faith', lastName: 'Edwards' },
  { firstName: 'Gabriella', lastName: 'Wood' },
  { firstName: 'Emma', lastName: 'Allen' },
  { firstName: 'Piper', lastName: 'Perry' },
  { firstName: 'Madeline', lastName: 'Rogers' },
];

function getEmail(firstName, lastName) {
  return `${firstName.toLowerCase()}${lastName.toLowerCase()}@${DOMAIN}`;
}

async function getDelegatedToken(tenantId, username, password) {
  const params = new URLSearchParams();
  params.append('client_id', MASTER_CLIENT_ID);
  params.append('client_secret', MASTER_CLIENT_SECRET);
  params.append('grant_type', 'password');
  params.append('username', username);
  params.append('password', password);
  params.append('scope', 'https://graph.microsoft.com/.default');

  const res = await axios.post(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    params
  );
  return res.data.access_token;
}

async function createMailbox(token, firstName, lastName, email) {
  const displayName = `${firstName} ${lastName}`;
  const upn = email;

  await axios.post(
    'https://graph.microsoft.com/v1.0/users',
    {
      accountEnabled: true,
      displayName,
      mailNickname: upn.split('@')[0],
      userPrincipalName: upn,
      passwordProfile: {
        forceChangePasswordNextSignIn: false,
        password: PASSWORD
      }
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

async function enableSignIn(token, email) {
  await axios.patch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}`,
    {
      accountEnabled: true,
      passwordProfile: {
        forceChangePasswordNextSignIn: false,
        password: PASSWORD
      }
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

async function main() {
  console.log('=== CREATING ALL 100 MAILBOXES ===\n');

  // Get existing mailboxes from the order
  const order = db.prepare('SELECT * FROM orders WHERE id = 150').get();
  const createdMailboxes = JSON.parse(order.created_mailboxes || '[]');

  // Extract existing emails
  const existingEmails = new Set();
  for (const mb of createdMailboxes) {
    if (typeof mb === 'string') {
      existingEmails.add(mb);
    } else if (mb && mb.email) {
      existingEmails.add(mb.email);
    }
  }

  console.log('Already created:', existingEmails.size);

  // Get token
  const token = await getDelegatedToken(TENANT_ID, ADMIN_EMAIL, ADMIN_PASSWORD);
  console.log('Got Graph API token\n');

  const newMailboxes = [];

  // Create all 100 mailboxes
  for (let i = 0; i < MAILBOX_NAMES.length; i++) {
    const { firstName, lastName } = MAILBOX_NAMES[i];
    const email = getEmail(firstName, lastName);

    if (existingEmails.has(email)) {
      console.log(`[${i + 1}/100] Already exists: ${email}`);
      newMailboxes.push(email);
      continue;
    }

    try {
      console.log(`[${i + 1}/100] Creating: ${email}`);
      await createMailbox(token, firstName, lastName, email);
      newMailboxes.push(email);
      console.log(`  Created: ${email}`);
    } catch (e) {
      const errorCode = e.response?.data?.error?.code;
      if (errorCode === 'Request_ResourceAlreadyExists') {
        console.log(`  Already exists: ${email}`);
        newMailboxes.push(email);
      } else {
        console.log(`  Error: ${e.response?.data?.error?.message || e.message}`);
      }
    }

    // Rate limiting every 5 requests
    if ((i + 1) % 5 === 0 && i < MAILBOX_NAMES.length - 1) {
      process.stdout.write('Waiting 2s...');
      await new Promise(r => setTimeout(r, 2000));
      console.log(' done');
    }
  }

  console.log('\n=== ENABLING SIGN-IN FOR ALL ===');

  // Enable sign-in for all mailboxes
  for (let i = 0; i < newMailboxes.length; i++) {
    const email = newMailboxes[i];
    try {
      process.stdout.write(`[${i + 1}/${newMailboxes.length}] Enabling: ${email}...`);
      await enableSignIn(token, email);
      console.log(' OK');
    } catch (e) {
      console.log(` Error: ${e.response?.data?.error?.message || e.message}`);
    }
  }

  // Update the order with all mailboxes
  console.log('\n=== UPDATING ORDER ===');

  const allMailboxes = MAILBOX_NAMES.map(({ firstName, lastName }) => getEmail(firstName, lastName));

  const update = db.prepare(`
    UPDATE orders
    SET created_mailboxes = ?,
        status = 'completed',
        progress = 100
    WHERE id = 150
  `).run(JSON.stringify(allMailboxes));

  console.log(`Updated ${update.changes} order(s)`);
  console.log(`Total mailboxes: ${allMailboxes.length}`);
  console.log('\nDone!');
}

main().catch(console.error);