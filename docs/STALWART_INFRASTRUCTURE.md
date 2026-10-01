# Stalwart Infrastructure And Operations

Last updated: 2026-10-01. Stalwart has trusted public IMAPS and five authenticated mailboxes. The user changed the apex MX to `10 mail.igoutbound.com.`; DNS answers are still inconsistent across resolvers and authoritative nodes.

## Current Deployment

| Component | Live fact or current state |
| --- | --- |
| Host | Ubuntu 24.04 VPS at `62.171.150.14`; 4 CPUs, 7.8 GB RAM, 145 GB disk. The app and mail service share this host and its failure domain. |
| Container runtime | Docker 29.1.3 and Docker Compose 2.40.3. |
| Mail service | Stalwart v0.16.24 runs as the `stalwart` Compose service under `/opt/stalwart`. `/opt/stalwart/config` binds to `/etc/stalwart`, and `/opt/stalwart/data` binds to `/var/lib/stalwart`. `/opt/stalwart/secrets` and `/opt/stalwart/backups` are host directories; they are not additional container mounts in the checked-in Compose file. |
| Current Compose exposure | Public `25:25` and `993:993` are published and externally reachable. An extra loopback IMAPS mapping remains at `127.0.0.1:1993:993`; administration remains loopback at `127.0.0.1:18080:8080` and `127.0.0.1:10443:443`. The deployed layout matches [ops/stalwart/compose.yaml](../ops/stalwart/compose.yaml). |
| Validation | The `igoutbound.com` domain and five requested mailboxes exist. Local SMTP delivery and unauthenticated foreign-relay rejection passed. Gmail delivered a message from `soumil2406@gmail.com` to Stacy at `2026-10-01T02:43:37Z`; the message is in INBOX and its body is readable. An external client validated TLS, logged in to all five mailboxes, and selected each INBOX. See the [local smoke test](../ops/stalwart/local_smoke.py). |
| Existing web traffic | Caddy already serves the application and MCP endpoints. The app and MCP are healthy. The checked-in [Caddyfile](../deploy/Caddyfile) covers app/API/MCP HTTP reverse proxies; it is not a mail proxy configuration. The app currently also listens publicly on port 3000 despite the older runbook saying loopback; this Stalwart work did not alter it. |
| Host firewall | UFW is inactive and the observed iptables INPUT policy is ACCEPT. Public 25 is intentional for inbound mail. Avoid enabling a host firewall without first protecting SSH and the existing app paths. |
| DNS and TLS | `mail.igoutbound.com` resolves publicly to `62.171.150.14`. The user changed the apex MX to Stalwart, but local/Cloudflare/Hostinger answers still sometimes show the old SES MX while Google resolves the new one. Caddy issued a Let's Encrypt certificate for `mail.igoutbound.com` (issuer `YE2`, valid 2026-10-01 through 2026-12-30 UTC). Stalwart serves it on IMAPS and SMTP STARTTLS; external OpenSSL returned `Verify return code: 0 (ok)`. |

The application deploy path in [DEPLOYMENT_RUNBOOK.md](../DEPLOYMENT_RUNBOOK.md) and [scripts/deploy_github.sh](../scripts/deploy_github.sh) is separate from `/opt/stalwart`. Its app SQLite backup and release-symlink rollback do **not** back up or roll back Stalwart.

## Mail Flow And Port Boundary

```text
Current SMTP:         Internet --TCP 25 (reachable)--> Stalwart
Current IMAP:         public IMAPS 993 -------------> Stalwart
Local IMAP testing:   host loopback 1993 -----------> Stalwart IMAPS 993
Intended inbound:     igoutbound.com MX ------------> mail.igoutbound.com
Outbound:             Manyreach ----------SMTP/TLS----------> Resend
Web app and MCP:      Internet --HTTPS--> existing Caddy --> app / MCP
Administration:       operator/local access --> loopback Stalwart admin ports
```

Stalwart is the **inbound mailbox and IMAP service**. Resend is the **outbound SMTP service**. There is no Stalwart submission service on port 587 in this architecture; do not publish it or tell Manyreach to send through Stalwart. Manyreach needs two distinct connections for each sender: Resend SMTP to send and Stalwart IMAP to read replies. [Manyreach's sender guide](https://help.manyreach.com/en/articles/119-senders-and-mailboxes-setup-and-troubleshooting-guide) says both SMTP and IMAP are needed. [Resend's SMTP guide](https://resend.com/docs/send-with-smtp) lists `smtp.resend.com`, username `resend`, an API key as the password, and TLS-capable ports including 465 and 587. **The Resend destination port is outbound from Manyreach; it is not a Stalwart listener.**

Keep the Stalwart management endpoints on loopback or a private administrative path. Public TCP 25 and 993 are reachable; Caddy provides the certificate but does not proxy SMTP or IMAP. The isolated Caddy mail hostname returns HTTP 404 for `/jmap/`, so the management API is not published. Manyreach has not been connected yet.

## DNS And TLS Status

**Current DNS issue:** the user saved `igoutbound.com MX 10 mail.igoutbound.com.`, and Gmail delivered to Stalwart. During verification, the local resolver and at times 1.1.1.1 returned the old SES MX, while 8.8.8.8 returned the new MX. Direct queries to Hostinger's authoritative `atlas` and `hyperion` servers also disagreed despite reporting the same SOA serial. Recheck all authoritative and recursive answers; until they agree, some senders may still route to SES. No Resend return-path record was changed by this work.

| Stage | Type | Name | Value | Priority |
| --- | --- | --- | --- | --- |
| Completed | A | `mail.igoutbound.com` | `62.171.150.14` | — |
| Changed by user; verify propagation | MX | `igoutbound.com` | `mail.igoutbound.com` | `10` |

The former apex MX was `10 inbound-smtp.us-east-1.amazonaws.com.`. Preserve Resend DKIM, SPF/return-path, and DMARC records. Do not create an AAAA record for the mail host until IPv6 is ready.

Current TLS operations: the isolated [Caddy mail block](../ops/stalwart/Caddyfile.mail) is appended to `/etc/caddy/Caddyfile`; a pre-change copy is in `/opt/stalwart/backups`. [sync_caddy_certificate.py](../ops/stalwart/sync_caddy_certificate.py) verifies the certificate and matching key, copies them into `/opt/stalwart/config/tls` as mode 600 under container UID 2000, creates or updates Stalwart's Certificate object, and hot reloads TLS. The [systemd service](../ops/stalwart/stalwart-certificate.service) and [hourly timer](../ops/stalwart/stalwart-certificate.timer) are installed and active. A repeat sync reported the certificate unchanged; the systemd service result was `success`. [Stalwart's Caddy guide](https://stalw.art/docs/server/reverse-proxy/caddy/) documents this pattern.

Next sequence:

1. Check the apex MX at the local resolver, 1.1.1.1, 8.8.8.8, and both Hostinger authoritative nameservers until they agree on `10 mail.igoutbound.com.`. Retain the prior SES MX for rollback. [Stalwart's DNS guide](https://stalw.art/docs/install/dns/) explains MX records.
2. Gmail-to-Stacy delivery and external IMAP retrieval passed. Amy, Sam, Jake, and Mia were then created with distinct random passwords and passed external IMAP authentication.
3. Connect Manyreach using Resend SMTP and Stalwart IMAP only when requested. Test a real reply and keep the two credentials separate.

These are read-only checks; run them from the host or an external probe as appropriate:

```bash
cd /opt/stalwart
docker compose ps
ss -lntp
dig +short A mail.igoutbound.com
dig +short MX igoutbound.com
openssl s_client -connect mail.igoutbound.com:993 -servername mail.igoutbound.com
openssl s_client -starttls smtp -connect mail.igoutbound.com:25 -servername mail.igoutbound.com
```

The intended apex MX is now the Stalwart mail host, but observed DNS answers are inconsistent. No separate return-path MX change is part of this cutover.

## Provisioning And Manyreach Integration

The repository contains [StalwartMailboxProvider](../server/services/stalwartMailboxProvider.js) and [FileSecretStore](../server/services/fileSecretStore.js). The provider uses the Stalwart JMAP management API with a bearer token over HTTPS or the explicitly allowed IP loopback HTTP endpoint `http://127.0.0.1:18080`; the deployed API remains private. It can ensure a domain and user mailbox, excludes the bootstrap administrator from managed mailbox listings, and stores generated mailbox passwords in the file secret store. Its domain creation requests manual DNS and certificate management. The five requested accounts have been created on live Stalwart and passed external IMAP login, but the application is not wired to Stalwart for customer orders. [Stalwart management documentation](https://stalw.art/docs/management/) describes the API model.

The repository's [Manyreach sender export helper](../server/services/manyreachSenderExport.js) **splits the credentials correctly**: `smtp.resend.com:465`, username `resend`, and a Resend API key from the secret store for SMTP; the Stalwart IMAP host/port, mailbox address, and mailbox password for IMAP. It can build a payload or write a restricted `.credentials.csv` file; it makes no Manyreach API call. Keep the Resend API key and mailbox password out of logs, and treat any CSV as a short-lived secret-bearing artifact. External IMAP login passed, but Manyreach onboarding remains untested. The older [Microsoft OAuth importer](../scripts/MANYREACH_MICROSOFT_IMPORT.md) is unrelated to this flow.

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

1. Resolve the inconsistent MX answers across Hostinger authoritative servers and recursive resolvers; Gmail delivery succeeded, but not all senders will necessarily use the new route yet.
2. Keep Manyreach disconnected until specifically requested. When connected, test Resend SMTP sending and Stalwart IMAP reply reading with one sender first.
3. Arrange an interruption window for the **unrun** manual `backup.sh --quiesce`, or replace it with a tested non-disruptive snapshot. Verify the resulting archive and isolated restore, then copy it off-host.

## Sources

- Live host, runtime, deployment, DNS, TLS, and health facts: verified on the VPS and from an external client on 2026-10-01. The user changed A and MX records; this deployment made no DNS change.
- Repository: [deployment runbook](../DEPLOYMENT_RUNBOOK.md), [deploy script](../scripts/deploy_github.sh), [Caddyfile](../deploy/Caddyfile), [Stalwart Compose](../ops/stalwart/compose.yaml), [local smoke test](../ops/stalwart/local_smoke.py), [manual backup script](../ops/stalwart/backup.sh), [Stalwart provider](../server/services/stalwartMailboxProvider.js), [Manyreach export helper](../server/services/manyreachSenderExport.js).
- Vendor references: [Stalwart Caddy certificate-copy guidance](https://stalw.art/docs/server/reverse-proxy/caddy/), [Stalwart DNS](https://stalw.art/docs/install/dns/), [Stalwart storage](https://stalw.art/docs/storage/), [Resend SMTP](https://resend.com/docs/send-with-smtp), [Manyreach sender setup](https://help.manyreach.com/en/articles/119-senders-and-mailboxes-setup-and-troubleshooting-guide). Current vendor docs may describe versions newer than the installed Stalwart v0.16.24; verify version-specific settings against the deployed service.
