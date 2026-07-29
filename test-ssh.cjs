#!/usr/bin/env node
// Minimal SSH+SQLite helper — isolates quoting concerns
const { spawnSync } = require('child_process');
const pass = 'speed200ignite';
const host = 'root@62.171.150.14';
const db = '/opt/unlimited-inboxes/shared/db/app.db';

const sql = "SELECT t.domain, json_extract(m.value, '\$.email') as email, json_extract(m.value, '\$.password') as password FROM orders o JOIN tenants t ON o.tenant_id = t.id, json_each(o.created_mailboxes) m WHERE o.status = 'completed'";

// Build the full bash command carefully:
// 1. ssh connects
// 2. On remote: echo receives SQL via local heredoc, pipes to sqlite3
// We use local shell heredoc to send SQL, then pipe to remote
const bashCmd = `
sshpass -p '${pass}' ssh -o StrictHostKeyChecking=no ${host} \
 "cat > /tmp/.pvq" << 'INNEREOF'
${sql}
INNEREOF
sshpass -p '${pass}' ssh -o StrictHostKeyChecking=no ${host} \
 "sqlite3 -json ${db} \\\"\$(cat /tmp/.pvq)\\\""
`;

console.log('Testing...');
const r = spawnSync('bash', ['-c', bashCmd], {
 encoding: 'utf8',
 maxBuffer: 10 * 1024 * 1024,
 timeout: 60000,
});
console.log('status:', r.status);
if (r.stderr) console.error('stderr:', r.stderr.toString().slice(0, 300));
if (r.status === 0) {
 const rows = JSON.parse(r.stdout);
 console.log(`Got ${rows.length} rows`);
 console.log('First:', rows[0]?.email, rows[0]?.domain);
} else {
 console.log('stdout:', r.stdout?.toString().slice(0, 300));
}
