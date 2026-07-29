# Failproof Hardening Plan — Unlimited Inboxes

Goal: orders succeed on first try, recover from transient Microsoft failures without manual intervention, and never leave the customer in a half-configured state.

Three layers, in priority order. Each item is independent and shippable on its own.

---

## Layer 1 — Tenant Bootstrap (kills the "first-login prompt" class of failures)

**Why first:** every other layer is fighting downstream symptoms. The tenant's policies are what create those symptoms in the first place. Fix this and 60% of customer complaints disappear.

**Current state:** We just added `disableSecurityDefaultsWithClient` in `orderProcessor.js:386-395`. That covers ONE of the six enforcement surfaces. The other five still bite.

**The 6-call bootstrap, run once per new tenant BEFORE the first mailbox is created:**

| # | Call | What it kills | File |
|---|---|---|---|
| 1 | `PATCH /policies/identitySecurityDefaultsEnforcementPolicy` `isEnabled:false` | "Set up MFA" wall, KMSI trigger | already added |
| 2 | `PATCH /policies/authenticationMethodsPolicy` `registrationEnforcement.authenticationMethodsRegistrationCampaign.state:"disabled"` | Authenticator-registration banner | **new** — needs `Policy.ReadWrite.AuthenticationMethod` |
| 3 | `GET /policies/conditionalAccessPolicies?$filter=state eq 'enabled'` — log/assert none enforce MFA on All Users | "MFA required" CA wall | **new** |
| 4 | `POST /oauth2PermissionGrants` `consentType:"AllPrincipals"` for our SP | OAuth consent screen | **new** |
| 5 | `PATCH /policies/authorizationPolicy` `allowedToUseSSPR:false` | SSPR admin-gate | **new** |
| 6 | For each mailbox after creation: `PATCH /users/{id}` `passwordPolicies:"DisablePasswordExpiration"` | "Password expired" prompt | **new** |

**Order matters:** SD off → campaign off → consent grant → CA audit → THEN create mailbox. Doing it after is racy (Microsoft registers the user for MFA at first interactive sign-in, which may beat us).

**Idempotency:** every call here is safe to repeat. Add a `tenants.bootstrap_complete` boolean; if missing on next order, re-run the whole sequence (cheap, ~6 API calls).

**Free-tenant gotcha:** Security Defaults disable requires P1/P2 OR a paid workload. For free tenants, fall back to creating a disabled CA policy with `excludeUsers` = our created users group.

**File targets:**
- `server/services/graph.js` — add 5 new functions next to `disableSecurityDefaultsWithClient`
- `server/services/orderProcessor.js` — wrap them in a new `bootstrapTenant(tenant, log)` called before `createGraphClientProvider` if `bootstrap_complete=false`, then set the flag

---

## Layer 2 — Graph API Resilience (kills the "Failed to fetch" / 500 / 429 class of failures)

**Why second:** even with a perfect tenant, Microsoft will throttle, return 500s, or drop the socket. We need retry logic that doesn't just keep blindly retrying until 2 hours later.

### 2a. Smart retry classification (`orderProcessor.js:67-69`)

Current `isRetryableAdminStatus` treats 400 and 404 as retryable. Both are wrong:
- 400 = real error, never retry
- 404 = stale state, never retry (e.g. deleting a user that no longer exists)

Add network failures (axios rejects with no status code = "TypeError: Failed to fetch"). Keep 403 out — that means missing app consent in the target tenant, retrying won't help.

Final retryable set: **0 (network), 408, 429, 500, 502, 503, 504**.

### 2b. Decorrelated jitter backoff

Replace fixed 60s sleeps with:
```
delay(attempt) = min(60_000, random(1000, prev_delay * 3))
```
- 7 attempts for network errors (~4 min budget)
- 5 attempts for 5xx (~2 min budget)
- 429: honor `Retry-After` header in seconds, fall back to jittered base 2s, cap 120s

### 2c. In-process circuit breaker (no library)

State: `{ state, failures, openedAt, windowStart }` in `orderProcessor.js` module scope.

- closed → open: 5 failures in rolling 60s
- open: all Graph calls reject with `CircuitOpenError` for 30s
- half-open → closed: 1 success
- half-open → open: 1 failure

Don't persist to SQLite (disk roundtrip on every call). Snapshot to disk every 5s for cross-restart awareness only.

### 2d. "Six 500s in a row, give up" guard

Track `consecutiveSameStatus` in a `Map<status, count>`. Reset on any non-matching response. At 6 consecutive 500s, throw `GiveUpError` and mark order `status='paused_throttled'` (new value) so `resumeInterruptedOrders` leaves it alone. Operator gets a Slack/email alert and can resume manually after Microsoft settles.

### 2e. Per-mailbox state machine (kills the "resume from zero" class of failures)

**The big one.** Right now `created_mailboxes` is a flat JSON array. If the worker dies at mailbox 47, resume re-runs mailbox 1's signin/admin/DKIM steps.

Migrate to a `mailbox_progress` table:
```sql
CREATE TABLE mailbox_progress (
  id INTEGER PRIMARY KEY,
  order_id INTEGER,
  email TEXT,
  step TEXT,         -- 'created' | 'upn_set' | 'signin_enabled' | 'admin_assigned' | 'dkim_configured'
  object_id TEXT,
  updated_at DATETIME,
  UNIQUE(order_id, email)
);
```

On resume: `WHERE order_id=? AND step < current_step` → skip those.

**This is the single highest-ROI change in the whole plan.** A 1-day migration that converts "kill the worker at 47, lose all 47's progress" into "kill the worker at 47, resume at mailbox 48."

### 2f. DKIM 500 breaker

Existing loop in `securityCenterDkim.js:184-207` retries every 60s for 120 min. Wire it into the new breaker: if 5 consecutive 500s in 60s, mark order as `dkim_pending` and let the customer proceed without DKIM. Re-enable DKIM in a background job later.

---

## Layer 3 — Login Flow Hardening (kills the "stuck on login" class of failures)

**Why third:** even with a perfect tenant and perfect Graph retries, the puppeteer login flow has 4 known failure modes. The screenshot from your "Done?" question showed one of them.

### 3a. KMSI (Stay signed in) — make it iframe-aware

Current handler at `puppeteer.js:175-233` works on the main frame. Microsoft sometimes renders KMSI inside an iframe (especially post-Conditional-Access claims challenge). Add a `page.frames()` scan and re-resolve `#idSIButton9` against child frames.

Also check the "Don't show again" checkbox BEFORE clicking No, so future logins don't ask again.

### 3b. URL-based KMSI pre-detection

Add `looksLikeKmsi(url)` covering:
- `login.microsoftonline.com/kmsi`
- `/SAS/ProcessAuth`, `/SAS/KeepMeSignedIn`
- `login.live.com` with `kmsi=1`
- `oauth2/authorize?kmsi=1`

Use as early-out so we don't race the selector probe.

### 3c. New-tab settle after click

KMSI itself doesn't open a tab, but Conditional-Access-driven KMSI sometimes opens one for MFA fallback. Add `page = await waitForNewOrActivePage(context, page, 5000)` after the click, mirroring the pattern at `puppeteer.js:496-498`.

### 3d. KMSI retry ladder

If Yes click doesn't navigate within 4s:
1. Check `page.on('response')` listener — if 200 but no nav, re-resolve iframe and click there
2. If still stuck, click No instead. The No path produces a session cookie sufficient for the Graph/REST calls in `createSharedMailbox`
3. Last resort: treat as already-logged-in, re-navigate to `targetUrl`. If that 302s back to login, report `login_error`

### 3e. "Don't show again" persistence is per-context

KMSI fires every time we create a fresh incognito context (`puppeteer.js:38-53`). Don't rely on it being cached. Plan for KMSI on every login.

### 3f. Reusable browser profile (optional, big win)

Right now every order creates a fresh incognito context. Switch to a persistent user-data-dir in `~/.config/puppeteer/Default/`. KMSI, MFA "Don't ask again", and other Microsoft cookies persist for 14 days → ~1 fewer dialog per order. The downside: cookies are shared between customer tenants. Audit before shipping.

---

## Implementation priority (rough effort + ROI)

| # | Change | Effort | ROI |
|---|---|---|---|
| 1 | Per-mailbox state machine (`mailbox_progress` table) | 1 day | 🔥🔥🔥🔥🔥 |
| 2 | Tenant bootstrap (Layer 1, 6 calls) | 1 day | 🔥🔥🔥🔥 |
| 3 | Graph retry classification + backoff | 2 hours | 🔥🔥🔥🔥 |
| 4 | KMSI iframe-aware + URL pre-detect | 2 hours | 🔥🔥🔥 |
| 5 | Circuit breaker | half day | 🔥🔥🔥 |
| 6 | KMSI retry ladder | 1 hour | 🔥🔥 |
| 7 | Reusable browser profile | half day | 🔥🔥 |
| 8 | DKIM breaker integration | 1 hour | 🔥 |

**Recommended ship order:** 3 → 1 → 2 → 4 → 5 → 6 → 7 → 8

- #3 is a 2-hour change that prevents "TypeError: Failed to fetch" from killing orders — biggest immediate win
- #1 unlocks #5 and #8 (you need per-mailbox state to do proper breakers)
- #2 is a 1-day change that fixes the "MFA prompt" complaint at the source
- The rest are polish

---

## What to tell the user

**Honest status:** the happy path works. Three layers of hardening turn it from "works most of the time" into "works unless Microsoft is having a really bad day." The biggest single change is the per-mailbox state machine — it turns worker crashes from "lose everything" into "resume from mailbox 48."

Want me to start with #3 (Graph retry classification, 2 hours) since it's the highest ROI per minute? Or do you want to review the plan first?
