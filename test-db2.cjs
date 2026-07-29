#!/usr/bin/env node
const { spawnSync } = require('child_process');

const VPS_PASS = 'speed200ignite';
const VPS_USER = 'root';
const VPS_HOST = '62.171.150.14';
const VPS_DB = '/opt/unlimited-inboxes/shared/db/app.db';

const sql = "SELECT t.domain, json_extract(m.value, '\$.email') as email, json_extract(m.value, '\$.password') as password FROM orders o JOIN tenants t ON o.tenant_id = t.id, json_each(o.created_mailboxes) m WHERE o.status = 'completed'";

// Use heredoc: everything between 'EOF' markers is literal, no expansion
const remoteCmd = `sqlite3 -json ${VPS_DB}`;
const fullCmd = `sshpass -p '${VPS_PASS}' ssh -o StrictHostKeyChecking=no ${VPS_USER}@${VPS_HOST} "cat > /tmp/.pvq << 'SQLEOF'\n${sql}\nSQLEOF\n${remoteCmd} \\\"\$(cat /tmp/.pvq)\\\""`;

console.log('Trying heredoc approach...');
const r = spawnSync('bash', ['-c', fullCmd], { encoding: 'utf8', maxBuffer: 50*1024*1024, timeout: 60000 });
console.log('status:', r.status);
console.log('stderr:', r.stderr?.toString().slice(0,300));
console.log('stdout:', r.stdout?.toString().slice(0,500));
