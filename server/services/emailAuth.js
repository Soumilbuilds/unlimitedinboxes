import { addDnsRecord, listDnsRecords, upsertDnsRecord } from './cloudflare.js';

function normalizeName(name) {
  return String(name || '').trim().toLowerCase();
}

export async function ensureSpfRecord(zoneId, domain, spfValue) {
  const fqdn = normalizeName(domain);
  const records = await listDnsRecords(zoneId, { type: 'TXT', name: fqdn });
  const existing = records.find(r => String(r.content || '').toLowerCase().includes('v=spf1'));
  if (existing) {
    return { action: 'skipped', reason: 'SPF already exists', content: existing.content };
  }

  await addDnsRecord(zoneId, 'TXT', fqdn, spfValue);
  return { action: 'created', content: spfValue };
}

export async function ensureDmarcRecord(zoneId, domain, dmarcValue) {
  const fqdn = `_dmarc.${normalizeName(domain)}`;
  const records = await listDnsRecords(zoneId, { type: 'TXT', name: fqdn });
  if (records.length > 0) {
    return { action: 'skipped', reason: 'DMARC already exists', content: records[0].content };
  }

  await addDnsRecord(zoneId, 'TXT', fqdn, dmarcValue);
  return { action: 'created', content: dmarcValue };
}

export async function ensureDkimRecords(zoneId, domain, selector1Cname, selector2Cname) {
  const base = normalizeName(domain);
  const selector1Name = `selector1._domainkey.${base}`;
  const selector2Name = `selector2._domainkey.${base}`;

  const selector1Result = await upsertDnsRecord(zoneId, 'CNAME', selector1Name, selector1Cname);
  const selector2Result = await upsertDnsRecord(zoneId, 'CNAME', selector2Name, selector2Cname);

  return {
    selector1: selector1Result,
    selector2: selector2Result
  };
}
