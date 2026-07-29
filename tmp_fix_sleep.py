with open('/Users/poonam/Desktop/Unlimited Mailboxes final/server/services/orderProcessor.js', 'r') as f:
 lines = f.readlines()

replacements = {
 332: (15000, 'DNS propagation wait'),
 457: (5000, 'post-preflight wait'),
 805: (1500, 'post-creation wait'),
 883: (1500, 'inter-creation wait'),
}

for line_num, (delay, reason) in replacements.items():
 idx = line_num - 1
 stripped = lines[idx].strip()
 if stripped == 'await sleep;':
 indent = len(lines[idx]) - len(lines[idx].lstrip())
 spaces = lines[idx][:indent]
 lines[idx] = f"{spaces}await sleep({delay});\n"
 print(f"Fixed line {line_num}: {reason} -> {delay}ms")
 else:
 print(f"Line {line_num}: unexpected content: {repr(stripped)}")

with open('/Users/poonam/Desktop/Unlimited Mailboxes final/server/services/orderProcessor.js', 'w') as f:
 f.writelines(lines)
print("Done")
