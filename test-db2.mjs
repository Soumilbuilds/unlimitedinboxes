#!/usr/bin/env node
import { execSync } from 'child_process';
import Buffer from 'buffer';

const VPS_PASS = 'speed200ignite';
const VPS_USER = 'root';
const VPS_HOST = '62.171.150.14';
const VPS_DB = '/opt/unlimited-inboxes/shared/db/app.db';

const sql = 'SELECT t.domain, json_extract(m.value, "$.email") as email, json_extract(m.value, "$.password") as password FROM orders o JOIN tenants t ON o.tenant_id = t.id, json_each(o.created_mailboxes) m WHERE o.status = \'completed\'';

const sqlBase64 = Buffer.from(sql, 'utf8').toString('base64');

// Build command: pipe base64 through ssh, decode on remote, feed to sqlite3
// Use single quotes around the entire remote command so base64 is literal
const remoteCmd = `echo '${sqlBase64}' | base64 -d | sqlite3 -json ${VPS_DB}`;
const fullCmd = `sshpass -p '${VPS_PASS}' ssh -o StrictHostKeyChecking=no ${VPS_USER}@${VPS_HOST} '${remoteCmd.replace(/'/g, "'\"'\"'")}'`;

console.log('CMD:', fullCmd.slice(0, 200));
try {
 const result = execSync(fullCmd, { encoding: 'utf8', maxBuffer: 50*1024*1024, timeout: 60000 });
 console.log('OK, rows:', JSON.parse(result).length);
} catch (e) {
 console.error('ERR:', e.message);
 const out = (e.stdout || '') + (e.stderr || '');
 console.error('OUT:', out.slice(0, 500));
}
