import repository from '../db/smtp.js';
import { FileSecretStore } from './fileSecretStore.js';
import { ResendService } from './resend.js';
import * as smtpDns from './smtpDns.js';
import { createMailInfrastructure } from './mailInfrastructure.js';
import { buildSmtpCsv } from './smtpCsv.js';

let runtime;
export function getSmtpRuntime() {
  if (!runtime) {
    const config = {
      publicHost: process.env.SMTP_PUBLIC_HOST,
      smtpPort: Number(process.env.SMTP_PORT || 465),
      imapPort: Number(process.env.IMAP_PORT || 993),
      outboundSpf: process.env.SMTP_OUTBOUND_SPF,
      managementUrl: process.env.SMTP_MANAGEMENT_URL,
      tokenSecretKey: process.env.SMTP_MANAGEMENT_TOKEN_REF,
    };
    const secretStore = new FileSecretStore(process.env.SMTP_SECRET_DIR);
    runtime = { repository, secretStore, config, dns: smtpDns, buildCsv: buildSmtpCsv,
      resendFactory: apiKey => new ResendService({ apiKey }),
      mailInfrastructure: createMailInfrastructure({ ...config, secretStore }),
    };
  }
  return runtime;
}
