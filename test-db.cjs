#!/usr/bin/env node
const { execSync } = require('child_process');

const VPS_PASS = 'speed200ignite';
const VPS_USER = 'root';
const VPS_HOST = '62.171.150.14';
const VPS_DB = '/opt/unlimited-inboxes/shared/db/app.db';

const sql = `SELECT t.domain,
 json_extract(m.value, '$.email') as email,
 json_extract(m.value, '$.password') as password
FROM orders o
JOIN tenants t ON o.tenant_id = t.id,
 json_each(o.created_mailboxes) m
WHERE o.status = 'completed'
ORDER BY o.updated_at DESC, t.domain
LIMIT 3`;

const sqlBase64 = Buffer.from(sql, 'utf8').toString('base64');
const remoteCmd = `echo ${sqlBase64} | base64 -d | sqlite3 -json ${VPS_DB}`;
const fullCmd = `sshpass -p '${VPS_PASS}' ssh -o StrictHostKeyChecking=no ${VPS_USER}@${VPS_HOST} "${remoteCmd.replace(/"/g, '\\"')}"`;

console.log('Running DB query...');
try {
 const result = execSync(fullCmd, {
 encoding: 'utf8',
 maxBuffer: 10 * 1024 * 1024,
 timeout: 60000,
 });
 const rows = JSON.parse(result);
 console.log(`Got ${rows.length} rows:`);
 rows.forEach(r => console.log(` ${r.email} (${r.domain})`));
} catch (e) {
 console.error('Error:', e.message);
 if (e.stderr) console.error('stderr:', e.stderr.toString().slice(0, 300));
 if (e.stdout) console.error('stdout:', e.stdout.toString().slice(0, 300));
}
