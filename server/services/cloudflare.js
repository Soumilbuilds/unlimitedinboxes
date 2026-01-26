import axios from 'axios';

const { CLOUDFLARE_API_TOKEN } = process.env;

const cf = axios.create({
  baseURL: 'https://api.cloudflare.com/client/v4',
  headers: {
    Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
    'Content-Type': 'application/json'
  },
  timeout: 30000
});

let cachedAccountId = null;

async function getAccountId() {
  if (cachedAccountId) return cachedAccountId;
  const res = await cf.get('/accounts');
  if (!res.data?.result?.length) throw new Error('No Cloudflare account found');
  cachedAccountId = res.data.result[0].id;
  return cachedAccountId;
}

export async function createZone(domain) {
  try {
    const res = await cf.post('/zones', {
      name: domain,
      account: { id: await getAccountId() },
      type: 'full'
    });

    return {
      id: res.data.result.id,
      name_servers: res.data.result.name_servers
    };
  } catch (error) {
    const code = error.response?.data?.errors?.[0]?.code;
    if (code === 1061) {
      const existing = await cf.get(`/zones?name=${domain}`);
      const zone = existing.data?.result?.[0];
      if (zone) {
        return {
          id: zone.id,
          name_servers: zone.name_servers || []
        };
      }
    }
    throw new Error(`Cloudflare Error: ${JSON.stringify(error.response?.data || error.message)}`);
  }
}

export async function addDnsRecord(zoneId, type, name, content, priority = undefined) {
  try {
    await cf.post(`/zones/${zoneId}/dns_records`, {
      type,
      name,
      content,
      ttl: 1,
      proxied: false,
      priority
    });
  } catch (error) {
    const code = error.response?.data?.errors?.[0]?.code;
    if (code !== 81057 && code !== 81058) {
      throw new Error(`DNS Error: ${JSON.stringify(error.response?.data || error.message)}`);
    }
  }
}

export async function listDnsRecords(zoneId, params = {}) {
  const res = await cf.get(`/zones/${zoneId}/dns_records`, { params });
  return res.data?.result || [];
}

export async function updateDnsRecord(zoneId, recordId, data) {
  const res = await cf.put(`/zones/${zoneId}/dns_records/${recordId}`, {
    ttl: 1,
    proxied: false,
    ...data
  });
  return res.data?.result;
}

export async function upsertDnsRecord(zoneId, type, name, content, priority = undefined) {
  const records = await listDnsRecords(zoneId, { type, name });
  if (records.length > 0) {
    const match = records.find(r => r.content === content);
    if (match) {
      return { action: 'unchanged', record: match };
    }
    const updated = await updateDnsRecord(zoneId, records[0].id, { type, name, content, priority });
    return { action: 'updated', record: updated };
  }

  await addDnsRecord(zoneId, type, name, content, priority);
  return { action: 'created' };
}
