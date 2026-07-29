with open('/Users/poonam/Desktop/Unlimited Mailboxes final/server/services/orderProcessor.js', 'r') as f:
 content = f.read()

lines = content.split('\n')
for i, line in enumerate(lines):
 if line.strip() == 'await sleep;':
 ctx = '\n'.join(lines[max(0,i-5):i])
 print(f'Line {i+1}:')
 print(f'Context: {repr(ctx[-200:])}')
 print()
