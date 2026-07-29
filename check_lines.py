filepath = '/Users/poonam/Desktop/Unlimited Mailboxes final/server/services/orderProcessor.js'

with open(filepath, 'r') as f:
 content = f.read()

# Fix line 317: DNS propagation wait -> 15000ms
content = content.replace(
 """logMessage(orderId, 'Waiting for DNS propagation (15s)...');
 await sleep;
 if (checkCancelled(orderId)) return;""",
 """logMessage(orderId, 'Waiting for DNS propagation (15s)...');
 await sleep;
 if (checkCancelled(orderId)) return;"""
)

# Actually the content is the same. The issue is the sleep() call has no arguments.
# Let me read the raw bytes to see what's happening

with open(filepath, 'r') as f:
 lines = f.readlines()

for idx in [316, 317, 442, 443, 784, 785, 861, 862]:
 line = lines[idx]
 print(f"Line {idx+1}: {repr(line)}")
