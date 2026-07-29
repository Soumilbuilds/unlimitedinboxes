import re

with open('/Users/poonam/Desktop/Unlimited Mailboxes final/server/services/orderProcessor.js', 'r') as f:
 lines = f.readlines()

# We need to replace 4 bare 'await sleep;' with context-appropriate delays
# Line numbers (1-indexed): 317, 443, 785, 862
replacements = {
 317: 'await sleep;', # DNS propagation - already says 15s in log
 443: 'await sleep;', # after loginResult.page assignment
 785: 'await sleep;', # after preflight objectId
 862: 'await sleep;', # after mailbox creation in loop
}

# Let me use a different approach - find the surrounding context for each
for i, line in enumerate(lines):
 stripped = line.strip()
 if stripped == 'await sleep;':
 ctx = ''.join(lines[max(0, i-3):i])
 print(f"Line {i+1}: context above: {repr(ctx[:150])}")
