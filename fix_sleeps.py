with open('/Users/poonam/Desktop/Unlimited Mailboxes final/server/services/orderProcessor.js', 'r') as f:
 content = f.read()

# Replace all bare 'await sleep;' with 'await sleep;' - the function has a default param
# So this works, but let's add a small delay for the key places using line-by-line approach
lines = content.split('\n')
new_lines = []

for i, line in enumerate(lines):
 if line.strip() == 'await sleep;':
 # Get context from surrounding lines
 prev_lines = lines[max(0,i-5):i]
 ctx = '\n'.join(prev_lines)
 if 'DNS propagation' in ctx:
 new_lines.append(' await sleep;')
 elif 'loginResult.page' in ctx:
 new_lines.append(' await sleep;')
 elif 'objectId = userId' in ctx:
 new_lines.append(' await sleep;')
 elif 'createdCount' in ctx or 'remainingCount' in ctx:
 new_lines.append(' await sleep;')
 else:
 new_lines.append(' await sleep;')
 else:
 new_lines.append(line)

result = '\n'.join(new_lines)
with open('/Users/poonam/Desktop/Unlimited Mailboxes final/server/services/orderProcessor.js', 'w') as f:
 f.write(result)

# Verify
with open('/Users/poonam/Desktop/Unlimited Mailboxes final/server/services/orderProcessor.js', 'r') as f:
 final = f.read()
count = final.count('await sleep;')
print(f"Remaining bare sleep calls: {count}")
if count == 0:
 print("All fixed!")
else:
 for i, line in enumerate(final.split('\n')):
 if line.strip() == 'await sleep;':
 print(f" Line {i+1}")
