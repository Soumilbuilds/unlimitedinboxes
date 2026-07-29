#!/usr/bin/env python3
import base64, subprocess, json

sql = "SELECT t.domain, json_extract(m.value, '$.email') as email, json_extract(m.value, '$.password') as password FROM orders o JOIN tenants t ON o.tenant_id = t.id, json_each(o.created_mailboxes) m WHERE o.status = 'completed'"
b64 = base64.b64encode(sql.encode("utf-8")).decode("ascii")

print("Has single quote in b64:", "'" in b64)
print("Has dollar in b64:", "$" in b64)

# Remote single quotes protect base64 payload from shell expansion
# sshpass -p 'PASS' protects password
remote = "echo '" + b64 + "' | base64 -d | sqlite3 -json /opt/unlimited-inboxes/shared/db/app.db"
cmd = "sshpass -p 'speed200ignite' ssh -o StrictHostKeyChecking=no root@62.171.150.14 '" + remote + "'"
print("cmd:", cmd[:120])
r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=60)
print("status:", r.returncode)
if r.returncode == 0:
 rows = json.loads(r.stdout)
 print("Got", len(rows), "rows")
 for row in rows[:3]:
 print(" ", row["email"], "(", row["domain"], ")")
else:
 print("stderr:", r.stderr[:300])
