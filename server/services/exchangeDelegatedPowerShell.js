import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildExchangeAlias } from './exchangePowerShell.js';
import { completeMicrosoftDeviceCodeFlow, createIncognitoPage } from './puppeteer.js';

const DEVICE_LOGIN_FALLBACK_URI = 'https://login.microsoft.com/device';
const RESPONSE_PREFIX = '__EXO_DELEGATED_RESPONSE__:';
const READY_MARKER = '__EXO_DELEGATED_READY__';

export function parseExchangeDeviceCode(text) {
  const source = String(text || '');
  const code = source.match(/\bcode\s+([A-Z0-9]{4,}(?:-[A-Z0-9]+)*)/i)?.[1];
  if (!code) return null;
  const verificationUri = source.match(/https?:\/\/[^\s]+\/(?:device|devicelogin)\b[^\s]*/i)?.[0]
    ?.replace(/[),.;]+$/, '') || DEVICE_LOGIN_FALLBACK_URI;
  return { userCode: code, verificationUri };
}

export function buildDelegatedExchangeSessionScript() {
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Import-Module ExchangeOnlineManagement -ErrorAction Stop

function Wait-DelegatedMailbox {
  param([string]$RequestedSmtp, [string]$ExchangeAlias, [int]$Attempts = 12)
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    foreach ($identity in @($RequestedSmtp, $ExchangeAlias)) {
      $mailbox = Get-EXOMailbox -Identity $identity -Properties ExternalDirectoryObjectId,PrimarySmtpAddress,EmailAddresses,Alias,DisplayName,RecipientTypeDetails -ErrorAction SilentlyContinue
      if (-not $mailbox -or [string]$mailbox.RecipientTypeDetails -ne 'SharedMailbox') { continue }
      $addresses = @($mailbox.EmailAddresses | ForEach-Object { ([string]$_).ToLowerInvariant() })
      $matchesAddress = $addresses -contains "smtp:$($RequestedSmtp.ToLowerInvariant())"
      $matchesAlias = ([string]$mailbox.Alias).ToLowerInvariant() -eq $ExchangeAlias.ToLowerInvariant()
      if (($matchesAddress -or $matchesAlias) -and $mailbox.ExternalDirectoryObjectId) { return $mailbox }
    }
    if ($attempt -lt $Attempts) { Start-Sleep -Seconds 5 }
  }
  return $null
}

function Ensure-DelegatedMailbox {
  param([object]$Request, [string]$Domain)
  $smtp = "$($Request.alias)@$Domain"
  $recipient = Get-Recipient -Identity $smtp -ErrorAction SilentlyContinue
  if ($recipient -and [string]$recipient.RecipientTypeDetails -ne 'SharedMailbox') {
    throw "The address $smtp is already used by another recipient"
  }

  $mailbox = Get-EXOMailbox -Identity $smtp -Properties ExternalDirectoryObjectId,PrimarySmtpAddress,EmailAddresses,Alias,DisplayName,RecipientTypeDetails -ErrorAction SilentlyContinue
  $created = $false
  if (-not $mailbox) {
    if ([string]::IsNullOrWhiteSpace([string]$Request.password)) {
      throw "A mailbox password is required for initial recipient creation"
    }
    $securePassword = ConvertTo-SecureString ([string]$Request.password) -AsPlainText -Force
    try {
      # Supplying the complete member identity avoids an Exchange Online
      # backend defect where the abbreviated Shared parameter set creates the
      # directory member but omits ExternalDirectoryObjectId in its response.
      New-Mailbox -Shared -Name $Request.exchangeAlias -DisplayName $Request.displayName -Alias $Request.exchangeAlias -UserPrincipalName $smtp -Password $securePassword -PrimarySmtpAddress $smtp -ErrorAction Stop | Out-Null
      $created = $true
    } catch {
      $creationError = [string]$_.Exception.Message
      # New-Mailbox can commit before returning a timeout or service error.
      $mailbox = Wait-DelegatedMailbox -RequestedSmtp $smtp -ExchangeAlias $Request.exchangeAlias -Attempts 4
      if (-not $mailbox) { throw $creationError }
      $created = $true
    }
    if (-not $mailbox) {
      $mailbox = Wait-DelegatedMailbox -RequestedSmtp $smtp -ExchangeAlias $Request.exchangeAlias
    }
  }
  if ($mailbox -and -not $mailbox.ExternalDirectoryObjectId) {
    $mailbox = Wait-DelegatedMailbox -RequestedSmtp $smtp -ExchangeAlias $Request.exchangeAlias
  }
  if (-not $mailbox) { throw "Mailbox $smtp was not visible after creation" }

  if (([string]$mailbox.PrimarySmtpAddress).ToLowerInvariant() -ne $smtp.ToLowerInvariant()) {
    Set-Mailbox -Identity $mailbox.ExternalDirectoryObjectId -PrimarySmtpAddress $smtp -ErrorAction Stop
    $mailbox = Wait-DelegatedMailbox -RequestedSmtp $smtp -ExchangeAlias $Request.exchangeAlias
  }
  if (-not $mailbox -or ([string]$mailbox.PrimarySmtpAddress).ToLowerInvariant() -ne $smtp.ToLowerInvariant()) {
    throw "Primary SMTP address for $smtp did not reconcile"
  }

  $cas = Get-CASMailbox -Identity $mailbox.ExternalDirectoryObjectId -ErrorAction Stop
  if ($cas.SmtpClientAuthenticationDisabled -ne $false) {
    Set-CASMailbox -Identity $mailbox.ExternalDirectoryObjectId -SmtpClientAuthenticationDisabled $false -ErrorAction Stop
  }
  $casAfter = Get-CASMailbox -Identity $mailbox.ExternalDirectoryObjectId -ErrorAction Stop
  if ($casAfter.SmtpClientAuthenticationDisabled -ne $false) {
    throw "Mailbox sending access did not reconcile for $smtp"
  }

  return [pscustomobject]@{
    Index = [int]$Request.index
    Success = $true
    Created = $created
    Email = [string]$mailbox.PrimarySmtpAddress
    DisplayName = [string]$mailbox.DisplayName
    ExternalDirectoryObjectId = [string]$mailbox.ExternalDirectoryObjectId
    Error = $null
  }
}

try {
  Connect-ExchangeOnline -Device -ShowBanner:$false -ErrorAction Stop
  [Console]::Out.WriteLine('${READY_MARKER}')
  [Console]::Out.Flush()

  while (($encodedCommand = [Console]::In.ReadLine()) -ne $null) {
    if ([string]::IsNullOrWhiteSpace($encodedCommand)) { continue }
    $command = $null
    try {
      $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedCommand))
      $command = $json | ConvertFrom-Json
      if ([string]$command.action -ne 'ensureMailboxes') {
        throw "Unsupported delegated Exchange action"
      }
      $results = @()
      foreach ($request in @($command.payload.mailboxes)) {
        try {
          $results += Ensure-DelegatedMailbox -Request $request -Domain ([string]$command.payload.domain)
        } catch {
          $results += [pscustomobject]@{
            Index = [int]$request.index
            Success = $false
            Created = $false
            Email = "$($request.alias)@$($command.payload.domain)"
            DisplayName = [string]$request.displayName
            ExternalDirectoryObjectId = $null
            Error = [string]$_.Exception.Message
          }
        }
      }
      $response = [pscustomobject]@{ Id = [int]$command.id; Success = $true; Data = @($results); Error = $null }
    } catch {
      $response = [pscustomobject]@{ Id = [int]$command.id; Success = $false; Data = $null; Error = [string]$_.Exception.Message }
    }
    $responseJson = $response | ConvertTo-Json -Compress -Depth 8
    $responseBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($responseJson))
    [Console]::Out.WriteLine('${RESPONSE_PREFIX}' + $responseBase64)
    [Console]::Out.Flush()
  }
} finally {
  Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue
}
`;
}

function normalizeBatchResults(data) {
  const results = Array.isArray(data) ? data : (data ? [data] : []);
  return results.map(result => ({
    index: Number(result.Index),
    success: Boolean(result.Success),
    created: Boolean(result.Created),
    email: result.Email || null,
    displayName: result.DisplayName || null,
    externalDirectoryObjectId: result.ExternalDirectoryObjectId || null,
    error: result.Error || null,
  }));
}

export async function createDelegatedExchangeSession({
  email,
  password,
  getTotpCode,
  mfaSecret,
  log = () => {},
  authenticationTimeoutMs = 5 * 60 * 1000,
}) {
  if (!email || !password) throw new Error('Microsoft administrator credentials are required');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exo-delegated-'));
  const scriptPath = path.join(tmpDir, 'session.ps1');
  await fs.writeFile(scriptPath, buildDelegatedExchangeSessionScript(), 'utf8');

  const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', scriptPath], {
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let requestId = 0;
  let output = '';
  let stderr = '';
  let ready = false;
  let deviceFlowStarted = false;
  let closed = false;
  let browserContext = null;
  let browserPage = null;
  let resolveReady;
  let rejectReady;
  const readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const failAll = error => {
    rejectReady(error);
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };

  const closeBrowser = async () => {
    if (browserPage && !browserPage.isClosed()) {
      try { await browserPage.close(); } catch { /* ignore */ }
    }
    if (browserContext) {
      try { await browserContext.close(); } catch { /* ignore */ }
    }
    browserPage = null;
    browserContext = null;
  };

  const handleDeviceFlow = async device => {
    try {
      log('Establishing an alternate secure Microsoft connection...');
      const browser = await createIncognitoPage();
      browserContext = browser.context;
      browserPage = browser.page;
      const result = await completeMicrosoftDeviceCodeFlow({
        page: browserPage,
        context: browserContext,
        verificationUri: device.verificationUri,
        userCode: device.userCode,
        email,
        password,
        getTotpCode,
        mfaSecret,
      });
      browserPage = result.page || browserPage;
      if (!result.success) throw new Error(result.error || 'Microsoft authorization did not complete');
    } catch (error) {
      failAll(error);
      child.kill('SIGKILL');
    }
  };

  const consumeOutput = () => {
    if (!deviceFlowStarted) {
      const device = parseExchangeDeviceCode(output);
      if (device) {
        deviceFlowStarted = true;
        void handleDeviceFlow(device);
      }
    }
    const lines = output.split(/\r?\n/);
    output = lines.pop() || '';
    for (const line of lines) {
      if (line.trim() === READY_MARKER) {
        ready = true;
        resolveReady();
        void closeBrowser();
        continue;
      }
      const markerIndex = line.indexOf(RESPONSE_PREFIX);
      if (markerIndex < 0) continue;
      try {
        const encoded = line.slice(markerIndex + RESPONSE_PREFIX.length).trim();
        const response = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
        const entry = pending.get(Number(response.Id));
        if (!entry) continue;
        pending.delete(Number(response.Id));
        if (response.Success) entry.resolve(response.Data);
        else entry.reject(new Error(response.Error || 'Delegated Exchange command failed'));
      } catch (error) {
        failAll(error);
      }
    }
  };

  child.stdout.on('data', chunk => {
    output += chunk.toString();
    consumeOutput();
  });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.on('error', failAll);
  child.on('close', code => {
    closed = true;
    void closeBrowser();
    void fs.rm(tmpDir, { recursive: true, force: true });
    if (code !== 0 || !ready) {
      failAll(new Error(stderr.trim() || `Delegated Exchange session exited with code ${code}`));
    } else {
      failAll(new Error('Delegated Exchange session closed'));
    }
  });

  const authTimer = setTimeout(() => {
    if (ready) return;
    failAll(new Error('Microsoft authorization timed out'));
    child.kill('SIGKILL');
  }, authenticationTimeoutMs);
  try {
    await readyPromise;
  } finally {
    clearTimeout(authTimer);
  }

  const send = (action, payload, timeoutMs = 15 * 60 * 1000) => new Promise((resolve, reject) => {
    if (closed || !ready) return reject(new Error('Delegated Exchange session is not available'));
    const id = ++requestId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Delegated Exchange mailbox command timed out'));
    }, timeoutMs);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    const encoded = Buffer.from(JSON.stringify({ id, action, payload }), 'utf8').toString('base64');
    child.stdin.write(`${encoded}\n`);
  });

  return {
    async ensureSharedMailboxes({ domain, mailboxes }) {
      if (!domain || !Array.isArray(mailboxes) || mailboxes.length < 1 || mailboxes.length > 10) {
        throw new Error('Delegated Exchange batch must contain between 1 and 10 recipients');
      }
      const prepared = mailboxes.map((mailbox, index) => ({
        index,
        displayName: String(mailbox?.displayName || '').trim(),
        alias: String(mailbox?.alias || '').trim(),
        exchangeAlias: buildExchangeAlias(mailbox?.alias, domain),
        password: String(mailbox?.password || ''),
      }));
      if (prepared.some(item => !item.displayName || !item.alias || !item.password)) {
        throw new Error('Delegated Exchange batch contains an invalid mailbox');
      }
      const data = await send('ensureMailboxes', { domain: String(domain), mailboxes: prepared });
      const results = normalizeBatchResults(data);
      if (results.length !== prepared.length) {
        throw new Error(`Microsoft returned ${results.length}/${prepared.length} mailbox results`);
      }
      return results;
    },
    async close() {
      if (closed) return;
      child.stdin.end();
      await new Promise(resolve => child.once('close', resolve));
    },
  };
}
