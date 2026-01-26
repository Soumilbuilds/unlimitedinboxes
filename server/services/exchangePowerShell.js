import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const EXO_APP_ID = process.env.EXO_APP_ID || process.env.MASTER_CLIENT_ID;
const EXO_CERT_PFX_PATH = process.env.EXO_CERT_PFX_PATH;
const EXO_CERT_PASSWORD = process.env.EXO_CERT_PASSWORD;
const EXO_CERT_PFX_BASE64 = process.env.EXO_CERT_PFX_BASE64;

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
    if (line.startsWith('{') && line.endsWith('}')) {
      try {
        return JSON.parse(line);
      } catch {
        // keep searching
      }
    }
  }
  return null;
}

async function runPowerShell(script, envOverrides = {}) {
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
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', async (err) => {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      reject(err);
    });

    child.on('close', async (code) => {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
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
