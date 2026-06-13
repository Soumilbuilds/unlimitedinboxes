require('dotenv').config({ path: '/opt/unlimited-inboxes/shared/.env' });
const axios = require('axios');
const Database = require('better-sqlite3');

const MASTER_CLIENT_ID = process.env.MASTER_CLIENT_ID;
const MASTER_CLIENT_SECRET = process.env.MASTER_CLIENT_SECRET;
const TENANT_ID = '596b57cc-3894-47fd-8718-895f111b14fd';
const DOMAIN = 'trykodekernel.us';

const db = new Database('/opt/unlimited-inboxes/shared/db/app.db');

// Full list of mailbox names
const MAILBOX_NAMES = [
  'evelyncollins', 'evelynhoward', 'averywhite', 'lilybrown', 'claireprice',
  'charlotteanderson', 'annayoung', 'raelynnanderson', 'rubycox', 'isabellesmith',
  'carolinebrown', 'elliereed', 'ariannagarcia', 'isabellejenkins', 'scarlettharris',
  'briellethompson', 'laylareed', 'athenawood', 'natalieedwards', 'ivymoore',
  'rileybaker', 'sophiemitchell', 'alexislong', 'alexandramorris', 'emilyprice',
  'serenitymitchell', 'victoriaflores', 'kennedyfoster', 'kinsleyjones', 'quinnhall',
  'gabriellamoore', 'alexandrahughes', 'sophiaevans', 'taylormartin', 'kayleethompson',
  'chloerichardson', 'lunamorgan', 'elianamorris', 'evaclark', 'ellabrooks',
  'mayabutler', 'ameliamiller', 'elliemartinez', 'gracelee', 'josephinewalker',
  'gabriellarivera', 'abigailmorgan', 'baileyadams', 'graceevans', 'taylorevans',
  'evelynpeterson', 'emmapowell', 'evelewis', 'lunarobinson', 'mayaturner',
  'carolinemartinez', 'novamartin', 'carolineclark', 'ellapeterson', 'evapowell',
  'savannahlee', 'ellaward', 'leahdavis', 'bellahughes', 'adelinecampbell',
  'averyrodriguez', 'isabelleprice', 'averybrooks', 'kayleeharris', 'naomicox',
  'mackenzieturner', 'emiliacooper', 'melaniecox', 'aubreeperry', 'elliemurphy',
  'stellayoung', 'ariannarodriguez', 'ariannacampbell', 'averyrichardson', 'nataliacox',
  'aaliyahmoore', 'ellamitchell', 'briannawhite', 'arianelson', 'aaliyahrogers',
  'emeryadams', 'carolineward', 'arianabennett', 'leahlong', 'sarahwilliams',
  'haileycooper', 'miabaker', 'elliejohnson', 'rubyjames', 'mayarobinson',
  'ryleeallen', 'genesislee', 'josephinegreen', 'avacooper', 'faithedwards',
  'gabriellawood', 'emmaallen', 'piperperry', 'madelinerogers'
];

async function getAppToken(tenantId) {
  const params = new URLSearchParams();
  params.append('client_id', MASTER_CLIENT_ID);
  params.append('client_secret', MASTER_CLIENT_SECRET);
  params.append('scope', 'https://graph.microsoft.com/.default');
  params.append('grant_type', 'client_credentials');

  const res = await axios.post(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    params
  );
  return res.data.access_token;
}

async function listUsers(token) {
  const res = await axios.get('https://graph.microsoft.com/v1.0/users', {
    headers: { Authorization: `Bearer ${token}` },
    params: { '$top': 999, '$filter': `startsWith(userPrincipalName, '@') eq false` }
  });
  return res.data.value || [];
}

async function main() {
  console.log('=== FINALIZING ORDER ===\n');

  // Get existing users from Microsoft
  const token = await getAppToken(TENANT_ID);
  const users = await listUsers(token);
  const existingEmails = new Set(
    users.map(u => u.userPrincipalName.toLowerCase())
  );

  console.log('Total users in Microsoft:', users.length);
  console.log('Target mailboxes:', MAILBOX_NAMES.length);
  console.log('');

  // Find which target mailboxes exist
  const existingMailboxes = [];
  const missingMailboxes = [];

  for (const name of MAILBOX_NAMES) {
    const email = `${name}@${DOMAIN}`;
    if (existingEmails.has(email.toLowerCase())) {
      existingMailboxes.push(email);
    } else {
      missingMailboxes.push(email);
    }
  }

  console.log('Mailboxes that exist:', existingMailboxes.length);
  console.log('Mailboxes missing:', missingMailboxes.length);
  console.log('');

  if (missingMailboxes.length > 0) {
    console.log('Missing mailboxes:');
    missingMailboxes.forEach(email => console.log(`  - ${email}`));
  }

  console.log('\nExisting mailboxes:');
  existingMailboxes.forEach(email => console.log(`  ✓ ${email}`));

  // Update the order with existing mailboxes
  console.log('\n=== UPDATING ORDER 150 ===');

  const update = db.prepare(`
    UPDATE orders
    SET created_mailboxes = ?,
        status = 'completed',
        progress = 100
    WHERE id = 150
  `).run(JSON.stringify(existingMailboxes));

  console.log(`Updated ${update.changes} order(s)`);
  console.log(`Total mailboxes in order: ${existingMailboxes.length}`);
  console.log('\nDone!');
}

main().catch(console.error);