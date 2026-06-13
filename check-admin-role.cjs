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

async function getUser(token, email) {
  const res = await axios.get(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.data;
}

async function getDirectoryRoles(token) {
  const res = await axios.get(
    'https://graph.microsoft.com/v1.0/directoryRoles',
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.data.value || [];
}

async function activateRole(token, roleTemplateId) {
  const res = await axios.post(
    'https://graph.microsoft.com/v1.0/directoryRoles',
    { roleTemplateId },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.data;
}

async function assignRoleMember(token, roleId, userId) {
  await axios.post(
    `https://graph.microsoft.com/v1.0/directoryRoles/${roleId}/members/$ref`,
    { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${userId}` },
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

async function main() {
  console.log('Getting token...');
  const token = await getDelegatedToken(TENANT_ID, ADMIN_EMAIL, ADMIN_PASSWORD);
  console.log('Got token!\n');

  // Get admin user
  console.log('Getting admin user...');
  const adminUser = await getUser(token, ADMIN_EMAIL);
  console.log('Admin user ID:', adminUser.id);
  console.log('Admin user displayName:', adminUser.displayName);
  console.log('');

  // Get Global Admin role
  console.log('Getting directory roles...');
  const roles = await getDirectoryRoles(token);
  const globalAdminRole = roles.find(r => r.displayName === 'Global Administrator');

  if (!globalAdminRole) {
    console.log('Global Admin role not found, activating...');
    // Get role templates
    const templatesRes = await axios.get(
      'https://graph.microsoft.com/v1.0/directoryRoleTemplates',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const globalAdminTemplate = templatesRes.data.value.find(t => t.displayName === 'Global Administrator');

    if (globalAdminTemplate) {
      console.log('Activating Global Admin role from template...');
      const activated = await activateRole(token, globalAdminTemplate.id);
      console.log('Role activated! ID:', activated.id);
    }
  } else {
    console.log('Global Admin role exists! ID:', globalAdminRole.id);
  }

  console.log('');
  console.log('Note: The admin user should now have permissions to delete users.');
  console.log('However, this requires the admin to be assigned to the role.');
  console.log('');
  console.log('To delete users, you may need to:');
  console.log('1. Go to Azure Portal: https://entra.microsoft.com');
  console.log('2. Sign in as admin@meetsaasy.onmicrosoft.com');
  console.log('3. Go to Users and manually delete the users, OR');
  console.log('4. Use the order processor which uses Puppeteer to automate deletions');
}

main().catch(console.error);