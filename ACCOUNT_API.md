# Account API (Free / Paid)

These endpoints are **unauthenticated** and meant for internal automation. Use them to create or upgrade accounts.

Base URL (local)
- `http://localhost:3000/api/auth`

Plan values
- `free`
- `paid`
- `25` (review reward)
- `50` (review reward)
- `100` (review reward)

---

## Create Account
Create a user with a specific plan.

Endpoint
- `POST /api/auth/create`

Body
```json
{
  "email": "user@domain.com",
  "password": "StrongPass123!",
  "plan": "free"
}
```

Response (success)
```json
{
  "success": true,
  "id": 12,
  "email": "user@domain.com",
  "plan": "free"
}
```

Errors
- `400` missing fields
- `409` account already exists

---

## Upgrade Account
Upgrade a user to **paid**. If the account does not exist, it will be created as **paid**.

Endpoint
- `POST /api/auth/upgrade`

Body
```json
{
  "email": "user@domain.com",
  "password": "StrongPass123!"
}
```

Response (upgraded)
```json
{
  "success": true,
  "email": "user@domain.com",
  "plan": "paid",
  "upgraded": true
}
```

Response (created)
```json
{
  "success": true,
  "id": 13,
  "email": "user@domain.com",
  "plan": "paid",
  "created": true
}
```

Errors
- `400` missing fields
- `401` invalid credentials when user exists

---

## Downgrade Account
Downgrade an existing account to **free** (payment failed, etc).

Endpoint
- `POST /api/auth/downgrade`

Body
```json
{
  "email": "user@domain.com"
}
```

Response (success)
```json
{
  "success": true,
  "email": "user@domain.com",
  "plan": "free",
  "downgraded": true
}
```

Errors
- `400` missing email
- `404` account not found

---

## Set Plan (Review Rewards)
Set a user's plan to `25`, `50`, or `100` after a review is verified.

Endpoint
- `POST /api/auth/set-plan`

Body
```json
{
  "email": "user@domain.com",
  "plan": "25"
}
```

Response (success)
```json
{
  "success": true,
  "email": "user@domain.com",
  "plan": "25",
  "updated": true
}
```

Errors
- `400` missing fields
- `404` account not found

---

## Notes
- The app UI still uses login sessions; these endpoints are for account creation/upgrade only.
- Free/review accounts are limited to **one completed order** (100 mailboxes).
- Logs are masked for all non‑paid plans.
- Download access:
  - `free`: all mailboxes masked.
  - `25`: first 25 visible, remaining masked.
  - `50`: first 50 visible, remaining masked.
  - `100`: all 100 visible.
