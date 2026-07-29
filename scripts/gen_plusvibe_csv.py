#!/usr/bin/env python3
import subprocess, json, csv, os, sys

SSH = ["sshpass", "-p", "speed200ignite", "ssh", "-o", "StrictHostKeyChecking=no", "root@62.171.150.14"]
DBPATH = "/opt/unlimited-inboxes/shared/db/app.db"
SQL = "SELECT t.domain, json_extract(m.value, '$.email') as email, json_extract(m.value, '$.password') as password FROM orders o JOIN tenants t ON o.tenant_id = t.id, json_each(o.created_mailboxes) m WHERE o.status = 'completed' ORDER BY o.updated_at DESC, t.domain"

cmd = ["bash", "-c", "sqlite3 -json " + DBPATH + " '" + SQL + "'"]

print("SSHing to VPS and querying database...", flush=True)
result = subprocess.run(SSH + cmd, capture_output=True, text=True, timeout=180)

if result.returncode != 0:
 print("SSH FAILED: " + result.stderr[:500])
 sys.exit(1)

rows = json.loads(result.stdout)
print("Fetched " + str(len(rows)) + " mailboxes", flush=True)

out = os.path.expanduser("~/Downloads/plusvibe_mailboxes.csv")
with open(out, "w", newline="", encoding="utf-8") as f:
 w = csv.writer(f)
 w.writerow(["domain", "email", "password"])
 total = 0
 for row in rows:
 domain = (row.get("domain") or "").strip()
 email = (row.get("email") or "").strip()
 password = (row.get("password") or "").strip()
 if email:
 w.writerow([domain, email, password])
 total += 1

print("CSV written: " + out + " (" + str(total) + " mailboxes)")
