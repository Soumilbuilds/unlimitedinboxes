# Unlimited Inboxes Deployment Runbook

Last audited: 2026-05-28

## Current Production Topology

- Domain: `app.unlimitedinboxes.com`
- VPS IP: `62.171.150.14`
- VPS user: `root`
- GitHub repo: `https://github.com/Soumilbuilds/unlimitedinboxes.git`
- Branch: `main`
- VPS app root: `/opt/unlimited-inboxes`
- Reverse proxy: Caddy proxies HTTPS to `127.0.0.1:3000`
- Process manager: `systemd` unit `unlimited-inboxes.service`
- Live symlink: `/opt/unlimited-inboxes/current`
- Release folders: `/opt/unlimited-inboxes/releases/<timestamp>`
- Git mirror on VPS: `/opt/unlimited-inboxes/repo`
- Shared production env: `/opt/unlimited-inboxes/shared/.env`
- Shared production DB: `/opt/unlimited-inboxes/shared/db/app.db`

The service unit runs from:

```bash
/opt/unlimited-inboxes/current/server
```

That means copying files to `/root/server`, `/root/client`, or `/opt/unlimited-inboxes/repo` does not ship the app unless `/opt/unlimited-inboxes/current` is moved to a new release and `unlimited-inboxes.service` is restarted.

## What Went Wrong

1. The live service was still running an old release:

```bash
/opt/unlimited-inboxes/releases/20260418124619/server
```

2. New code was copied to inactive paths:

```bash
/root/server
/root/client
/opt/unlimited-inboxes/repo
```

3. The old release kept serving old frontend assets, while newer built assets existed elsewhere. Requests for a newer JS file returned the SPA HTML fallback instead of JavaScript.

4. Manual `node index.js` and `pkill node` fought with systemd. Systemd kept restarting the old release because its unit points at `/opt/unlimited-inboxes/current/server`.

5. The live release still contains old Stripe checkout params that were already fixed in later commits. The local dirty tree also contains a newer Stripe Elements attempt that still needs cleanup before shipping.

## Data Preservation Rules

- Never overwrite or rsync over `/opt/unlimited-inboxes/shared`.
- Never replace `/opt/unlimited-inboxes/shared/db/app.db` with a local DB.
- Every deploy must keep `server/db/app.db` as a symlink to:

```bash
/opt/unlimited-inboxes/shared/db/app.db
```

- Every deploy should create a DB backup before restarting:

```bash
/opt/unlimited-inboxes/shared/db/backups/app-<timestamp>.db
```

- Releases are disposable. Shared env, DB, logs, certs, and uploaded/customer state are not.

## Normal Deployment From Local To GitHub To VPS

Run from the repo root:

```bash
cd "/Users/poonam/Desktop/Unlimited Mailboxes final"
git status --short --branch
```

Verify locally:

```bash
cd client && npm ci && npm run build
cd ../server && npm ci && node --check index.js
```

Commit intentionally. Do not blindly commit unrelated files or secrets:

```bash
git add client server scripts DEPLOYMENT_RUNBOOK.md
git commit -m "Fix billing and production deploy"
git push origin main
```

Deploy from GitHub to a timestamped release on the VPS:

```bash
./scripts/deploy_github.sh
```

On this Mac, deploy credentials live in ignored local file `.deploy.env`. Do not commit that file. If another agent needs to deploy from this machine, it should source `.deploy.env` through the script rather than pasting credentials into commands or docs.

If unrelated local scratch files exist, commit the intended app changes first, then run:

```bash
ALLOW_DIRTY=1 ./scripts/deploy_github.sh
```

That deploys the committed GitHub branch and leaves local scratch files untouched.

What the script does:

1. Pushes local `main` to GitHub if needed.
2. Fetches `origin/main` into `/opt/unlimited-inboxes/repo`.
3. Copies the GitHub version into `/opt/unlimited-inboxes/releases/<timestamp>`.
4. Links shared `.env` and shared `app.db` into the release.
5. Installs server dependencies inside the release.
6. Builds the client locally by default and rsyncs `client/dist` into the release to avoid VPS OOM during Vite builds.
7. Moves `/opt/unlimited-inboxes/current` to the new release.
8. Restarts `unlimited-inboxes.service`.
9. Health-checks `http://127.0.0.1:3000/api/health`.
10. Rolls back the symlink and restarts the service if the health check fails.

## Manual VPS Checks

Use these when debugging production:

```bash
systemctl status unlimited-inboxes --no-pager -l
journalctl -u unlimited-inboxes -n 100 --no-pager
readlink -f /opt/unlimited-inboxes/current
ps -eo pid,ppid,etime,user,args | grep "node index.js" | grep -v grep
ss -tlnp | grep :3000
curl -fsS http://127.0.0.1:3000/api/health
```

Confirm the deployed frontend is the one the server is actually serving:

```bash
sed -n '1,20p' /opt/unlimited-inboxes/current/client/dist/index.html
curl -fsS https://app.unlimitedinboxes.com/ | grep '/assets/'
```

## Rollback

Find the previous release:

```bash
ls -1 /opt/unlimited-inboxes/releases | tail -20
```

Rollback:

```bash
ln -sfn /opt/unlimited-inboxes/releases/<previous-release> /opt/unlimited-inboxes/current
systemctl restart unlimited-inboxes
curl -fsS http://127.0.0.1:3000/api/health
```

## Do Not Use

Do not deploy with these patterns:

```bash
rsync ... /root/server
rsync ... /root/client
nohup node index.js &
pkill -9 node
fuser -k 3000/tcp
```

Those bypass or fight systemd and can leave production running stale code.

## Whop Checkout Flow

Whop is the active processor for new subscriptions. Stripe and xPay remain legacy compatibility code only.

- Backend creates a Whop Checkout Configuration with account-bound metadata.
- Frontend renders that configuration through `@whop/checkout/react`.
- The authenticated email is prefilled and hidden inside the embed.
- A complete stored billing address is prefilled and hidden; otherwise the address form remains visible.
- Checkout uses `setupFutureUsage="off_session"` so Whop saves the payment method for future authorized charges.
- The browser sends Whop's receipt ID to `/api/billing/return`; the server retrieves and verifies the payment before granting access.
- Whop webhooks at `/api/billing/webhook/whop` are signature-verified and idempotent.

## Billing Access Rules

- The introductory Whop plan charges $1, includes a five-day trial, and renews at $9.99 every 28 days.
- Active trial (`trialing`) can create up to 100 inboxes, but only the first 10 credentials are visible/downloadable.
- Active paid Basic can create and download 100 inboxes.
- The configured future tiers are 500 inboxes at $39.99, 1,500 at $99.99, unlimited sequential processing at $199.99, and unlimited parallel processing at $299.99 per 28 days.
- Missing trial/subscription is a soft gate: let the user enter the app, but when they click New Order or try to process an order, show the trial/upgrade prompt and send them to hosted Checkout.
- Overdue billing (`past_due`, `unpaid`, or `incomplete`) is a hard gate: redirect to `/billing?intent=retry` and show the open Stripe invoice or billing portal.
- Completed trial order usage is tracked on the user record so deleting an old completed order does not reset the one-order trial limit.
- Tenant purchases are one-time Stripe Checkout payments. If `STRIPE_PRICE_US_TENANT` or `STRIPE_PRICE_ASIA_TENANT` points at a recurring Stripe price, the server intentionally creates inline one-time price data instead of using that recurring price directly.
