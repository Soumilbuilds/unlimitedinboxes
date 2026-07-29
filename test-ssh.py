#!/usr/bin/env python3
import base64, subprocess, json

sql = "SELECT t.domain, json_extract(m.value, '$.email') as email, json_extract(m.value, '$.password') as password FROM orders o JOIN tenants t ON o.tenant_id = t.id, json_each(o.created_mailboxes) m WHERE o.status = 'completed'"
b64 = base64.b64encode(sql.encode('utf-8')).decode('ascii')

print('Has single quote:', "'" in b64)
print('Has double quote:', '"' in b64)
print('Has dollar:', '$' in b64)

# Remote side uses single quotes so $ won't be expanded
remote = f"echo '{b64}' | base64 -d | sqlite3 -json /opt/unlimited-inboxes/shared/db/app.db"
# sshpass password has no single quotes, so outer sshpass -p 'PASS' is safe
cmd = f"sshpass -p 'speed200ignite' ssh -o StrictHostKeyChecking=no root@62.171.150.14 '{remote}'"

print('cmd preview:', cmd[:150])
r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=60)
print('status:', r.returncode)
if r.returncode == 0:
 rows = json.loads(r.stdout)
 print(f'Got {len(rows)} rows')
 for row in rows[:3]:
 e = row["email"]
 d = row["domain"]
 print(f' {e} ({d})')
else:
 print('stderr:', r.stderr[:300])
