with open('/Users/poonam/Desktop/Unlimited Mailboxes final/server/services/orderProcessor.js', 'r') as f:
 content = f.read()

# Find all bare ' await sleep;' occurrences
import re

lines = content.split('\n')
for i, line in enumerate(lines):
 if line.strip() == 'await sleep;':
 ctx = '\n'.join(lines[max(0,i-4):i])
 print(f"Line {i+1}: ctx = ...{ctx[-120:]}")
 print()
