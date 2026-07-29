import sqlite3

conn = sqlite3.connect("/opt/unlimited-inboxes/shared/db/app.db")
conn.row_factory = sqlite3.Row
cur = conn.cursor()

# Sample first 5 mailboxes
cur.execute("""SELECT t.domain, json_extract(m.value, '$.email') as email,
 json_extract(m.value, '$.password') as password
FROM orders o
JOIN tenants t ON o.tenant_id = t.id,
 json_each(o.created_mailboxes) m
WHERE o.status = 'completed'
ORDER BY o.updated_at DESC, t.domain
LIMIT 5""")
rows = cur.fetchall()
print("=== SAMPLE MAILBOXES (first 5) ===")
for r in rows:
 print(" {} | domain={} | password={}".format(r['email'], r['domain'], r['password']))

# Count per domain
cur.execute("""SELECT t.domain, COUNT(*) as cnt
FROM orders o
JOIN tenants t ON o.tenant_id = t.id,
 json_each(o.created_mailboxes) m
WHERE o.status = 'completed'
GROUP BY t.domain
ORDER BY cnt DESC
LIMIT 20""")
rows2 = cur.fetchall()
print("\n=== MAILBOXES PER DOMAIN (top 20) ===")
for r in rows2:
 print(" {:>5} | {}".format(r['cnt'], r['domain']))

conn.close()
