import re

with open('/Users/poonam/Desktop/Unlimited Mailboxes final/client/src/pages/Orders.jsx', 'r') as f:
 content = f.read()

# Fix A: Change useState('') to useState('__EMPTY__') for tenantMfaSecret
old_a = " const [tenantMfaSecret, setTenantMfaSecret] = useState('');"
new_a = " const [tenantMfaSecret, setTenantMfaSecret] = useState('__EMPTY__');"
assert old_a in content, "Fix A pattern not found"
content = content.replace(old_a, new_a)
print("Fix A: tenantMfaSecret default -> __EMPTY__")

# Fix B: Change setWizardStep(1) to setWizardStep(2) in handleCreateTenant
# Find the specific line in handleCreateTenant context
old_b = ''' setTenantId(res.data.id);
 setWizardStep(1);'''
new_b = ''' setTenantId(res.data.id);
 setWizardStep(2);'''
assert old_b in content, "Fix B pattern not found"
content = content.replace(old_b, new_b)
print("Fix B: setWizardStep(1) -> setWizardStep(2) in handleCreateTenant")

# Fix C: Remove handleSkipConsent function entirely
old_c = ''' // Consent step removed — handled automatically during order processing via puppeteer
 const handleSkipConsent = () => {
 if (wizardStep === 1) {
 setWizardStep(2);
 }
 };

 const handleGetNameServers'''
new_c = ''' const handleGetNameServers'''
assert old_c in content, "Fix C pattern not found"
content = content.replace(old_c, new_c)
print("Fix C: Removed handleSkipConsent")

with open('/Users/poonam/Desktop/Unlimited Mailboxes final/client/src/pages/Orders.jsx', 'w') as f:
 f.write(content)
print("All remaining Orders.jsx fixes written successfully")
