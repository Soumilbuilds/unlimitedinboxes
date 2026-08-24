# Manyreach Microsoft Sender Import

Manyreach's public sender API supports SMTP sender creation but does not expose a bulk Microsoft OAuth onboarding endpoint. These scripts preserve the browser-based OAuth workflow for a future SaaS feature without embedding credentials in the application or repository.

## Components

- `manyreach-refresh-session.mjs` logs into Manyreach with credentials supplied through environment variables and writes a restricted cookie file.
- `manyreach-import-microsoft.mjs` imports CSV rows through Microsoft OAuth, verifies each sender in Manyreach, and records resumable state.
- `manyreach-import-watch.sh` runs durable passes, skips prior successes, and retries only incomplete accounts.

## Input

The CSV must contain `email,password`. A `provider` column is optional. Passwords are read per row; a shared `MAILBOX_PASSWORD` can be supplied only for legacy CSVs without a password column.

## Session Refresh

```bash
MANYREACH_EMAIL='user@example.com' \
MANYREACH_PASSWORD='read-from-a-secret-store' \
MANYREACH_SENDERS_URL='https://app.manyreach.com/e/senders?org=ORG_ID' \
node scripts/manyreach-refresh-session.mjs /secure/runtime/manyreach-cookies.json
```

Never pass passwords on the command line or commit the generated cookie file.

## Resumable Import

```bash
nohup scripts/manyreach-import-watch.sh \
  --csv /secure/runtime/mailboxes.csv \
  --cookies /secure/runtime/manyreach-cookies.json \
  --work-dir /durable/manyreach/import-ID \
  --org-id ORG_ID \
  --concurrency 4 \
  > /durable/manyreach/import-ID/launcher.log 2>&1 &
```

The work directory contains non-secret progress state, results, logs, and the active importer PID. Store uploaded CSVs and cookies separately with owner-only permissions, then delete those two secret-bearing files after a successful import.

## Future SaaS Integration

Run imports as background jobs rather than inside HTTP requests. Store Manyreach credentials, mailbox CSVs, and cookies in an encrypted secret/object store; expose only aggregate progress to the customer. Enforce one active import per workspace, bounded concurrency, resumable idempotency by normalized email, audit logging without passwords or OAuth codes, and explicit user authorization before starting the external-account mutation.
