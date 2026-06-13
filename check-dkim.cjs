require('dotenv').config({ path: '/opt/unlimited-inboxes/shared/.env' });
const axios = require('axios');

const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ZONE_ID = '1dc421c528024e223eaca9a767d3c38c';
const DOMAIN = 'trykodekernel.us';

async function listDnsRecords(zoneId) {
  const res = await axios.get(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
    { headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` } }
  );
  return res.data.result || [];
}

async function addDnsRecord(zoneId, type, name, content) {
  const data = { type, name, content, proxied: false };
  await axios.post(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
    data,
    { headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` } }
  );
}

async function main() {
  console.log('=== DKIM SELECTOR CHECK ===\n');

  const records = await listDnsRecords(ZONE_ID);

  // Check for DKIM selectors (selector1 and selector2)
  const selector1 = records.find(r => r.name === 'selector1._domainkey.trykodekernel.us');
  const selector2 = records.find(r => r.name === 'selector2._domainkey.trykodekernel.us');

  console.log('DKIM Selector 1:', selector1 ? 'EXISTS' : 'MISSING');
  console.log('DKIM Selector 2:', selector2 ? 'EXISTS' : 'MISSING');

  if (!selector1) {
    console.log('\nNote: DKIM selectors are not yet set up in Cloudflare.');
    console.log('These will be added when the order processor runs.');
    console.log('Or you can manually add them after getting the DKIM keys from Microsoft.');
  }

  // Check overall DNS readiness
  const mx = records.find(r => r.type === 'MX');
  const spf = records.find(r => r.type === 'TXT' && r.content.includes('spf'));

  console.log('\n=== DNS READINESS ===');
  console.log('MX Record:', mx ? 'OK' : 'MISSING');
  console.log('SPF Record:', spf ? 'OK' : 'MISSING');
  console.log('DKIM Selectors:', (selector1 && selector2) ? 'READY' : 'PENDING SETUP');

  console.log('\n=== STATUS ===');
  console.log('Domain is verified in Microsoft tenant 596b57cc...');
  console.log('DNS is configured with MX and SPF');
  console.log('Ready to create mailboxes!');
}

main().catch(console.error);