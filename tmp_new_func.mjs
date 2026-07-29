async function fetchMailboxes() {
 const sql = "SELECT t.domain, json_extract(m.value, '$.email') as email, json_extract(m.value, '$.password') as password FROM orders o JOIN tenants t ON o.tenant_id = t.id, json_each(o.created_mailboxes) m WHERE o.status = 'completed'";
 const sqlB64 = Buffer.from(sql, 'utf8').toString('base64');
 const { spawnSync } = require('child_process');
 // base64 alphabet has no shell metachars - safe inside double-quoted bash -c
 const remoteCmd = 'bash -c "echo ' + sqlB64 + ' | base64 -d | sqlite3 -json ' + VPS_DB + '"';
 const result = spawnSync(
 'sshpass', ['-p', VPS_PASS, 'ssh', '-o', 'StrictHostKeyChecking=no',
 VPS_USER + '@' + VPS_HOST, remoteCmd],
 { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024, timeout: 180000 }
 );
 if (result.error) throw result.error;
 const raw = (result.stdout || '').toString().trim();
 if (!raw) throw new Error('Empty DB response');
 const rows = [];
 const lines = raw.split('\n');
 for (const line of lines) {
 if (!line.trim()) continue;
 try { rows.push(JSON.parse(line)); } catch { /* skip bad rows */ }
 }
 if (!rows.length) throw new Error('No valid rows: ' + raw.slice(0, 200));
 return rows;
}
