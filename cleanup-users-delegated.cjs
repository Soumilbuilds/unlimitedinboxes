require('dotenv').config({ path: '/opt/unlimited-inboxes/shared/.env' });
const axios = require('axios');

const MASTER_CLIENT_ID = process.env.MASTER_CLIENT_ID;
const MASTER_CLIENT_SECRET = process.env.MASTER_CLIENT_SECRET;
const TENANT_ID = '596b57cc-3894-47fd-8718-895f111b14fd';
const ADMIN_EMAIL = 'admin@meetsaasy.onmicrosoft.com';
const ADMIN_PASSWORD = 'K^611947986007os';

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

async function listUsers(token) {
  const res = await axios.get('https://graph.microsoft.com/v1.0/users?$top=999', {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.data.value || [];
}

async function deleteUser(token, userId) {
  await axios.delete(`https://graph.microsoft.com/v1.0/users/${userId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
}

async function main() {
  console.log('Getting delegated token with admin credentials...');
  const token = await getDelegatedToken(TENANT_ID, ADMIN_EMAIL, ADMIN_PASSWORD);
  console.log('Got token!\n');

  const users = await listUsers(token);

  console.log('Total users in tenant:', users.length);
  console.log('');

  // Keep only the admin user, delete everything else
  const adminEmail = 'admin@meetsaasy.onmicrosoft.com';
  const usersToDelete = users.filter(u => u.userPrincipalName.toLowerCase() !== adminEmail.toLowerCase());

  console.log('Users to DELETE:', usersToDelete.length);
  console.log('Users to KEEP:', 1, '(admin)');
  console.log('');
  console.log('Deleting users...\n');

  // Delete all non-admin users
  let deleted = 0;
  let failed = 0;

  for (let i = 0; i < usersToDelete.length; i++) {
    const user = usersToDelete[i];
    try {
      await deleteUser(token, user.id);
      console.log(`[${i+1}/${usersToDelete.length}] Deleted: ${user.userPrincipalName}`);
      deleted++;
    } catch (e) {
      console.log(`[${i+1}/${usersToDelete.length}] Failed: ${user.userPrincipalName}`);
      failed++;
    }

    // Rate limit
    if ((i + 1) % 10 === 0) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log('');
  console.log('=== SUMMARY ===');
  console.log('Deleted:', deleted);
  console.log('Failed:', failed);
  console.log('Remaining:', users.length - deleted);
  console.log('');
  console.log('Done! Tenant should have more quota now.');
}

main().catch(console.error);