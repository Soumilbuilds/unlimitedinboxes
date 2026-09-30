# Stalwart Infrastructure And Operations

Last updated: 2026-09-30. Host and deployment facts in this document come from the live operations handoff. This is an **installed, staged Stalwart deployment**, not a completed mail cutover. No production or DNS change was made while writing this document.

## Current Deployment

| Component | Live fact or current state |
| --- | --- |
| Host | Ubuntu 24.04 VPS at `62.171.150.14`; 4 CPUs, 7.8 GB RAM, 145 GB disk. The app and mail service share this host and its failure domain. |
| Container runtime | Docker 29.1.3 and Docker Compose 2.40.3. |
| Mail service | Stalwart v0.16.24 runs as the `stalwart` Compose service under `/opt/stalwart`. `/opt/stalwart/config` binds to `/etc/stalwart`, and `/opt/stalwart/data` binds to `/var/lib/stalwart`. `/opt/stalwart/secrets` and `/opt/stalwart/backups` are host directories; they are not additional container mounts in the checked-in Compose file. |
| Current Compose exposure | Public `25:25` is already published and externally TCP reachable. IMAPS remains loopback at `127.0.0.1:1993:993`; administration remains loopback at `127.0.0.1:18080:8080` and `127.0.0.1:10443:443`. Public 993 is not yet published. The deployed layout matches [ops/stalwart/compose.yaml](../ops/stalwart/compose.yaml). |
| Local validation | The `igoutbound.com` domain and `stacy@igoutbound.com` mailbox already exist. Local SMTP delivery to Stacy, IMAP login/message read, and unauthenticated foreign-relay rejection passed. Public 25 TCP reachability also passed. These tests do not establish production TLS, public IMAPS, or MX delivery. See the [local smoke test](../ops/stalwart/local_smoke.py). |
| Existing web traffic | Caddy already serves the application and MCP endpoints. The app and MCP are healthy. The checked-in [Caddyfile](../deploy/Caddyfile) covers app/API/MCP HTTP reverse proxies; it is not a mail proxy configuration. The app currently also listens publicly on port 3000 despite the older runbook saying loopback; this Stalwart work did not alter it. |
| Host firewall | UFW is inactive and the observed iptables INPUT policy is ACCEPT. Public 25 is intentional for inbound mail. Avoid enabling a host firewall without first protecting SSH and the existing app paths. |
| DNS and TLS | `mail.igoutbound.com` has no A record. The **apex `igoutbound.com` inbound MX** still points to SES. Trusted TLS for the mail hostname is pending the A record and the Caddy certificate-copy setup. No DNS change has been made. |

The application deploy path in [DEPLOYMENT_RUNBOOK.md](../DEPLOYMENT_RUNBOOK.md) and [scripts/deploy_github.sh](../scripts/deploy_github.sh) is separate from `/opt/stalwart`. Its app SQLite backup and release-symlink rollback do **not** back up or roll back Stalwart.

## Mail Flow And Port Boundary

```text
Current SMTP:         Internet --TCP 25 (reachable)--> Stalwart
Current IMAP:         host loopback 1993 -----------> Stalwart IMAPS 993
After IMAP exposure:  Manyreach --public IMAPS 993--> Stalwart
After MX cutover:     igoutbound.com MX ------------> mail.igoutbound.com
Outbound:             Manyreach ----------SMTP/TLS----------> Resend
Web app and MCP:      Internet --HTTPS--> existing Caddy --> app / MCP
Administration:       operator/local access --> loopback Stalwart admin ports
```

Stalwart is the **inbound mailbox and IMAP service**. Resend is the **outbound SMTP service**. There is no Stalwart submission service on port 587 in this architecture; do not publish it or tell Manyreach to send through Stalwart. Manyreach needs two distinct connections for each sender: Resend SMTP to send and Stalwart IMAP to read replies. [Manyreach's sender guide](https://help.manyreach.com/en/articles/119-senders-and-mailboxes-setup-and-troubleshooting-guide) says both SMTP and IMAP are needed. [Resend's SMTP guide](https://resend.com/docs/send-with-smtp) lists `smtp.resend.com`, username `resend`, an API key as the password, and TLS-capable ports including 465 and 587. **The Resend destination port is outbound from Manyreach; it is not a Stalwart listener.**

Keep the Stalwart management endpoints on loopback or a private administrative path. Public TCP 25 is **already published and externally reachable**, while IMAPS is still available only through loopback host port `1993`. Public 993 and trusted TLS remain pending before a remote Manyreach IMAP client can connect. The existing Caddy HTTP reverse proxy does not proxy these mail protocols; Caddy's role in the current plan is to obtain and renew the mail-host certificate for Stalwart to use.

## DNS And TLS Status

**Current blockers:** `mail.igoutbound.com` has no A record; the apex `igoutbound.com` inbound MX still points to SES; trusted mail-host TLS and public IMAPS 993 are pending. The apex SES MX is the **inbound MX that will be changed** at cutover. This document does not propose changing any separate Resend return-path DNS records.

| Stage | Type | Name | Value | Priority |
| --- | --- | --- | --- | --- |
| Certificate preparation | A | `mail.igoutbound.com` | `62.171.150.14` | — |
| Later inbound cutover | MX | `igoutbound.com` | `mail.igoutbound.com` | `10` |

Replace the current apex MX `10 inbound-smtp.us-east-1.amazonaws.com.` only at the later cutover. Preserve Resend DKIM, SPF/return-path, and DMARC records. Do not create an AAAA record for the mail host until IPv6 is ready.

Next sequence:

1. Record the current apex SES MX value and TTL, plus the current Resend sending, SPF, DKIM, and DMARC records. Keep the outbound sending records in place. `dig +short MX igoutbound.com` checks the apex inbound route.
2. Add an A record for `mail.igoutbound.com` pointing to `62.171.150.14`. Confirm it resolves from authoritative and public resolvers with `dig +short A mail.igoutbound.com`. Do not add an AAAA record unless IPv6 listeners, firewall, and delivery are tested.
3. Append the isolated [Caddy mail block](../ops/stalwart/Caddyfile.mail) for `mail.igoutbound.com`; it returns `404` and keeps Stalwart management on loopback. Validate and reload Caddy so it issues a certificate for the hostname. [sync_caddy_certificate.py](../ops/stalwart/sync_caddy_certificate.py) verifies the new certificate and matching key, copies them into `/opt/stalwart/config/tls` with restricted permissions, creates or updates the Stalwart Certificate object, sets the default certificate, and requests a hot reload. The [service](../ops/stalwart/stalwart-certificate.service) and [timer](../ops/stalwart/stalwart-certificate.timer) check for renewed certificates hourly. These are prepared but **not activated** while the A record is absent. [Stalwart's Caddy guide](https://stalw.art/docs/server/reverse-proxy/caddy/) documents the certificate-copy pattern. Verify the certificate on SMTP 25 STARTTLS and IMAPS after activation.
4. Publish public IMAPS 993 and allow it through the firewall; keep admin ports private. Public SMTP 25 is already reachable and does not need to be exposed again. No public Stalwart 587 is needed.
5. Test external SMTP delivery directly to the Stalwart host and trusted public IMAPS, then connect the prepared Resend SMTP / Stalwart IMAP sender in Manyreach. Once the mail path is sound, replace the **apex `igoutbound.com` inbound MX** from SES with `mail.igoutbound.com`, watch mail delivery and queues, and test a real reply through Manyreach. Keep the recorded SES MX for rollback. [Stalwart's DNS guide](https://stalw.art/docs/install/dns/) explains MX and mail-host records; [Resend's domain guide](https://resend.com/docs/dashboard/domains/introduction) explains sending-domain verification.

These are read-only checks; run them from the host or an external probe as appropriate:

```bash
cd /opt/stalwart
docker compose ps
ss -lntp
dig +short A mail.igoutbound.com
dig +short MX igoutbound.com
# After trusted TLS and public IMAPS are ready:
openssl s_client -connect mail.igoutbound.com:993 -servername mail.igoutbound.com
openssl s_client -starttls smtp -connect mail.igoutbound.com:25 -servername mail.igoutbound.com
```

The apex `igoutbound.com` MX is currently the SES inbound route. Its change is pending; no separate return-path MX change is part of this cutover.

## Provisioning And Manyreach Integration

The repository contains [StalwartMailboxProvider](../server/services/stalwartMailboxProvider.js) and [FileSecretStore](../server/services/fileSecretStore.js). The provider uses the Stalwart JMAP management API with a bearer token over HTTPS or the explicitly allowed IP loopback HTTP endpoint `http://127.0.0.1:18080`; the deployed API remains private. It can ensure a domain and user mailbox and stores a generated mailbox password in the file secret store. Its domain creation requests manual DNS and manual certificate management. Separately, the `igoutbound.com` domain and Stacy mailbox have **already been created on the live Stalwart service** and passed the local smoke test. That does not by itself establish that the application is wired to production Stalwart for customer orders. [Stalwart management documentation](https://stalw.art/docs/management/) describes the API model.

The repository's [Manyreach sender export helper](../server/services/manyreachSenderExport.js) **now splits the credentials correctly**: `smtp.resend.com:465`, username `resend`, and a Resend API key from the secret store for SMTP; the Stalwart IMAP host/port, mailbox address, and mailbox password for IMAP. It can build a payload or write a restricted `.credentials.csv` file; it makes no Manyreach API call. Keep the Resend API key and mailbox password out of logs, and treat any CSV as a short-lived secret-bearing artifact. Manyreach onboarding and a remote IMAP connection remain unverified until public 993 and trusted TLS are ready. The older [Microsoft OAuth importer](../scripts/MANYREACH_MICROSOFT_IMPORT.md) is unrelated to this flow.

For each sender, record a stable mailbox email and Manyreach sender ID, check that the Resend sending domain is verified, connect one pilot sender, verify both SMTP and IMAP status, send a test message, and confirm its reply arrives in Stalwart and is visible to Manyreach. Only then import further senders in bounded batches. A Stalwart account existing does not prove that Resend accepts its From domain or that Manyreach can read replies. Rotate Resend and mailbox credentials separately and retest both connections.

## Operations On This VPS

Run Stalwart maintenance from `/opt/stalwart`, not from the app release directory. Use `docker compose ps` to see service and host port mappings, `docker compose logs --tail=100` for recent container events, `ss -lntp` for listeners, and `df -h`/`df -i` for capacity. Do not publish log excerpts containing credentials or mail content. Track CPU, memory, disk and inode pressure because the mail store shares a 4-CPU/7.8-GB/145-GB VPS with the healthy app and MCP. Watch container restarts, SMTP accept failures, IMAP auth failures, queue age, certificate expiry, and successful backup age. An app `/api/health` response does not prove mail delivery.

Pin the Stalwart image at v0.16.24 until an upgrade and rollback plan is tested. Record the Compose file, image digest, bind-mount map, listener configuration, and TLS/certificate source in the operations inventory. Verify the bind-mounted host directories have the ownership required by the container user; Stalwart's [Docker guide](https://stalw.art/docs/install/platform/docker/) explains its persistent config/data mounts and bind-mount ownership. Caddy and the app should continue to be checked separately.

## Backup, Restore, And Rollback

`/opt/stalwart/backups` exists, and [ops/stalwart/backup.sh](../ops/stalwart/backup.sh) is a **manual quiesced backup script that has not been run**. It requires `--quiesce`, stops the `stalwart` Compose service, archives `compose.yaml`, `config`, `data`, and `secrets`, writes a SHA-256 checksum, restarts the service, and waits for container health. Running it would briefly interrupt SMTP and IMAP, including already reachable public port 25. Do not describe the presence of this script or directory as an existing backup, schedule, offsite copy, or restore test. The app deploy script's SQLite copy remains separate. Keep an encrypted copy of any verified archive outside this VPS; same-disk copies do not cover host loss. Stalwart's [storage overview](https://stalw.art/docs/storage/) explains why metadata and blobs both matter.

For the first backup, plan a brief maintenance window or implement and test a backend-supported coordinated snapshot that avoids service stoppage. The current script is the **outage-causing** option and remains unrun. After a backup is taken, verify its checksum and restore it to an isolated host with Stalwart v0.16.24; check domain/account inventory and sample mail before calling it recoverable. Do not substitute a live copy of embedded-store files for a verified backup. Stalwart's [Vandelay account archives](https://stalw.art/docs/migration/import-export/backup/) may supplement this but do not include surrounding server configuration; check availability in v0.16.24 before relying on them.

Restore procedure for an approved maintenance window: verify the archive against its `.sha256`, stop the Stalwart Compose service, extract the archive into a fresh isolated directory while preserving numeric ownership and permissions, inspect its `compose.yaml` and mount paths, then replace only `/opt/stalwart/{compose.yaml,config,data,secrets}` after keeping the current versions for rollback. Start the pinned image with `docker compose up -d`; check container health, account/domain inventory, IMAP login, and a local SMTP delivery before reopening inbound traffic. Never extract an unverified archive over the live mounts while Stalwart runs. Keep the app deployment and database out of this restore.

For disaster recovery, freeze new mailbox creation, select a verified backup, restore config/data/secrets to a clean host with the pinned image, and test locally before changing DNS. If the IP changes, update the mail-host A/PTR and then the inbound MX only as required. Reconcile accounts created since the backup and mail delivered during the outage. For a failed Stalwart upgrade, restore the matching image **and** a compatible store backup if the upgrade changed storage format; a `docker compose` image rollback alone may not reverse a migration. For a failed inbound MX cutover, return the recorded prior **inbound** MX while keeping Resend return-path records intact, and account for mail delivered to both receivers during DNS propagation. App release rollback does not touch Stalwart or Manyreach.

## Pending Work, In Order

1. Publish `mail.igoutbound.com` A to `62.171.150.14`; leave the apex SES inbound MX in place for now.
2. Let Caddy issue the mail-host certificate, copy the certificate and key into Stalwart, configure their use, and establish renewal-time copy/reload. Verify trusted TLS on the existing public SMTP 25 listener.
3. Publish public IMAPS 993, keep admin loopback-only, and verify remote TLS and IMAP login. Public SMTP 25 reachability and local Stacy/SMTP/IMAP/relay tests are already complete.
4. Exercise the corrected Manyreach payload with Resend SMTP and Stalwart IMAP, first with a single sender; verify outbound sending and IMAP connectivity. End-to-end reply receipt through the apex still awaits MX cutover.
5. Arrange an interruption window for the **unrun** manual `backup.sh --quiesce`, or replace it with a tested non-disruptive snapshot. Verify the resulting archive and isolated restore, then copy it off-host.
6. Replace the apex `igoutbound.com` inbound MX from SES with `mail.igoutbound.com`; monitor Stalwart delivery, confirm a real Manyreach reply reaches Stacy's mailbox, and retain the old SES MX value for rollback.

## Sources

- Live host, runtime, deployment, DNS, and health facts: operator handoff for this revision; no live access or DNS changes were made here.
- Repository: [deployment runbook](../DEPLOYMENT_RUNBOOK.md), [deploy script](../scripts/deploy_github.sh), [Caddyfile](../deploy/Caddyfile), [Stalwart Compose](../ops/stalwart/compose.yaml), [local smoke test](../ops/stalwart/local_smoke.py), [manual backup script](../ops/stalwart/backup.sh), [Stalwart provider](../server/services/stalwartMailboxProvider.js), [Manyreach export helper](../server/services/manyreachSenderExport.js).
- Vendor references: [Stalwart Caddy certificate-copy guidance](https://stalw.art/docs/server/reverse-proxy/caddy/), [Stalwart DNS](https://stalw.art/docs/install/dns/), [Stalwart storage](https://stalw.art/docs/storage/), [Resend SMTP](https://resend.com/docs/send-with-smtp), [Manyreach sender setup](https://help.manyreach.com/en/articles/119-senders-and-mailboxes-setup-and-troubleshooting-guide). Current vendor docs may describe versions newer than the installed Stalwart v0.16.24; verify version-specific settings against the deployed service.
