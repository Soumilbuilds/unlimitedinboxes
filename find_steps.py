with open('/Users/poonam/Desktop/Unlimited Mailboxes final/client/src/pages/Orders.jsx', 'r') as f:
 content = f.read()

lines = content.split('\n')
for i, line in enumerate(lines):
 if 'setWizardStep(2)' in line:
 print('Line ' + str(i+1) + ': ' + repr(line))
