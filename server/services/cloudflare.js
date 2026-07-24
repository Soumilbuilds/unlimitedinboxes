import axios from 'axios';

const { CLOUDFLARE_API_TOKEN } = process.env;

// Custom nameservers from env (e.g., CLOUDFLARE_NS1=ns1.example.com, CLOUDFLARE_NS2=ns2.example.com)
const CUSTOM_NS = (process.env.CLOUDFLARE_NS1 || process.env.CLOUDFLARE_NS2)
  ? [process.env.CLOUDFLARE_NS1, process.env.CLOUDFLARE_NS2].filter(Boolean)
  : null;

// Primary token: DNS records, zone management (read/write existing zones)
const cf = axios.create({
  baseURL: 'https://api.cloudflare.com/client/v4',
  headers: {
    Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
    'Content-Type': 'application/json'
  },
  timeout: 30000
});

let cachedAccountId = null;

async function getAccountId(client = cf) {
  if (client === cf && cachedAccountId) return cachedAccountId;
  const res = await client.get('/accounts');
  if (!res.data?.result?.length) throw new Error('No Cloudflare account found');
  const id = res.data.result[0].id;
  if (client === cf) cachedAccountId = id;
  return id;
}

export async function createZone(domain) {
  const token = process.env.CLOUDFLARE_ZONE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  const client = axios.create({
    baseURL: 'https://api.cloudflare.com/client/v4',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    timeout: 30000
  });

  try {
    // Build request body
    const zonePayload = {
      name: domain,
      account: { id: await getAccountId(client) },
      type: 'full'
    };

    // If custom nameservers configured, add them (requires Business/Enterprise plan)
    if (CUSTOM_NS && CUSTOM_NS.length >= 2) {
      zonePayload.vanity_name_servers = CUSTOM_NS;
    }

    const res = await client.post('/zones', zonePayload);

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

// Update zone name servers after creation (fallback for plans that don't support vanity_name_servers)
export async function updateZoneNameServers(zoneId, nameServers) {
  if (!CUSTOM_NS || CUSTOM_NS.length < 2) return false;

  const token = process.env.CLOUDFLARE_ZONE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  const client = axios.create({
    baseURL: 'https://api.cloudflare.com/client/v4',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    timeout: 30000
  });

  try {
    const res = await client.patch(`/zones/${zoneId}`, {
      name_servers: CUSTOM_NS
    });
    return res.data.result.name_servers;
  } catch (error) {
    // Check if error is related to permissions (plan doesn't support custom nameservers)
    const code = error.response?.data?.errors?.[0]?.code;
    if (code === 1004) {
      console.warn('Custom nameservers not supported on this plan - falling back to Cloudflare defaults');
      return false;
    }
    throw error;
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

export async function getZoneStatus(zoneId) {
  const res = await cf.get(`/zones/${zoneId}`);
  return res.data?.result?.status || null;
}

async function upsertProxiedRedirectRecord(zoneId, name) {
  const records = await listDnsRecords(zoneId, { type: 'A', name });
  const data = {
    type: 'A',
    name,
    content: '192.0.2.1',
    ttl: 1,
    proxied: true
  };

  if (records.length > 0) {
    return updateDnsRecord(zoneId, records[0].id, data);
  }

  const res = await cf.post(`/zones/${zoneId}/dns_records`, data);
  return res.data?.result;
}

export async function upsertZoneRedirect(zoneId, domain, redirectUrl) {
  await upsertProxiedRedirectRecord(zoneId, domain);
  await upsertProxiedRedirectRecord(zoneId, `www.${domain}`);

  const targetValue = `*${domain}/*`;
  const actions = [{
    id: 'forwarding_url',
    value: {
      url: redirectUrl,
      status_code: 302
    }
  }];
  const targets = [{
    target: 'url',
    constraint: {
      operator: 'matches',
      value: targetValue
    }
  }];

  const existing = await cf.get(`/zones/${zoneId}/pagerules`, {
    params: { status: 'active' }
  });
  const rules = existing.data?.result || [];
  const current = rules.find(rule => (
    rule.actions?.some(action => action.id === 'forwarding_url')
    && rule.targets?.some(target => target.constraint?.value === targetValue)
  ));

  if (current) {
    await cf.put(`/zones/${zoneId}/pagerules/${current.id}`, {
      targets,
      actions,
      priority: current.priority || 1,
      status: 'active'
    });
    return { action: 'updated' };
  }

  await cf.post(`/zones/${zoneId}/pagerules`, {
    targets,
    actions,
    priority: 1,
    status: 'active'
  });
  return { action: 'created' };
}
