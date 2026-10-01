#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { FileSecretStore } from '../../server/services/fileSecretStore.js';
import { StalwartMailboxProvider } from '../../server/services/stalwartMailboxProvider.js';

const DEFAULT_DOMAINS = ['taloperations.com', 'talcollectiveco.com'];
const DEFAULT_LOCAL_PARTS = ['stacy', 'amy', 'sam', 'jake', 'mia'];
const TOKEN_SECRET_KEY = 'stalwart:provisioning-api-key';

function unique(values) {
  return [...new Set(values)];
}

export function parseOptions(args) {
  const options = { domains: [], localParts: [], dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (flag === '--help') return { help: true };
    if (!['--base-url', '--secret-dir', '--domain', '--local'].includes(flag) || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new TypeError('Invalid arguments; use --help for usage');
    }
    const value = args[++index].trim();
    if (flag === '--base-url' || flag === '--secret-dir') {
      const key = flag === '--base-url' ? 'baseUrl' : 'secretDir';
      if (options[key]) throw new TypeError('Duplicate option');
      options[key] = value;
    } else if (flag === '--domain') {
      options.domains.push(value);
    } else {
      options.localParts.push(value);
    }
  }
  options.domains = unique((options.domains.length ? options.domains : DEFAULT_DOMAINS).map(value => {
    const domain = value.toLowerCase().replace(/\.$/, '');
    if (domain.length > 253 || !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) {
      throw new TypeError('Invalid domain');
    }
    return domain;
  }));
  options.localParts = unique((options.localParts.length ? options.localParts : DEFAULT_LOCAL_PARTS).map(value => {
    const local = value.toLowerCase();
    if (local.length > 64 || !/^[a-z0-9][a-z0-9._+-]*$/.test(local) || local.endsWith('.') || local.includes('..')) {
      throw new TypeError('Invalid local part');
    }
    return local;
  }));
  if (!options.dryRun && (!options.baseUrl || !options.secretDir)) {
    throw new TypeError('--base-url and --secret-dir are required');
  }
  return options;
}

export async function provision({ provider, domains, localParts, write }) {
  for (const domain of domains) {
    const result = await provider.ensureDomain(domain, { dkimManagement: 'Manual' });
    write(`Domain ${domain}: ${result.created ? 'Created' : 'Existing'}\n`);
    for (const local of localParts) {
      const email = `${local}@${domain}`;
      const mailbox = await provider.ensureMailbox(email);
      write(`Mailbox ${mailbox.email}: ${mailbox.created ? 'Created' : 'Existing'}\n`);
    }
  }
}

export async function main(args = process.argv.slice(2), write = text => process.stdout.write(text)) {
  const options = parseOptions(args);
  if (options.help) {
    write('Usage: node ops/stalwart/provision-mailboxes.mjs --base-url URL --secret-dir ABSOLUTE_PATH [--domain DOMAIN ...] [--local LOCAL_PART ...] [--dry-run]\n');
    write('Defaults: taloperations.com, talcollectiveco.com; stacy, amy, sam, jake, mia. --dry-run only lists addresses.\n');
    return;
  }
  if (options.dryRun) {
    for (const domain of options.domains) {
      for (const local of options.localParts) write(`${local}@${domain}\n`);
    }
    return;
  }
  const secretStore = new FileSecretStore(options.secretDir);
  const provider = new StalwartMailboxProvider({
    baseUrl: options.baseUrl,
    tokenSecretKey: TOKEN_SECRET_KEY,
    secretStore,
  });
  await provision({ provider, ...options, write });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    process.stderr.write('Provisioning failed. Check the selected account, Stalwart access, and protected secret store.\n');
    process.exitCode = 1;
  });
}
