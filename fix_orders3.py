with open('/Users/poonam/Desktop/Unlimited Mailboxes final/client/src/pages/Orders.jsx', 'r') as f:
 content = f.read()

# Fix A: resetWizard should reset tenantMfaSecret to '__EMPTY__'
old_a = " setTenantMfaSecret('');\n setMfaSecretTouched(false);\n setMfaSecretValid(true);"
new_a = " setTenantMfaSecret('__EMPTY__');\n setMfaSecretTouched(false);\n setMfaSecretValid(true);"
assert old_a in content, "Fix A pattern not found"
content = content.replace(old_a, new_a)
print("Fix A: resetWizard tenantMfaSecret -> '__EMPTY__'")

# Fix B: handleCreateTenant should go to step 1 (domain setup), not step 2 (redirect)
# In the new numbering: step 0=credentials, step 1=domain setup, step 2=redirect, step 3=order details
old_b = " setTenantId(res.data.id);\n setWizardStep(2);"
new_b = " setTenantId(res.data.id);\n setWizardStep(1);"
assert old_b in content, "Fix B pattern not found"
content = content.replace(old_b, new_b)
print("Fix B: handleCreateTenant setWizardStep(2) -> setWizardStep(1)")

with open('/Users/poonam/Desktop/Unlimited Mailboxes final/client/src/pages/Orders.jsx', 'w') as f:
 f.write(content)
print("Done")
