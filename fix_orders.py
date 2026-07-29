import re

with open('/Users/poonam/Desktop/Unlimited Mailboxes final/client/src/pages/Orders.jsx', 'r') as f:
 content = f.read()

# Change 1.1: useState default and add mfaSecretTouched
old = " const [tenantMfaSecret, setTenantMfaSecret] = useState('');\n const [tenantId, setTenantId] = useState(null);"
new = " const [tenantMfaSecret, setTenantMfaSecret] = useState('__EMPTY__');\n const [mfaSecretTouched, setMfaSecretTouched] = useState(false);\n const [tenantId, setTenantId] = useState(null);"
assert old in content, "Pattern 1.1 not found"
content = content.replace(old, new)
print("Change 1.1 done")

# Change 1.2: Update MFA label and placeholder
old2 = '<label>\n MFA Secret (optional)\n <input\n type="text"\n value={tenantMfaSecret}\n onChange={(e) => setTenantMfaSecret(e.target.value)}\n placeholder="MFA secret (from 2fa.live or authenticator app)"\n />\n </label>'
new2 = '<label>\n MFA Secret\n <input\n type="text"\n value={tenantMfaSecret}\n onChange={(e) => { setTenantMfaSecret(e.target.value); setMfaSecretTouched(true); }}\n placeholder="MFA secret (Base32)"\n />\n </label>'
assert old2 in content, "Pattern 1.2 not found"
content = content.replace(old2, new2)
print("Change 1.2 done")

# Change 1.3+1.4: handleCreateTenant - add MFA validation and fix mfa_secret
old3 = ''' const res = await api.post('/tenants', {
 name,
 domain: tempDomain,
 admin_email: tenantEmail,
 admin_password: tenantPassword,
 mfa_secret: tenantMfaSecret || null
 });
 setTenantId(res.data.id);
 setWizardStep(1);'''
new3 = ''' if (!tenantMfaSecret || tenantMfaSecret.trim() === '' || tenantMfaSecret === '__EMPTY__') {
 setMfaSecretTouched(true);
 setWizardError('MFA secret is required for Microsoft 365 order processing.');
 setWizardBusy(false);
 return;
 }
 const res = await api.post('/tenants', {
 name,
 domain: tempDomain,
 admin_email: tenantEmail,
 admin_password: tenantPassword,
 mfa_secret: tenantMfaSecret.trim()
 });
 setTenantId(res.data.id);
 setWizardStep(2);'''
assert old3 in content, "Pattern 1.3 not found"
content = content.replace(old3, new3)
print("Changes 1.3+1.4 done")

# Change 1.5: stepTitles remove "Microsoft consent"
old4 = """ const stepTitles = canUseCustomNames
 ? ['Tenant credentials', 'Microsoft consent', 'Domain setup', 'Domain redirect', 'Order details', 'Set names']
 : ['Tenant credentials', 'Microsoft consent', 'Domain setup', 'Domain redirect', 'Order details'];"""
new4 = """ const stepTitles = canUseCustomNames
 ? ['Tenant credentials', 'Domain setup', 'Domain redirect', 'Order details', 'Set names']
 : ['Tenant credentials', 'Domain setup', 'Domain redirect', 'Order details'];"""
assert old4 in content, "Pattern 1.5 not found"
content = content.replace(old4, new4)
print("Change 1.5 done")

# Change 1.6: handleCheckNameServers - setWizardStep(2) instead of 3
old5 = " await api.patch(`/tenants/${tenantId}/status`, { status: 'ready' });\n setWizardStep(3);"
new5 = " await api.patch(`/tenants/${tenantId}/status`, { status: 'ready' });\n setWizardStep(2);"
assert old5 in content, "Pattern 1.6 not found"
content = content.replace(old5, new5)
print("Change 1.6 done")

# Change 1.7: handleRedirectStepNext - setWizardStep(3) instead of 4
old6 = " setRedirectUrl(res.data?.redirect_url || redirectUrl.trim());\n setWizardStep(4);"
new6 = " setRedirectUrl(res.data?.redirect_url || redirectUrl.trim());\n setWizardStep(3);"
assert old6 in content, "Pattern 1.7 not found"
content = content.replace(old6, new6)
print("Change 1.7 done")

# Change 1.8: handleOrderDetailsNext - setWizardStep(4) instead of 5, and back buttons
# First the setWizardStep(5) in handleOrderDetailsNext
old7 = ''' if (canUseCustomNames) {
 setWizardStep(5);
 } else {
 handleStartOrder();
 }
 };

 const handleStartOrderWithNames'''
new7 = ''' if (canUseCustomNames) {
 setWizardStep(4);
 } else {
 handleStartOrder();
 }
 };

 const handleStartOrderWithNames'''
assert old7 in content, "Pattern 1.8 not found"
content = content.replace(old7, new7)
print("Change 1.8 done")

# Change 1.9: Replace handleOpenConsent and handleCheckConsent with no-op stubs
old8 = ''' const handleOpenConsent = async () => {
 if (!tenantId) return;
 setWizardBusy(true);
 setWizardError('');
 try {
 const res = await api.post(`/tenants/${tenantId}/connect`);
 if (res.data.consentUrl) {
 window.open(res.data.consentUrl, 'MicrosoftConsent', 'width=600,height=720');
 }
 } catch (e) {
 setWizardError(e.response?.data?.error || 'Failed to open consent window');
 } finally {
 setWizardBusy(false);
 }
 };

 const handleCheckConsent = async () => {
 if (!tenantId) return;
 setWizardBusy(true);
 setWizardError('');
 try {
 const res = await api.get('/tenants');
 const tenant = res.data.find(t => t.id === tenantId);
 if (tenant?.tenant_id) {
 setWizardStep(2);
 } else {
 setWizardError('Consent is not completed yet. Finish the Microsoft prompt, then try again.');
 }
 } catch (e) {
 setWizardError(e.response?.data?.error || 'Could not verify consent yet');
 } finally {
 setWizardBusy(false);
 }
 };'''
new8 = ''' // Consent step removed - handled automatically during order processing
 const handleOpenConsent = async () => { /* no-op */ };
 const handleCheckConsent = async () => { /* no-op */ };'''
assert old8 in content, "Pattern 1.9 not found"
content = content.replace(old8, new8)
print("Change 1.9 done")

# Change 1.10: Replace consent step JSX with Continue button
old10 = ''' {wizardStep === 1 && (
 <div className="form">
 <div className="modal-actions">
 <button className="btn ghost" onClick={() => setWizardStep(0)}>Back</button>
 <button className="btn primary" onClick={handleOpenConsent} disabled={wizardBusy}>
 {wizardBusy ? 'Opening...' : 'Open Consent'}
 </button>
 <button className="btn success" onClick={handleCheckConsent} disabled={wizardBusy}>
 I Have Connected
 </button>
 </div>
 </div>
 )}'''
new10 = ''' {wizardStep === 1 && (
 <div className="form">
 <div className="modal-actions">
 <button className="btn ghost" onClick={() => setWizardStep(0)}>Back</button>
 <button className="btn primary" onClick={() => setWizardStep(2)} disabled={wizardBusy}>
 Continue
 </button>
 </div>
 </div>
 )}'''
assert old10 in content, "Pattern 1.10 not found"
content = content.replace(old10, new10)
print("Change 1.10 done")

with open('/Users/poonam/Desktop/Unlimited Mailboxes final/client/src/pages/Orders.jsx', 'w') as f:
 f.write(content)
print("All Orders.jsx changes written successfully")
