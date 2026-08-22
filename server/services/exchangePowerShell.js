import { spawn } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const EXO_APP_ID = process.env.EXO_APP_ID || process.env.MASTER_CLIENT_ID;
const EXO_CERT_PFX_PATH = process.env.EXO_CERT_PFX_PATH;
const EXO_CERT_PASSWORD = process.env.EXO_CERT_PASSWORD;
const EXO_CERT_PFX_BASE64 = process.env.EXO_CERT_PFX_BASE64;

// Exchange aliases are tenant-wide, even when the SMTP domains differ. Using
// the requested local part directly can therefore select or collide with a
// mailbox on another domain. Keep the customer-facing address unchanged while
// giving Exchange a deterministic, tenant-wide internal alias.
export function buildExchangeAlias(alias, domain) {
  const localPart = String(alias || '').trim().toLowerCase();
  const smtpDomain = String(domain || '').trim().toLowerCase();
  const prefix = localPart
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 46) || 'mailbox';
  const digest = createHash('sha256')
    .update(`${localPart}@${smtpDomain}`)
    .digest('hex')
    .slice(0, 12);
  return `${prefix}-${digest}`.slice(0, 64);
}

export function isExchangePowerShellConfigured() {
  return Boolean(
    EXO_APP_ID &&
    EXO_CERT_PASSWORD &&
    (EXO_CERT_PFX_PATH || EXO_CERT_PFX_BASE64)
  );
}

async function ensurePfxPath() {
  if (EXO_CERT_PFX_PATH) return EXO_CERT_PFX_PATH;
  if (!EXO_CERT_PFX_BASE64) return null;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exo-pfx-'));
  const pfxPath = path.join(tmpDir, 'exo.pfx');
  const buffer = Buffer.from(EXO_CERT_PFX_BASE64, 'base64');
  await fs.writeFile(pfxPath, buffer);
  return pfxPath;
}

function extractJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (
      (line.startsWith('{') && line.endsWith('}')) ||
      (line.startsWith('[') && line.endsWith(']'))
    ) {
      try {
        return JSON.parse(line);
      } catch {
        // keep searching
      }
    }
  }
  return null;
}

async function runPowerShell(script, envOverrides = {}, timeoutMs = 300000) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exo-ps-'));
  const scriptPath = path.join(tmpDir, 'script.ps1');
  await fs.writeFile(scriptPath, script, 'utf8');

  return new Promise((resolve, reject) => {
    const child = spawn(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-File', scriptPath],
      { env: { ...process.env, ...envOverrides } }
    );

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', async (err) => {
      clearTimeout(timeout);
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      reject(err);
    });

    child.on('close', async (code) => {
      clearTimeout(timeout);
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      if (timedOut) {
        return reject(new Error(`Exchange Online PowerShell command timed out after ${Math.round(timeoutMs / 60000)} minutes`));
      }
      if (code !== 0) {
        return reject(new Error(stderr || `PowerShell exited with code ${code}`));
      }
      resolve({ stdout, stderr });
    });
  });
}

function ensureConfig(orgDomain) {
  if (!EXO_APP_ID) throw new Error('Missing EXO_APP_ID (or MASTER_CLIENT_ID)');
  if (!EXO_CERT_PASSWORD) throw new Error('Missing EXO_CERT_PASSWORD');
  if (!orgDomain) throw new Error('Missing Exchange organization domain (onmicrosoft.com)');
}

async function baseEnv(orgDomain) {
  ensureConfig(orgDomain);
  const pfxPath = await ensurePfxPath();
  if (!pfxPath) throw new Error('Missing EXO_CERT_PFX_PATH or EXO_CERT_PFX_BASE64');
  return {
    EXO_APP_ID,
    EXO_CERT_PFX_PATH: pfxPath,
    EXO_CERT_PASSWORD,
    EXO_ORG: orgDomain
  };
}

const connectExchangeScript = `
Import-Module ExchangeOnlineManagement -ErrorAction Stop
$secure = ConvertTo-SecureString $env:EXO_CERT_PASSWORD -AsPlainText -Force
$connected = $false
$lastConnectionError = $null
for ($attempt = 1; $attempt -le 8; $attempt++) {
  try {
    Connect-ExchangeOnline -CertificateFilePath $env:EXO_CERT_PFX_PATH -CertificatePassword $secure -AppId $env:EXO_APP_ID -Organization $env:EXO_ORG -ShowBanner:$false -ErrorAction Stop
    $connected = $true
    break
  } catch {
    $lastConnectionError = $_
    if ($attempt -lt 8) { Start-Sleep -Seconds 10 }
  }
}
if (-not $connected) {
  throw "Exchange Online app-only connection failed after role propagation retries: $lastConnectionError"
}
`;

// New-Mailbox occasionally fails for a newly verified custom domain because
// Exchange's internal Graph lookup has not caught up with the domain yet. The
// mailbox may still have been created, so reconcile first. If it was not, make
// the backing object on the tenant's initial onmicrosoft.com domain and switch
// the primary SMTP address to the requested custom domain afterwards.
const resilientSharedMailboxScript = `
function Wait-SharedMailbox {
  param(
    [string]$ExchangeAlias,
    [string]$RequestedSmtp,
    [string]$InitialSmtp,
    [int]$Attempts = 12
  )
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    foreach ($identity in @($RequestedSmtp, $InitialSmtp, $ExchangeAlias)) {
      $found = Get-EXOMailbox -Identity $identity -Properties ExternalDirectoryObjectId,PrimarySmtpAddress,EmailAddresses,Alias,DisplayName,RecipientTypeDetails -ErrorAction SilentlyContinue
      if (-not $found -or [string]$found.RecipientTypeDetails -ne 'SharedMailbox') { continue }
      $addresses = @($found.EmailAddresses | ForEach-Object { ([string]$_).ToLowerInvariant() })
      $matchesAddress = $addresses -contains "smtp:$($RequestedSmtp.ToLowerInvariant())" -or $addresses -contains "smtp:$($InitialSmtp.ToLowerInvariant())"
      $matchesAlias = ([string]$found.Alias).ToLowerInvariant() -eq $ExchangeAlias.ToLowerInvariant()
      # Do not ever return a mailbox merely because it has the requested local
      # part. Aliases are tenant-wide and that could mutate another domain's
      # mailbox. The hashed ExchangeAlias is unique to the complete SMTP address.
      if (($matchesAddress -or $matchesAlias) -and $found.ExternalDirectoryObjectId) { return $found }
    }
    if ($attempt -lt $Attempts) { Start-Sleep -Seconds 5 }
  }
  return $null
}

function New-SharedMailboxResilient {
  param(
    [string]$DisplayName,
    [string]$ExchangeAlias,
    [string]$RequestedSmtp,
    [string]$Password
  )
  $initialSmtp = "$ExchangeAlias@$($env:EXO_ORG)"
  $securePassword = ConvertTo-SecureString $Password -AsPlainText -Force
  $firstCreateError = $null
  try {
    New-Mailbox -Shared -Name $ExchangeAlias -DisplayName $DisplayName -Alias $ExchangeAlias -UserPrincipalName $RequestedSmtp -Password $securePassword -PrimarySmtpAddress $RequestedSmtp -ErrorAction Stop | Out-Null
  } catch {
    $createError = [string]$_.Exception.Message
    $firstCreateError = $createError

    # A failed or timed-out request can commit before Exchange returns its
    # error. Reconcile every failure before deciding whether it is safe to retry.
    $mailbox = Wait-SharedMailbox -ExchangeAlias $ExchangeAlias -RequestedSmtp $RequestedSmtp -InitialSmtp $initialSmtp -Attempts 4
    if (-not $mailbox) {
      $isRetriableCreationError = (
        ($createError -match 'ExternalDirectoryObjectId' -and $createError -match 'Member Creation') -or
        $createError -match 'timed?\s*out|temporar|server busy|internal server|transient|throttl|TooManyRequests'
      )
      if (-not $isRetriableCreationError) { throw }
      try {
        New-Mailbox -Shared -Name $ExchangeAlias -DisplayName $DisplayName -Alias $ExchangeAlias -UserPrincipalName $initialSmtp -Password $securePassword -ErrorAction Stop | Out-Null
      } catch {
        # A timed-out/failed first request may materialize while the fallback is
        # submitted. Reconcile after any fallback error before declaring failure.
        $fallbackCreateError = [string]$_.Exception.Message
      }
    }
  }

  $mailbox = Wait-SharedMailbox -ExchangeAlias $ExchangeAlias -RequestedSmtp $RequestedSmtp -InitialSmtp $initialSmtp
  if (-not $mailbox) {
    $details = @($firstCreateError, $fallbackCreateError) | Where-Object { $_ }
    throw "Mailbox $RequestedSmtp was not visible after creation. $($details -join ' | ')"
  }
  return $mailbox
}

function Set-SharedMailboxPrimarySmtpResilient {
  param(
    [object]$Mailbox,
    [string]$ExchangeAlias,
    [string]$RequestedSmtp
  )
  if (([string]$Mailbox.PrimarySmtpAddress).ToLowerInvariant() -eq $RequestedSmtp.ToLowerInvariant()) {
    return $Mailbox
  }
  $lastSetError = $null
  for ($attempt = 1; $attempt -le 6; $attempt++) {
    try {
      $identity = if ($Mailbox.ExternalDirectoryObjectId) { [string]$Mailbox.ExternalDirectoryObjectId } else { $ExchangeAlias }
      Set-Mailbox -Identity $identity -PrimarySmtpAddress $RequestedSmtp -ErrorAction Stop
    } catch {
      $lastSetError = [string]$_.Exception.Message
    }
    $updated = Wait-SharedMailbox -ExchangeAlias $ExchangeAlias -RequestedSmtp $RequestedSmtp -InitialSmtp "$ExchangeAlias@$($env:EXO_ORG)" -Attempts 2
    if ($updated -and ([string]$updated.PrimarySmtpAddress).ToLowerInvariant() -eq $RequestedSmtp.ToLowerInvariant()) {
      return $updated
    }
    if ($attempt -lt 6) { Start-Sleep -Seconds 5 }
  }
  throw "Primary SMTP address for $RequestedSmtp did not reconcile. $lastSetError"
}
`;

export async function testExchangeOnlineConnection(orgDomain) {
  const env = await baseEnv(orgDomain);
  const script = `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
${connectExchangeScript}
try {
  $accepted = @(Get-AcceptedDomain -ErrorAction Stop)
  [pscustomobject]@{
    Connected = $true
    AcceptedDomainCount = $accepted.Count
  } | ConvertTo-Json -Compress
} finally {
  Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue
}
`;
  const { stdout } = await runPowerShell(script, env);
  const json = extractJson(stdout);
  if (!json?.Connected) {
    throw new Error('Exchange Online connection check did not return a success result');
  }
  return json;
}

export async function ensureOrganizationSmtpAuthEnabled(orgDomain) {
  const env = await baseEnv(orgDomain);
  const script = `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
${connectExchangeScript}
try {
  $before = Get-TransportConfig -ErrorAction Stop
  $changed = [bool]$before.SmtpClientAuthenticationDisabled
  if ($changed) {
    Set-TransportConfig -SmtpClientAuthenticationDisabled $false -ErrorAction Stop
  }
  $after = Get-TransportConfig -ErrorAction Stop
  [pscustomobject]@{
    Changed = $changed
    SmtpClientAuthenticationDisabled = [bool]$after.SmtpClientAuthenticationDisabled
  } | ConvertTo-Json -Compress
} finally {
  Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue
}
`;
  const { stdout } = await runPowerShell(script, env);
  const json = extractJson(stdout);
  if (!json || json.SmtpClientAuthenticationDisabled) {
    throw new Error('Exchange Online still reports organization SMTP AUTH as disabled');
  }
  return json;
}

export async function ensureSharedMailbox({
  orgDomain,
  displayName,
  alias,
  domain,
  password
}) {
  if (!displayName || !alias || !domain || !password) {
    throw new Error('Mailbox display name, alias, domain, and password are required');
  }
  const env = {
    ...(await baseEnv(orgDomain)),
    EXO_MAILBOX_DISPLAY_NAME: String(displayName),
    EXO_MAILBOX_ALIAS: String(alias),
    EXO_MAILBOX_EXCHANGE_ALIAS: buildExchangeAlias(alias, domain),
    EXO_MAILBOX_DOMAIN: String(domain),
    EXO_MAILBOX_PASSWORD: String(password)
  };
  const script = `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
${connectExchangeScript}
${resilientSharedMailboxScript}
try {
  $displayName = $env:EXO_MAILBOX_DISPLAY_NAME
  $alias = $env:EXO_MAILBOX_ALIAS
  $exchangeAlias = $env:EXO_MAILBOX_EXCHANGE_ALIAS
  $domain = $env:EXO_MAILBOX_DOMAIN
  $password = $env:EXO_MAILBOX_PASSWORD
  $smtp = "$alias@$domain"
  $recipient = Get-Recipient -Identity $smtp -ErrorAction SilentlyContinue
  if ($recipient -and [string]$recipient.RecipientTypeDetails -ne "SharedMailbox") {
    throw "The address $smtp is already used by a non-shared recipient ($($recipient.RecipientTypeDetails))"
  }
  $mailbox = Get-EXOMailbox -Identity $smtp -Properties ExternalDirectoryObjectId,PrimarySmtpAddress,DisplayName,RecipientTypeDetails -ErrorAction SilentlyContinue
  $created = $false
  if (-not $mailbox) {
    $mailbox = New-SharedMailboxResilient -DisplayName $displayName -ExchangeAlias $exchangeAlias -RequestedSmtp $smtp -Password $password
    $created = $true
  }
  if ($mailbox -and -not $mailbox.ExternalDirectoryObjectId) {
    $mailbox = Wait-SharedMailbox -ExchangeAlias $exchangeAlias -RequestedSmtp $smtp -InitialSmtp "$exchangeAlias@$($env:EXO_ORG)"
  }
  if (-not $mailbox) {
    throw "Shared mailbox $smtp was not visible after creation"
  }
  if (([string]$mailbox.PrimarySmtpAddress).ToLowerInvariant() -ne $smtp.ToLowerInvariant()) {
    $mailbox = Set-SharedMailboxPrimarySmtpResilient -Mailbox $mailbox -ExchangeAlias $exchangeAlias -RequestedSmtp $smtp
  }
  if (([string]$mailbox.PrimarySmtpAddress).ToLowerInvariant() -ne $smtp.ToLowerInvariant()) {
    throw "Primary SMTP address for $smtp did not reconcile"
  }
  $cas = Get-CASMailbox -Identity $smtp -ErrorAction Stop
  if ($cas.SmtpClientAuthenticationDisabled -ne $false) {
    Set-CASMailbox -Identity $smtp -SmtpClientAuthenticationDisabled $false -ErrorAction Stop
  }
  $casAfter = Get-CASMailbox -Identity $smtp -ErrorAction Stop
  if ($casAfter.SmtpClientAuthenticationDisabled -ne $false) {
    throw "SMTP AUTH remains disabled for shared mailbox $smtp"
  }
  [pscustomobject]@{
    Success = $true
    Created = $created
    Email = [string]$mailbox.PrimarySmtpAddress
    DisplayName = [string]$mailbox.DisplayName
    ExternalDirectoryObjectId = [string]$mailbox.ExternalDirectoryObjectId
  } | ConvertTo-Json -Compress
} finally {
  Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue
}
`;
  const { stdout } = await runPowerShell(script, env);
  const json = extractJson(stdout);
  if (!json?.Success || !json.Email) {
    throw new Error('Exchange Online did not return the shared mailbox after creation');
  }
  return {
    success: true,
    created: Boolean(json.Created),
    email: json.Email,
    displayName: json.DisplayName,
    externalDirectoryObjectId: json.ExternalDirectoryObjectId || null
  };
}

export async function ensureSharedMailboxes({
  orgDomain,
  domain,
  mailboxes
}) {
  if (!domain || !Array.isArray(mailboxes) || mailboxes.length < 1 || mailboxes.length > 10) {
    throw new Error('Exchange mailbox batch must contain between 1 and 10 recipients');
  }
  const requests = mailboxes.map((mailbox, index) => {
    const displayName = String(mailbox?.displayName || '').trim();
    const alias = String(mailbox?.alias || '').trim();
    const password = String(mailbox?.password || '');
    if (!displayName || !alias || !password) {
      throw new Error(`Exchange mailbox batch item ${index + 1} is missing a display name, alias, or password`);
    }
    return { index, displayName, alias, password, exchangeAlias: buildExchangeAlias(alias, domain) };
  });
  const requestedAddresses = requests.map(request => `${request.alias}@${domain}`.toLowerCase());
  if (new Set(requestedAddresses).size !== requestedAddresses.length) {
    throw new Error('Exchange mailbox batch contains duplicate recipient addresses');
  }
  const env = {
    ...(await baseEnv(orgDomain)),
    EXO_MAILBOX_DOMAIN: String(domain),
    EXO_MAILBOX_BATCH_BASE64: Buffer.from(JSON.stringify(requests), 'utf8').toString('base64')
  };
  const script = `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
${connectExchangeScript}
${resilientSharedMailboxScript}
try {
  $domain = $env:EXO_MAILBOX_DOMAIN
  $batchJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:EXO_MAILBOX_BATCH_BASE64))
  $requests = @($batchJson | ConvertFrom-Json)
  $results = @()
  foreach ($request in $requests) {
    $displayName = [string]$request.displayName
    $alias = [string]$request.alias
    $exchangeAlias = [string]$request.exchangeAlias
    $password = [string]$request.password
    $smtp = "$alias@$domain"
    try {
      $recipient = Get-Recipient -Identity $smtp -ErrorAction SilentlyContinue
      if ($recipient -and [string]$recipient.RecipientTypeDetails -ne "SharedMailbox") {
        throw "The address $smtp is already used by a non-shared recipient ($($recipient.RecipientTypeDetails))"
      }
      $mailbox = Get-EXOMailbox -Identity $smtp -Properties ExternalDirectoryObjectId,PrimarySmtpAddress,DisplayName,RecipientTypeDetails -ErrorAction SilentlyContinue
      $created = $false
      if (-not $mailbox) {
        $mailbox = New-SharedMailboxResilient -DisplayName $displayName -ExchangeAlias $exchangeAlias -RequestedSmtp $smtp -Password $password
        $created = $true
      }
      if ($mailbox -and -not $mailbox.ExternalDirectoryObjectId) {
        $mailbox = Wait-SharedMailbox -ExchangeAlias $exchangeAlias -RequestedSmtp $smtp -InitialSmtp "$exchangeAlias@$($env:EXO_ORG)"
      }
      if (-not $mailbox) {
        throw "Shared mailbox $smtp was not visible after creation"
      }
      if (([string]$mailbox.PrimarySmtpAddress).ToLowerInvariant() -ne $smtp.ToLowerInvariant()) {
        $mailbox = Set-SharedMailboxPrimarySmtpResilient -Mailbox $mailbox -ExchangeAlias $exchangeAlias -RequestedSmtp $smtp
      }
      if (([string]$mailbox.PrimarySmtpAddress).ToLowerInvariant() -ne $smtp.ToLowerInvariant()) {
        throw "Primary SMTP address for $smtp did not reconcile"
      }
      $cas = Get-CASMailbox -Identity $smtp -ErrorAction Stop
      if ($cas.SmtpClientAuthenticationDisabled -ne $false) {
        Set-CASMailbox -Identity $smtp -SmtpClientAuthenticationDisabled $false -ErrorAction Stop
      }
      $casAfter = Get-CASMailbox -Identity $smtp -ErrorAction Stop
      if ($casAfter.SmtpClientAuthenticationDisabled -ne $false) {
        throw "SMTP AUTH remains disabled for shared mailbox $smtp"
      }
      $results += [pscustomobject]@{
        Index = [int]$request.index
        Success = $true
        Created = $created
        Email = [string]$mailbox.PrimarySmtpAddress
        DisplayName = [string]$mailbox.DisplayName
        ExternalDirectoryObjectId = [string]$mailbox.ExternalDirectoryObjectId
        Error = $null
      }
    } catch {
      $results += [pscustomobject]@{
        Index = [int]$request.index
        Success = $false
        Created = $false
        Email = $smtp
        DisplayName = $displayName
        ExternalDirectoryObjectId = $null
        Error = [string]$_.Exception.Message
      }
    }
  }
  ConvertTo-Json -InputObject @($results) -Compress -Depth 4
} finally {
  Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue
}
`;
  const { stdout } = await runPowerShell(script, env, 15 * 60 * 1000);
  const parsed = extractJson(stdout);
  const results = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  if (results.length !== requests.length) {
    throw new Error(`Exchange Online returned ${results.length}/${requests.length} mailbox batch results`);
  }
  return results.map(result => ({
    index: Number(result.Index),
    success: Boolean(result.Success),
    created: Boolean(result.Created),
    email: result.Email || null,
    displayName: result.DisplayName || null,
    externalDirectoryObjectId: result.ExternalDirectoryObjectId || null,
    error: result.Error || null
  }));
}

export async function getDkimSelectors(domain, orgDomain) {
  const env = await baseEnv(orgDomain);
  const script = `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Import-Module ExchangeOnlineManagement -ErrorAction Stop
$secure = ConvertTo-SecureString $env:EXO_CERT_PASSWORD -AsPlainText -Force
Connect-ExchangeOnline -CertificateFilePath $env:EXO_CERT_PFX_PATH -CertificatePassword $secure -AppId $env:EXO_APP_ID -Organization $env:EXO_ORG -ShowBanner:$false
$cfg = Get-DkimSigningConfig -Identity "${domain}" -ErrorAction SilentlyContinue
if (-not $cfg) {
  New-DkimSigningConfig -DomainName "${domain}" -Enabled:$false | Out-Null
  $cfg = Get-DkimSigningConfig -Identity "${domain}"
}
$result = [pscustomobject]@{
  Selector1CNAME = $cfg.Selector1CNAME
  Selector2CNAME = $cfg.Selector2CNAME
  Enabled = $cfg.Enabled
}
$result | ConvertTo-Json -Compress
Disconnect-ExchangeOnline -Confirm:$false
`;

  const { stdout } = await runPowerShell(script, env);
  const json = extractJson(stdout);
  if (!json?.Selector1CNAME || !json?.Selector2CNAME) {
    throw new Error('Failed to read DKIM selectors from Exchange Online');
  }
  return json;
}

export async function enableDkim(domain, orgDomain) {
  const env = await baseEnv(orgDomain);
  const script = `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Import-Module ExchangeOnlineManagement -ErrorAction Stop
$secure = ConvertTo-SecureString $env:EXO_CERT_PASSWORD -AsPlainText -Force
Connect-ExchangeOnline -CertificateFilePath $env:EXO_CERT_PFX_PATH -CertificatePassword $secure -AppId $env:EXO_APP_ID -Organization $env:EXO_ORG -ShowBanner:$false
Set-DkimSigningConfig -Identity "${domain}" -Enabled:$true | Out-Null
$cfg = Get-DkimSigningConfig -Identity "${domain}"
$result = [pscustomobject]@{
  Enabled = $cfg.Enabled
}
$result | ConvertTo-Json -Compress
Disconnect-ExchangeOnline -Confirm:$false
`;

  const { stdout } = await runPowerShell(script, env);
  const json = extractJson(stdout);
  return json || { Enabled: true };
}
