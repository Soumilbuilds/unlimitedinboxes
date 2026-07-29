#!/usr/bin/env python3
import subprocess, re
REPO = "/Users/poonam/Desktop/Unlimited Mailboxes final"
OUT = f"{REPO}/client/src/pages/Orders.jsx"
subprocess.run(["git", "show", "HEAD:client/src/pages/Orders.jsx"],
 cwd=REPO, stdout=open("/tmp/orders_src.jsx", "w"), check=True)
with open("/tmp/orders_src.jsx") as f:
 lines = f.readlines()
changes = 0
def find_line(pattern):
 for i, l in enumerate(lines):
 if pattern in l:
 return i
 return -1
def insert_at(idx, text):
 lines.insert(idx, text)
 global changes
 changes += 1
# CHANGE 1: stepTitles remove consent
idx = find_line(chr(39)+"Microsoft consent"+chr(39))
if idx >= 0:
 lines[idx] = lines[idx].replace(chr(39)+"Microsoft consent"+chr(39)+", ", "")
 changes += 1
# CHANGE 2: MFA label
idx = find_line('MFA Secret (optional)')
if idx >= 0:
 lines[idx] = lines[idx].replace('MFA Secret (optional)', 'MFA Secret (required)')
 changes += 1
# CHANGE 3: MFA placeholder
idx = find_line('MFA secret (from 2fa.live')
if idx >= 0:
 lines[idx] = lines[idx].replace('MFA secret (from 2fa.live or authenticator app)', 'MFA secret')
 changes += 1
# CHANGE 4: __EMPTY__ default
for i, l in enumerate(lines):
 if "'__EMPTY__'" in l:
 lines[i] = l.replace("'__EMPTY__'", "''")
 changes += 1
 break
# CHANGE 5: validateMfaSecret function
idx = find_line('const handleGetNameServers')
if idx >= 0:
 mfa_fn = (
 'const validateMfaSecret = (secret) => {' + chr(10) +
 ' if (!secret || secret.trim() === chr(39)+chr(39)) return false;' + chr(10) +
 ' const cleaned = secret.replace(/\\s/g, chr(39)+chr(39)).toUpperCase();' + chr(10) +
 ' if (!/^[A-Z2-7]+=*' + chr(36) + '/.test(cleaned)) return false;' + chr(10) +
 ' if (cleaned.length < 16 || cleaned.length > 128) return false;' + chr(10) +
 ' return true;' + chr(10) +
 '};' + chr(10)*2
 )
 insert_at(idx, mfa_fn)
# CHANGE 6: MFA state vars
idx = find_line('const [tenantMfaSecret, setTenantMfaSecret]')
if idx >= 0:
 j = idx
 while j < len(lines):
 if "useState" in lines[j] and "tenantMfaSecret" in lines[j]:
 k = j
 while k < len(lines) and ");" not in lines[k]:
 k += 1
 if k < len(lines):
 insert_at(k + 1, " const [mfaSecretTouched, setMfaSecretTouched] = useState(false);" + chr(10))
 insert_at(k + 2, " const [mfaSecretValid, setMfaSecretValid] = useState(true);" + chr(10))
 break
 j += 1
with open("/tmp/orders_src.jsx", "w") as f:
 f.writelines(lines)
with open("/tmp/orders_src.jsx") as f:
 lines = f.readlines()
# CHANGE 7: MFA onChange
for i, l in enumerate(lines):
 if 'setTenantMfaSecret(e.target.value)' in l:
 lines[i] = l.rstrip().rstrip(';') + ';' + chr(10) + ' setMfaSecretTouched(true);' + chr(10) + ' setMfaSecretValid(validateMfaSecret(e.target.value));' + chr(10)
 changes += 1
 break
# CHANGE 8: Error display
idx = find_line('MFA Secret (required)')
if idx >= 0:
 j = idx + 1
 while j < len(lines):
 if "</label>" in lines[j]:
 insert_at(j + 1, " {mfaSecretTouched && !mfaSecretValid && (" + chr(10))
 insert_at(j + 2, " <span className=\"error\">Enter a valid Base32 secret (A-Z, 2-7, 16-128 chars)</span>" + chr(10))
 insert_at(j + 3, " )}" + chr(10))
 changes += 1
 break
 j += 1
with open("/tmp/orders_src.jsx", "w") as f:
 f.writelines(lines)
with open("/tmp/orders_src.jsx") as f:
 lines = f.readlines()
# CHANGE 9: Continue button
idx = find_line('disabled={wizardBusy || !tenantEmail || !tenantPassword}')
if idx >= 0:
 lines[idx] = lines[idx].replace('disabled={wizardBusy || !tenantEmail || !tenantPassword}',
 "disabled={wizardBusy || !tenantEmail || !tenantPassword || !validateMfaSecret(tenantMfaSecret)}")
 changes += 1
# CHANGE 10: Remove || null
idx = find_line('tenantMfaSecret || null')
if idx >= 0:
 lines[idx] = lines[idx].replace('tenantMfaSecret || null', 'tenantMfaSecret')
 changes += 1
# CHANGE 11: Remove handleOpenConsent and handleCheckConsent
start = find_line("const handleOpenConsent")
end = find_line("const handleGetNameServers")
if start >= 0 and end >= 0 and end > start:
 del lines[start:end]
 changes += 1
with open("/tmp/orders_src.jsx", "w") as f:
 f.writelines(lines)
with open("/tmp/orders_src.jsx") as f:
 lines = f.readlines()
# CHANGE 12: Remove {wizardStep === 1} consent block
for i, l in enumerate(lines):
 if "{wizardStep === 1 && (" in l:
 j = i + 1
 found_consent = False
 while j < min(i + 30, len(lines)):
 if "Open Consent" in lines[j] or "I Have Connected" in lines[j]:
 found_consent = True
 break
 j += 1
 if found_consent:
 j = i + 1
 depth = 0
 in_block = False
 while j < len(lines):
 for ch in lines[j]:
 if ch == "(" and not in_block:
 in_block = True
 depth += 1
 elif ch == ")" and in_block:
 depth -= 1
 if depth == 0:
 j += 1
 break
 else:
 j += 1
 continue
 break
 del lines[i:j]
 changes += 1
 break
with open("/tmp/orders_src.jsx", "w") as f:
 f.writelines(lines)
with open("/tmp/orders_src.jsx") as f:
 lines = f.readlines()
# CHANGE 13: Renumber wizardStep checks
for i, l in enumerate(lines):
 if "{wizardStep === 2 && (" in l:
 nearby = "".join(lines[max(0,i):min(len(lines),i+8)])
 if "Domain to connect" in nearby or "Get Name Servers" in nearby:
 lines[i] = l.replace("wizardStep === 2", "wizardStep === 1")
 changes += 1
 break
for i, l in enumerate(lines):
 if "{wizardStep === 3 && (" in l:
 nearby = "".join(lines[max(0,i):min(len(lines),i+8)])
 if "redirect" in nearby.lower():
 lines[i] = l.replace("wizardStep === 3", "wizardStep === 2")
 changes += 1
 break
for i, l in enumerate(lines):
 if "{wizardStep === 4 && (" in l:
 nearby = "".join(lines[max(0,i):min(len(lines),i+8)])
 if "Order name" in nearby:
 lines[i] = l.replace("wizardStep === 4", "wizardStep === 3")
 changes += 1
 break
for i, l in enumerate(lines):
 if "{wizardStep === 5 && (" in l:
 lines[i] = l.replace("wizardStep === 5", "wizardStep === 4")
 changes += 1
 break
# CHANGE 14: Fix back buttons
for i, l in enumerate(lines):
 if "wizardStep === 1 && (" in l:
 nearby = "".join(lines[max(0,i):min(len(lines),i+15)])
 if "Get Name Servers" in nearby:
 j = i + 1
 while j < min(i + 30, len(lines)):
 if "setWizardStep(2)" in lines[j] and "Back" in lines[j]:
 lines[j] = lines[j].replace("setWizardStep(2)", "setWizardStep(0)")
 changes += 1
 break
 j += 1
 break
for i, l in enumerate(lines):
 if "wizardStep === 2 && (" in l:
 nearby = "".join(lines[max(0,i):min(len(lines),i+15)])
 if "redirect" in nearby.lower():
 j = i + 1
 while j < min(i + 30, len(lines)):
 if "setWizardStep(3)" in lines[j] and "Back" in lines[j]:
 lines[j] = lines[j].replace("setWizardStep(3)", "setWizardStep(1)")
 changes += 1
 break
 j += 1
 break
for i, l in enumerate(lines):
 if "wizardStep === 3 && (" in l:
 nearby = "".join(lines[max(0,i):min(len(lines),i+15)])
 if "Order name" in nearby:
 j = i + 1
 while j < min(i + 30, len(lines)):
 if "setWizardStep(4)" in lines[j] and "Back" in lines[j]:
 lines[j] = lines[j].replace("setWizardStep(4)", "setWizardStep(2)")
 changes += 1
 break
 j += 1
 break
for i, l in enumerate(lines):
 if "wizardStep === 4 && (" in l:
 if "canUseCustomNames" in "".join(lines[max(0,i):min(len(lines),i+15)]):
 j = i + 1
 while j < min(i + 30, len(lines)):
 if "setWizardStep(5)" in lines[j] and "Back" in lines[j]:
 lines[j] = lines[j].replace("setWizardStep(5)", "setWizardStep(3)")
 changes += 1
 break
 j += 1
 break
# CHANGE 15: Fix handler step destinations
for i, l in enumerate(lines):
 if "const handleCheckNameServers" in l:
 j = i + 1
 while j < min(i + 20, len(lines)):
 if "setWizardStep(3)" in lines[j]:
 lines[j] = lines[j].replace("setWizardStep(3)", "setWizardStep(2)")
 changes += 1
 j += 1
 break
for i, l in enumerate(lines):
 if "const handleRedirectStepNext" in l:
 j = i + 1
 while j < min(i + 25, len(lines)):
 if "setWizardStep(4)" in lines[j]:
 lines[j] = lines[j].replace("setWizardStep(4)", "setWizardStep(3)")
 changes += 1
 j += 1
 break
for i, l in enumerate(lines):
 if "const handleOrderDetailsNext" in l:
 j = i + 1
 while j < min(i + 20, len(lines)):
 if "setWizardStep(5)" in lines[j]:
 lines[j] = lines[j].replace("setWizardStep(5)", "setWizardStep(4)")
 changes += 1
 j += 1
 break
# CHANGE 16: MFA reset in resetWizard
for i, l in enumerate(lines):
 if "const resetWizard" in l and "=>" in l:
 j = i
 while j < min(i + 25, len(lines)):
 if "setTenantMfaSecret" in lines[j]:
 lines[j] = lines[j].rstrip().rstrip(';') + ';' + chr(10) + ' setMfaSecretTouched(false);' + chr(10) + ' setMfaSecretValid(true);' + chr(10)
 changes += 1
 break
 j += 1
 break
# Write output
with open(OUT, "w") as f:
 f.writelines(lines)
print(f"Done! {changes} changes applied, {len(lines)} lines written.")
content = "".join(lines)
checks = [
 ('stepTitles no consent', "'Microsoft consent'" not in content),
 ('handleOpenConsent removed', 'handleOpenConsent' not in content),
 ('handleCheckConsent removed', 'handleCheckConsent' not in content),
 ('validateMfaSecret added', 'validateMfaSecret' in content),
 ('mfaSecretTouched added', 'mfaSecretTouched' in content),
 ('MFA required label', 'MFA Secret (required)' in content),
 ("MFA placeholder", 'placeholder="MFA secret"' in content),
 ('no __EMPTY__', '__EMPTY__' not in content),
 ('no wizardStep 5', 'wizardStep === 5' not in content),
]
all_pass = True
for name, result in checks:
 status = "PASS" if result else "FAIL"
 if not result:
 all_pass = False
 print(f" {status}: {name}")
print(f'\nOverall: {"ALL PASS" if all_pass else "SOME FAILED"}')
