# Stalwart Infrastructure And Operations

Last updated: 2026-10-01. Stalwart v0.16.24 serves `igoutbound.com`, `taloperations.com`, and `talcollectiveco.com` on `62.171.150.14`. The original five `igoutbound.com` mailboxes remain; ten new mailboxes were provisioned across the two new domains. Public SMTP 25, authenticated SMTP submission 465, and IMAPS 993 are available. The `igoutbound.com` authoritative MX now consistently points to `10 mail.igoutbound.com`.

## Current Deployment

| Component | Live fact or current state |
| --- | --- |
| Host | Ubuntu 24.04 VPS at `62.171.150.14`; 4 CPUs, 7.8 GB RAM, 145 GB disk. The app and mail service share this host and its failure domain. |
| Container runtime | Docker 29.1.3 and Docker Compose 2.40.3. |
| Mail service | Stalwart v0.16.24 runs as the `stalwart` Compose service under `/opt/stalwart`. `/opt/stalwart/config` binds to `/etc/stalwart`, and `/opt/stalwart/data` binds to `/var/lib/stalwart`. `/opt/stalwart/secrets` and `/opt/stalwart/backups` are host directories; they are not additional container mounts in the checked-in Compose file. |
| Current Compose exposure | Public TCP 25, 465, and 993 are reachable on the live host. An extra loopback IMAPS mapping remains at `127.0.0.1:1993:993`; administration remains loopback at `127.0.0.1:18080:8080` and `127.0.0.1:10443:443`. The checked-in [ops/stalwart/compose.yaml](../ops/stalwart/compose.yaml) still lists only public 25 and 993; it does not reflect the live 465 exposure. |
| Validation | The `igoutbound.com` domain and its five requested mailboxes remain. Local SMTP delivery and unauthenticated foreign-relay rejection passed. Gmail delivered a message from `soumil2406@gmail.com` to Stacy at `2026-10-01T02:43:37Z`; the message is in INBOX and its body is readable. An external client validated TLS, logged in to all five original mailboxes, and selected each INBOX. For the ten new accounts, SMTP 465 and IMAP 993 authentication passed for every account; cross-domain spoofing and unauthenticated relay were rejected. Authenticated local test messages to Stacy at each new domain and at `igoutbound.com` landed in INBOX. No external messages were sent for the new domains. See the [local smoke test](../ops/stalwart/local_smoke.py) for the original deployment checks. |
| Existing web traffic | Caddy already serves the application and MCP endpoints. The app and MCP are healthy. The checked-in [Caddyfile](../deploy/Caddyfile) covers app/API/MCP HTTP reverse proxies; it is not a mail proxy configuration. The app currently also listens publicly on port 3000 despite the older runbook saying loopback; this Stalwart work did not alter it. |
| Host firewall | UFW is inactive and the observed iptables INPUT policy is ACCEPT. Public 25 is intentional for inbound mail. Avoid enabling a host firewall without first protecting SSH and the existing app paths. |
| DNS and TLS | `mail.igoutbound.com` resolves publicly to `62.171.150.14` and is the TLS mail host for all three domains. The `igoutbound.com` authoritative MX is consistently `10 mail.igoutbound.com`, and external Gmail inbound delivery passed. Both new domains have MX `10 mail.igoutbound.com`, SPF `v=spf1 ip4:62.171.150.14 ~all`, and DMARC `p=none`. Their public `sw202610` DKIM records are **not published yet**. Caddy issued a Let's Encrypt certificate for `mail.igoutbound.com` (issuer `YE2`, valid 2026-10-01 through 2026-12-30 UTC). Stalwart serves it on IMAPS and SMTP STARTTLS; external OpenSSL returned `Verify return code: 0 (ok)`. |

The application deploy path in [DEPLOYMENT_RUNBOOK.md](../DEPLOYMENT_RUNBOOK.md) and [scripts/deploy_github.sh](../scripts/deploy_github.sh) is separate from `/opt/stalwart`. Its app SQLite backup and release-symlink rollback do **not** back up or roll back Stalwart.

## Mail Flow And Port Boundary

```text
Inbound SMTP:         Internet --TCP 25 ------------> Stalwart
SMTP submission:      authenticated clients --TLS 465--> Stalwart (tested)
IMAP:                 public IMAPS 993 -------------> Stalwart
Local IMAP testing:   host loopback 1993 -----------> Stalwart IMAPS 993
Inbound MX:           all three domains ------------> mail.igoutbound.com
Manyreach setup:      Stacy uses Resend SMTP; existing export uses Resend SMTP + Stalwart IMAP
Web app and MCP:      Internet --HTTPS--> existing Caddy --> app / MCP
Administration:       operator/local access --> loopback Stalwart admin ports
```

Stalwart receives inbound mail, serves IMAP, and accepts authenticated SMTP submission over public port 465. Submission authentication and local delivery have been tested for all ten new accounts. Existing Manyreach Stacy remains connected to Resend SMTP. The [Manyreach sender export helper](../server/services/manyreachSenderExport.js) still uses Resend SMTP and Stalwart IMAP; no Manyreach configuration or warmup was changed, and the new domains have not been switched to Stalwart SMTP in Manyreach. [Manyreach's sender guide](https://help.manyreach.com/en/articles/119-senders-and-mailboxes-setup-and-troubleshooting-guide) says both SMTP and IMAP are needed. [Resend's SMTP guide](https://resend.com/docs/send-with-smtp) lists `smtp.resend.com`, username `resend`, an API key as the password, and TLS-capable ports including 465 and 587. The helper's `smtp.resend.com:465` destination and Stalwart's public 465 listener are separate endpoints.

Keep the Stalwart management endpoints on loopback or a private administrative path. Public TCP 25, 465, and 993 are reachable; Caddy provides the certificate but does not proxy SMTP or IMAP. The isolated Caddy mail hostname returns HTTP 404 for `/jmap/`, so the management API is not published. Manyreach onboarding for these new domains remains untested.

## DNS And TLS Status

**Historical DNS issue, resolved:** during the original `igoutbound.com` MX change, some resolver and Hostinger authoritative answers still showed the old SES MX. The authoritative MX later became consistent at `10 mail.igoutbound.com.`, and external Gmail delivery to Stacy passed. No Resend return-path record was changed by this work.

| Stage | Type | Name | Value | Priority |
| --- | --- | --- | --- | --- |
| Completed | A | `mail.igoutbound.com` | `62.171.150.14` | — |
| Current; authoritative answers consistent | MX | `igoutbound.com` | `mail.igoutbound.com` | `10` |
| Current | MX | `taloperations.com` | `mail.igoutbound.com` | `10` |
| Current | TXT | `taloperations.com` | `v=spf1 ip4:62.171.150.14 ~all` | — |
| Current | TXT | `_dmarc.taloperations.com` | `v=DMARC1; p=none;` | — |
| Current | MX | `talcollectiveco.com` | `mail.igoutbound.com` | `10` |
| Current | TXT | `talcollectiveco.com` | `v=spf1 ip4:62.171.150.14 ~all` | — |
| Current | TXT | `_dmarc.talcollectiveco.com` | `v=DMARC1; p=none;` | — |
| **Not published; user action required** | TXT | `sw202610._domainkey.taloperations.com` | Public DKIM key from the matching private key | — |
| **Not published; user action required** | TXT | `sw202610._domainkey.talcollectiveco.com` | Public DKIM key from the matching private key | — |

The former apex MX was `10 inbound-smtp.us-east-1.amazonaws.com.`. Preserve Resend DKIM, SPF/return-path, and DMARC records. Do not create an AAAA record for the mail host until IPv6 is ready.

The new domains' DKIM key locations, signing configuration, and outstanding publication step are recorded under [New Domain Provisioning](#new-domain-provisioning). No external DKIM result or external sending result has been established for these domains.

Current TLS operations: the isolated [Caddy mail block](../ops/stalwart/Caddyfile.mail) is appended to `/etc/caddy/Caddyfile`; a pre-change copy is in `/opt/stalwart/backups`. [sync_caddy_certificate.py](../ops/stalwart/sync_caddy_certificate.py) verifies the certificate and matching key, copies them into `/opt/stalwart/config/tls` as mode 600 under container UID 2000, creates or updates Stalwart's Certificate object, and hot reloads TLS. The [systemd service](../ops/stalwart/stalwart-certificate.service) and [hourly timer](../ops/stalwart/stalwart-certificate.timer) are installed and active. A repeat sync reported the certificate unchanged; the systemd service result was `success`. [Stalwart's Caddy guide](https://stalw.art/docs/server/reverse-proxy/caddy/) documents this pattern.

Next sequence:

1. Publish the matching `sw202610` public DKIM TXT record for each new domain, then verify DNS publication and external authentication with a controlled external send. No such external send has occurred yet.
2. Keep the current Manyreach setup and warmup unchanged. Before connecting new-domain senders, test the chosen SMTP endpoint and Stalwart IMAP with one sender, then verify a real reply.

These are read-only checks; run them from the host or an external probe as appropriate:

```bash
cd /opt/stalwart
docker compose ps
ss -lntp
dig +short A mail.igoutbound.com
dig +short MX igoutbound.com
dig +short MX taloperations.com
dig +short MX talcollectiveco.com
dig +short TXT sw202610._domainkey.taloperations.com
dig +short TXT sw202610._domainkey.talcollectiveco.com
openssl s_client -connect mail.igoutbound.com:993 -servername mail.igoutbound.com
openssl s_client -connect mail.igoutbound.com:465 -servername mail.igoutbound.com
openssl s_client -starttls smtp -connect mail.igoutbound.com:25 -servername mail.igoutbound.com
```

The `igoutbound.com` authoritative MX is consistent at `10 mail.igoutbound.com`; the earlier disagreement is historical. Both new-domain MX records point to the same host. No separate return-path MX change is part of this cutover.

## New Domain Provisioning

The ten new accounts were created with [ops/stalwart/provision-mailboxes.mjs](../ops/stalwart/provision-mailboxes.mjs), using [StalwartMailboxProvider](../server/services/stalwartMailboxProvider.js) and [FileSecretStore](../server/services/fileSecretStore.js) with protected `/opt/stalwart/secrets/values`. A persistent script copy is at `/opt/stalwart/automation`. Run it on the VPS with its default two domains and five local parts:

```bash
node /opt/stalwart/automation/ops/stalwart/provision-mailboxes.mjs --base-url http://127.0.0.1:18080 --secret-dir /opt/stalwart/secrets/values
```

The script is idempotent: it ensures each domain and mailbox, reports existing objects on repeat runs, and reuses stored credentials without rotating them. It uses the private loopback management API; domain creation requests manual DNS and certificate management. The original five `igoutbound.com` accounts remain, and the application is not wired to Stalwart for customer orders. [Stalwart management documentation](https://stalw.art/docs/management/) describes the API model.

| Domain | Provisioned Mailboxes |
| --- | --- |
| `taloperations.com` | `stacy@taloperations.com`, `amy@taloperations.com`, `sam@taloperations.com`, `jake@taloperations.com`, `mia@taloperations.com` |
| `talcollectiveco.com` | `stacy@talcollectiveco.com`, `amy@talcollectiveco.com`, `sam@talcollectiveco.com`, `jake@talcollectiveco.com`, `mia@talcollectiveco.com` |

Each new domain uses MX at its apex, SPF TXT at its apex, DMARC TXT at `_dmarc.<domain>`, and public DKIM TXT at `sw202610._domainkey.<domain>`. The MX, SPF, and DMARC values are in the [DNS table](#dns-and-tls-status). The public DKIM records are **not published**; the user must publish the matching keys separately. The separate active RSA 2048 private keys are `/opt/stalwart/config/private/dkim-sw202610-taloperations-rsa.pem` and `/opt/stalwart/config/private/dkim-sw202610-talcollectiveco-rsa.pem`, both mode `0600`. Existing `SenderAuth` `dkimSignDomain` signs authenticated local domains. No public key values are stored in this document.

Every new account passed SMTP authentication on 465 and IMAP authentication on 993. Cross-domain spoofing and unauthenticated relay were rejected. Authenticated local delivery to `stacy@taloperations.com`, `stacy@talcollectiveco.com`, and the existing `igoutbound.com` Stacy reached INBOX. These checks do not establish external delivery or DKIM acceptance for the new domains; no external messages were sent for them.

## Manyreach Integration

The repository's [Manyreach sender export helper](../server/services/manyreachSenderExport.js) currently produces Resend SMTP credentials (`smtp.resend.com:465`, username `resend`, and a Resend API key from the secret store) and Stalwart IMAP credentials (mail host/port, mailbox address, and mailbox password). It can build a payload or write a restricted `.credentials.csv` file; it makes no Manyreach API call. Keep the Resend API key and mailbox password out of logs, and treat any CSV as a short-lived secret-bearing artifact. Existing Manyreach Stacy remains connected to Resend SMTP. Manyreach configuration and warmup remain unchanged; onboarding the new domains in Manyreach remains untested. The older [Microsoft OAuth importer](../scripts/MANYREACH_MICROSOFT_IMPORT.md) is unrelated to this flow.

For each sender eventually connected to Manyreach, record a stable mailbox email and Manyreach sender ID, confirm the chosen SMTP service is ready for that domain, connect one pilot sender, verify both SMTP and IMAP status, send a test message, and confirm its reply arrives in Stalwart and is visible to Manyreach. Only then import further senders in bounded batches. Stalwart SMTP 465 authentication and local delivery do not prove external delivery, DKIM acceptance, or Manyreach connectivity. Rotate sending and mailbox credentials as appropriate and retest both connections.

## Operations On This VPS

Run Stalwart maintenance from `/opt/stalwart`, not from the app release directory. Use `docker compose ps` to see service and host port mappings, `docker compose logs --tail=100` for recent container events, `ss -lntp` for listeners, and `df -h`/`df -i` for capacity. Do not publish log excerpts containing credentials or mail content. Track CPU, memory, disk and inode pressure because the mail store shares a 4-CPU/7.8-GB/145-GB VPS with the healthy app and MCP. Watch container restarts, SMTP accept failures, IMAP auth failures, queue age, certificate expiry, and successful backup age. An app `/api/health` response does not prove mail delivery.

Pin the Stalwart image at v0.16.24 until an upgrade and rollback plan is tested. Record the Compose file, image digest, bind-mount map, listener configuration, and TLS/certificate source in the operations inventory. Verify the bind-mounted host directories have the ownership required by the container user; Stalwart's [Docker guide](https://stalw.art/docs/install/platform/docker/) explains its persistent config/data mounts and bind-mount ownership. Caddy and the app should continue to be checked separately.

## Backup, Restore, And Rollback

`/opt/stalwart/backups` exists, and [ops/stalwart/backup.sh](../ops/stalwart/backup.sh) is a **manual quiesced backup script that has not been run**. It requires `--quiesce`, stops the `stalwart` Compose service, archives `compose.yaml`, `config`, `data`, and `secrets`, writes a SHA-256 checksum, restarts the service, and waits for container health. Running it would briefly interrupt public SMTP 25, submission 465, and IMAPS 993. Do not describe the presence of this script or directory as an existing backup, schedule, offsite copy, or restore test. The app deploy script's SQLite copy remains separate. Keep an encrypted copy of any verified archive outside this VPS; same-disk copies do not cover host loss. Stalwart's [storage overview](https://stalw.art/docs/storage/) explains why metadata and blobs both matter.

For the first backup, plan a brief maintenance window or implement and test a backend-supported coordinated snapshot that avoids service stoppage. The current script is the **outage-causing** option and remains unrun. After a backup is taken, verify its checksum and restore it to an isolated host with Stalwart v0.16.24; check domain/account inventory and sample mail before calling it recoverable. Do not substitute a live copy of embedded-store files for a verified backup. Stalwart's [Vandelay account archives](https://stalw.art/docs/migration/import-export/backup/) may supplement this but do not include surrounding server configuration; check availability in v0.16.24 before relying on them.

Restore procedure for an approved maintenance window: verify the archive against its `.sha256`, stop the Stalwart Compose service, extract the archive into a fresh isolated directory while preserving numeric ownership and permissions, inspect its `compose.yaml` and mount paths, then replace only `/opt/stalwart/{compose.yaml,config,data,secrets}` after keeping the current versions for rollback. Start the pinned image with `docker compose up -d`; check container health, account/domain inventory, IMAP login, and a local SMTP delivery before reopening inbound traffic. Never extract an unverified archive over the live mounts while Stalwart runs. Keep the app deployment and database out of this restore.

For disaster recovery, freeze new mailbox creation, select a verified backup, restore config/data/secrets to a clean host with the pinned image, and test locally before changing DNS. If the IP changes, update the mail-host A/PTR and then the inbound MX only as required. Reconcile accounts created since the backup and mail delivered during the outage. For a failed Stalwart upgrade, restore the matching image **and** a compatible store backup if the upgrade changed storage format; a `docker compose` image rollback alone may not reverse a migration. For a failed inbound MX cutover, return the recorded prior **inbound** MX while keeping Resend return-path records intact, and account for mail delivered to both receivers during DNS propagation. App release rollback does not touch Stalwart or Manyreach.

## Pending Work, In Order

1. Publish the matching `sw202610` DKIM TXT record for each new domain and verify public DNS. Then perform a controlled external sending and authentication test; none has been sent for the new domains yet.
2. Keep existing Manyreach Stacy on Resend SMTP and leave warmup unchanged. Before onboarding new-domain senders, test one sender's SMTP and Stalwart IMAP connections and confirm a real reply.
3. Arrange an interruption window for the **unrun** manual `backup.sh --quiesce`, or replace it with a tested non-disruptive snapshot. Verify the resulting archive and isolated restore, then copy it off-host.

## Sources

- Original host, runtime, deployment, TLS, and health facts: verified on the VPS and from an external client on 2026-10-01. The user supplied the DNS changes; new-domain provisioning, DKIM configuration, and local validation were verified on the VPS.
- Repository: [deployment runbook](../DEPLOYMENT_RUNBOOK.md), [deploy script](../scripts/deploy_github.sh), [Caddyfile](../deploy/Caddyfile), [Stalwart Compose](../ops/stalwart/compose.yaml), [local smoke test](../ops/stalwart/local_smoke.py), [manual backup script](../ops/stalwart/backup.sh), [Stalwart provider](../server/services/stalwartMailboxProvider.js), [Manyreach export helper](../server/services/manyreachSenderExport.js).
- Vendor references: [Stalwart Caddy certificate-copy guidance](https://stalw.art/docs/server/reverse-proxy/caddy/), [Stalwart DNS](https://stalw.art/docs/install/dns/), [Stalwart storage](https://stalw.art/docs/storage/), [Resend SMTP](https://resend.com/docs/send-with-smtp), [Manyreach sender setup](https://help.manyreach.com/en/articles/119-senders-and-mailboxes-setup-and-troubleshooting-guide). Current vendor docs may describe versions newer than the installed Stalwart v0.16.24; verify version-specific settings against the deployed service.
