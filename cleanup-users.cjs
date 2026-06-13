require('dotenv').config({ path: '/opt/unlimited-inboxes/shared/.env' });
const axios = require('axios');

const MASTER_CLIENT_ID = process.env.MASTER_CLIENT_ID;
const MASTER_CLIENT_SECRET = process.env.MASTER_CLIENT_SECRET;
const TENANT_ID = '596b57cc-3894-47fd-8718-895f111b14fd';

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
  const token = await getAppToken(TENANT_ID);
  const users = await listUsers(token);

  console.log('Total users in tenant:', users.length);
  console.log('');

  // Keep only the admin user, delete everything else
  const adminEmail = 'admin@meetsaasy.onmicrosoft.com';
  const usersToDelete = users.filter(u => u.userPrincipalName.toLowerCase() !== adminEmail.toLowerCase());

  console.log('Users to DELETE:', usersToDelete.length);
  console.log('Users to KEEP:', 1, '(admin)');
  console.log('');

  // Delete all non-admin users
  for (let i = 0; i < usersToDelete.length; i++) {
    const user = usersToDelete[i];
    try {
      await deleteUser(token, user.id);
      console.log(`[${i+1}/${usersToDelete.length}] Deleted: ${user.userPrincipalName}`);
    } catch (e) {
      console.log(`[${i+1}/${usersToDelete.length}] Failed: ${user.userPrincipalName} - ${e.response?.data?.error?.message || e.message}`);
    }
  }

  console.log('');
  console.log('Done! Tenant cleaned up.');
}

main().catch(console.error);