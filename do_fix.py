import re

filepath = '/Users/poonam/Desktop/Unlimited Mailboxes final/server/services/orderProcessor.js'

with open(filepath, 'r') as f:
 content = f.read()

# Strategy: replace specific patterns of bare sleep calls
# Pattern 1: after DNS propagation log message
content = content.replace(
 "logMessage(orderId, 'Waiting for DNS propagation (15s)...');\n await sleep;",
 "logMessage(orderId, 'Waiting for DNS propagation (15s)...');\n await sleep;"
)

# Actually the old/new are the same. Let me use regex replacement
content = re.sub(
 r"(logMessage\(orderId, 'Waiting for DNS propagation.*?'\);\n) await sleep;",
 r"\1await sleep;",
 content
)

# OK let me try a completely different approach - find line by line
lines = content.split('\n')
new_lines = []
for i, line in enumerate(lines):
 if line.strip() == 'await sleep;':
 # Need context from previous lines
 prev_lines = lines[max(0,i-5):i]
 ctx = '\n'.join(prev_lines)
 if 'DNS propagation' in ctx:
 new_lines.append(' await sleep;')
 elif 'loginResult.page' in ctx:
 new_lines.append(' await sleep;')
 elif 'objectId = userId' in ctx:
 new_lines.append(' await sleep;')
 elif 'updateOrderProgress' in ctx and 'createdMailboxes.length' not in '\n'.join(lines[min(len(lines)-1,i+1):i+3]):
 # Check if next lines reference remainingCount/mailboxCreationWeight
 next_ctx = '\n'.join(lines[i+1:min(len(lines),i+5)])
 if 'mailboxCreationWeight' in next_ctx:
 new_lines.append(' await sleep;')
 else:
 new_lines.append(' await sleep;')
 else:
 new_lines.append(' await sleep;')
 else:
 new_lines.append(line)

with open(filepath, 'w') as f:
 f.write('\n'.join(new_lines))

print("Done - checking remaining bare sleep calls")
with open(filepath, 'r') as f:
 final = f.read()
count = final.count('await sleep;')
print(f"Remaining bare sleep calls: {count}")
