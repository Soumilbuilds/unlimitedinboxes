require('dotenv').config({ path: '/opt/unlimited-inboxes/shared/.env' });
const axios = require('axios');

const MASTER_CLIENT_ID = process.env.MASTER_CLIENT_ID;
const MASTER_CLIENT_SECRET = process.env.MASTER_CLIENT_SECRET;
const OLD_TENANT_ID = '18fc47ed-26b7-45fd-8a88-933c18d44540';
const NEW_TENANT_ID = '596b57cc-3894-47fd-8718-895f111b14fd';
const DOMAIN = 'trykodekernel.us';

// Admin credentials for old tenant
const OLD_ADMIN_EMAIL = 'admin@ultrava1.onmicrosoft.com';
const OLD_ADMIN_PASSWORD = '\tX^340224686220uv';

// Admin credentials for new tenant
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

async function graphRequest(token, method, path, data = null) {
  const options = {
    method,
    headers: { Authorization: `Bearer ${token}` }
  };
  if (data) options.data = data;
  return axios(`https://graph.microsoft.com/v1.0${path}`, options);
}

async function listDomains(token) {
  const res = await graphRequest(token, 'GET', '/domains');
  return res.data.value || [];
}

async function getDomain(token, domain) {
  const res = await graphRequest(token, 'GET', `/domains/${domain}`);
  return res.data;
}

async function deleteDomain(token, domain) {
  await graphRequest(token, 'DELETE', `/domains/${domain}`);
}

async function addDomain(token, domain) {
  await graphRequest(token, 'POST', '/domains', { id: domain });
}

async function verifyDomain(token, domain) {
  await graphRequest(token, 'POST', `/domains/${domain}/verify`, {});
}

async function getVerificationDns(token, domain) {
  const res = await graphRequest(token, 'GET', `/domains/${domain}/verificationDnsRecords`);
  return res.data.value || [];
}

async function getServiceConfigRecords(token, domain) {
  const res = await graphRequest(token, 'GET', `/domains/${domain}/serviceConfigurationRecords`);
  return res.data.value || [];
}

async function main() {
  console.log('===========================================');
  console.log('DOMAIN TRANSFER: trykodekernel.us');
  console.log('From: ultraviol1 tenant (18fc47ed...)');
  console.log('To: meetsaasy tenant (596b57cc...)');
  console.log('===========================================\n');

  // Step 1: Check current state in OLD tenant
  console.log('[1] Checking OLD tenant (ultraviol1)...');
  try {
    const oldToken = await getDelegatedToken(OLD_TENANT_ID, OLD_ADMIN_EMAIL, OLD_ADMIN_PASSWORD);
    const oldDomains = await listDomains(oldToken);
    const oldDomain = oldDomains.find(d => d.id === DOMAIN);
    if (oldDomain) {
      console.log(`    Domain exists: ${oldDomain.id}`);
      console.log(`    Verified: ${oldDomain.isVerified}`);
      console.log(`    Services: ${oldDomain.supportedServices?.join(', ') || 'none'}`);
    } else {
      console.log(`    Domain NOT in old tenant`);
    }
  } catch (e) {
    console.log(`    Error: ${e.response?.data?.error?.message || e.message}`);
  }

  // Step 2: Check current state in NEW tenant
  console.log('\n[2] Checking NEW tenant (meetsaasy)...');
  try {
    const newToken = await getDelegatedToken(NEW_TENANT_ID, NEW_ADMIN_EMAIL, NEW_ADMIN_PASSWORD);
    const newDomains = await listDomains(newToken);
    const newDomain = newDomains.find(d => d.id === DOMAIN);
    if (newDomain) {
      console.log(`    Domain exists: ${newDomain.id}`);
      console.log(`    Verified: ${newDomain.isVerified}`);
      console.log(`    Services: ${newDomain.supportedServices?.join(', ') || 'none'}`);
    } else {
      console.log(`    Domain NOT in new tenant - need to add`);
    }
  } catch (e) {
    console.log(`    Error: ${e.response?.data?.error?.message || e.message}`);
  }

  // Step 3: Try to delete from old tenant
  console.log('\n[3] Attempting to delete domain from OLD tenant...');
  try {
    const oldToken = await getDelegatedToken(OLD_TENANT_ID, OLD_ADMIN_EMAIL, OLD_ADMIN_PASSWORD);
    await deleteDomain(oldToken, DOMAIN);
    console.log('    SUCCESS: Domain deleted from old tenant!');
  } catch (e) {
    console.log(`    FAILED: ${e.response?.data?.error?.message || e.message}`);
    console.log('    Manual action required: Go to Azure portal for ultraviol1 and remove the domain');
  }

  // Step 4: Try to verify in new tenant
  console.log('\n[4] Attempting to verify domain in NEW tenant...');
  try {
    const newToken = await getDelegatedToken(NEW_TENANT_ID, NEW_ADMIN_EMAIL, NEW_ADMIN_PASSWORD);

    // First add the domain if not exists
    try {
      await addDomain(newToken, DOMAIN);
      console.log('    Added domain to new tenant');
    } catch (e) {
      if (e.response?.data?.error?.code !== 'ResourceExists') {
        throw e;
      }
      console.log('    Domain already exists in new tenant');
    }

    // Get verification records
    console.log('    Getting TXT verification records...');
    await new Promise(r => setTimeout(r, 2000));
    const records = await getVerificationDns(newToken, DOMAIN);
    const txtRecord = records.find(r => r.recordType === 'TXT');
    if (txtRecord) {
      console.log('    TXT Record for verification:');
      console.log(`      Name: ${txtRecord.name || '@'}`);
      console.log(`      Text: ${txtRecord.text}`);
      console.log('    (This should already be in Cloudflare DNS)');
    }

    // Try to verify
    await verifyDomain(newToken, DOMAIN);
    console.log('    Verification requested!');

    // Wait and check service records
    await new Promise(r => setTimeout(r, 3000));
    const configRecords = await getServiceConfigRecords(newToken, DOMAIN);
    if (configRecords.length > 0) {
      console.log('    Service configuration records:');
      configRecords.forEach(r => {
        if (r.service === 'Exchange') {
          console.log(`      MX: ${r.name} -> ${r.mailExchange}`);
          console.log(`      Priority: ${r.preference}`);
        }
      });
    }
  } catch (e) {
    console.log(`    FAILED: ${e.response?.data?.error?.message || e.message}`);
  }

  console.log('\n===========================================');
  console.log('MANUAL STEPS IF NEEDED:');
  console.log('===========================================');
  console.log('1. Go to https://portal.azure.com for ultraviol1 tenant');
  console.log('2. Navigate to Azure Active Directory -> Custom domain names');
  console.log('3. Remove trykodekernel.us domain');
  console.log('4. Go to https://portal.azure.com for meetsaasy tenant');
  console.log('5. Add/verify trykodekernel.us domain');
  console.log('===========================================\n');
}

main().catch(console.error);
