require('dotenv').config({ path: '/opt/unlimited-inboxes/shared/.env' });
const axios = require('axios');

const MASTER_CLIENT_ID = process.env.MASTER_CLIENT_ID;
const MASTER_CLIENT_SECRET = process.env.MASTER_CLIENT_SECRET;
const OLD_TENANT_ID = '18fc47ed-26b7-45fd-8a88-933c18d44540';
const NEW_TENANT_ID = '596b57cc-3894-47fd-8718-895f111b14fd';
const DOMAIN = 'trykodekernel.us';

// Admin credentials for old tenant (from database)
const OLD_ADMIN_EMAIL = 'admin@ultrava1.onmicrosoft.com';
const OLD_ADMIN_PASSWORD = '\tX^340224686220uv';

// Admin credentials for new tenant (from user)
const NEW_ADMIN_EMAIL = 'admin@meetsaasy.onmicrosoft.com';
const NEW_ADMIN_PASSWORD = 'K^611947986007os';

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

async function deleteDomain(token, domain) {
  console.log(`Deleting domain ${domain}...`);
  try {
    await axios.delete(
      `https://graph.microsoft.com/v1.0/domains/${domain}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    console.log('Domain deleted successfully!');
    return true;
  } catch (e) {
    const error = e.response?.data?.error;
    if (error) {
      console.log('Error:', error.message);
      if (error.code === 'DataDomainNotFound') {
        console.log('Domain not found - may already be deleted');
        return true;
      }
    }
    throw e;
  }
}

async function verifyDomain(token, domain) {
  console.log(`Verifying domain ${domain}...`);
  try {
    await axios.post(
      `https://graph.microsoft.com/v1.0/domains/${domain}/verify`,
      {},
      { headers: { Authorization: `Bearer ${token}` } }
    );
    console.log('Domain verification requested!');
  } catch (e) {
    const error = e.response?.data?.error;
    if (error?.code === 'DomainIsAlreadyVerified') {
      console.log('Domain is already verified');
      return;
    }
    console.log('Verify error:', error?.message || e.message);
  }
}

async function getConfigurationRecords(token, domain) {
  console.log(`Getting service configuration records for ${domain}...`);
  try {
    const res = await axios.get(
      `https://graph.microsoft.com/v1.0/domains/${domain}/serviceConfigurationRecords`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return res.data.value || [];
  } catch (e) {
    console.log('Config records error:', e.response?.data?.error?.message || e.message);
    return [];
  }
}

async function main() {
  console.log('=== Step 1: Delete domain from OLD tenant (ultraviol1) ===');
  try {
    const oldToken = await getDelegatedToken(OLD_TENANT_ID, OLD_ADMIN_EMAIL, OLD_ADMIN_PASSWORD);
    console.log('Got delegated token for old tenant');
    await deleteDomain(oldToken, DOMAIN);
  } catch (e) {
    console.log('Failed to delete from old tenant:', e.response?.data?.error?.message || e.message);
    console.log('You may need to manually delete the domain from Azure portal for ultraviol1 tenant');
  }

  console.log('\n=== Step 2: Verify domain in NEW tenant (meetsaasy) ===');
  try {
    const newToken = await getDelegatedToken(NEW_TENANT_ID, NEW_ADMIN_EMAIL, NEW_ADMIN_PASSWORD);
    console.log('Got delegated token for new tenant');
    await verifyDomain(newToken, DOMAIN);

    // Wait a bit and get the DNS records
    console.log('Waiting for verification...');
    await new Promise(r => setTimeout(r, 3000));

    const records = await getConfigurationRecords(newToken, DOMAIN);
    if (records.length > 0) {
      console.log('DNS records needed for domain setup:');
      records.forEach(r => {
        console.log(`  ${r.recordType}: ${r.label || r.name} -> ${r.text || r.value}`);
      });
    }
  } catch (e) {
    console.log('Failed to verify in new tenant:', e.response?.data?.error?.message || e.message);
  }
}

main().catch(console.error);
