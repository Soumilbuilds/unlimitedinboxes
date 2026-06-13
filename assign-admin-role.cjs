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

async function assignRoleMember(token, roleId, userId) {
  await axios.post(
    `https://graph.microsoft.com/v1.0/directoryRoles/${roleId}/members/$ref`,
    { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${userId}` },
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

async function getRoleMembers(token, roleId) {
  const res = await axios.get(
    `https://graph.microsoft.com/v1.0/directoryRoles/${roleId}/members`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.data.value || [];
}

async function main() {
  console.log('Getting token...');
  const token = await getDelegatedToken(TENANT_ID, ADMIN_EMAIL, ADMIN_PASSWORD);
  console.log('Got token!\n');

  const GLOBAL_ADMIN_ROLE_ID = 'b5c155cb-bf62-4a52-a220-15beee399903';
  const ADMIN_USER_ID = '5ae59209-76ee-4829-afee-b1fd307d979a';

  // Check current members
  console.log('Checking current Global Admin role members...');
  const members = await getRoleMembers(token, GLOBAL_ADMIN_ROLE_ID);
  console.log('Current members:', members.length);
  members.forEach(m => console.log('  -', m.userPrincipalName || m.displayName));

  // Add admin to Global Admin role
  console.log('\nAdding admin to Global Admin role...');
  try {
    await assignRoleMember(token, GLOBAL_ADMIN_ROLE_ID, ADMIN_USER_ID);
    console.log('SUCCESS! Admin added to Global Admin role.');
    console.log('You may need to wait a few minutes for permissions to propagate.');
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    if (msg.includes('already')) {
      console.log('Admin is already a member of Global Admin role.');
    } else {
      console.log('Error:', msg);
    }
  }
}

main().catch(console.error);