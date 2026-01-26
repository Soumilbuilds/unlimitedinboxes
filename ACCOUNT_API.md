# Account API (Free / Paid)

These endpoints are **unauthenticated** and meant for internal automation. Use them to create or upgrade accounts.

Base URL (local)
- `http://localhost:3000/api/auth`

Plan values
- `free`
- `paid`

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

## Notes
- The app UI still uses login sessions; these endpoints are for account creation/upgrade only.
- Free accounts are limited to **one order** (100 mailboxes).
- Free accounts see **masked mailbox emails** in logs and cannot download the real list.
