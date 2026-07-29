import sqlite3
import json

conn = sqlite3.connect("/opt/unlimited-inboxes/shared/db/app.db")
conn.row_factory = sqlite3.Row
cur = conn.cursor()

# Use Python to parse JSON and avoid sqlite json_each issues
cur.execute("SELECT id, tenant_id, created_mailboxes FROM orders WHERE status = 'completed'")
all_rows = cur.fetchall()

mailboxes = []
domain_counts = {}

for row in all_rows:
 try:
 boxes = json.loads(row['created_mailboxes'])
 except Exception:
 continue

 cur2 = conn.cursor()
 cur2.execute("SELECT domain FROM tenants WHERE id = ?", (row['tenant_id'],))
 trow = cur2.fetchone()
 domain = trow['domain'] if trow else 'unknown'

 domain_counts[domain] = domain_counts.get(domain, 0) + len(boxes)

 for b in boxes:
 mailboxes.append({
 'email': b.get('email', ''),
 'password': b.get('password', ''),
 'domain': domain
 })

print('Total completed orders with valid JSON:', len(all_rows))
print('Total mailboxes available for PlusVibe upload:', len(mailboxes))
print('')
print('=== SAMPLE (first 5 mailboxes) ===')
for m in mailboxes[:5]:
 print(m['email'], '|', m['domain'], '|', m['password'])

print('')
print('=== MAILBOXES PER DOMAIN (top 20) ===')
for d, c in sorted(domain_counts.items(), key=lambda x: -x[1])[:20]:
 print(str(c).rjust(6), '|', d)

conn.close()
