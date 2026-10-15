# Security overview

- Passwords: scrypt (N=32768), 12+ chars, lockout after 5 failures in 15 min, generic login errors.
- Sessions: HS256 JWT in httpOnly, SameSite=Lax, Secure cookie; per-user `token_version` revokes all sessions on password change/reset.
- CSRF: state-changing calls require `X-Requested-With: neighbourhood`; CORS is same-origin only.
- MFA: TOTP (RFC 6238) with one-time recovery codes; required for admins in production.
- Headers: helmet with strict CSP; rate limits on auth, uploads and API.
- Uploads: covered and re-drawn on the phone first (faces pixelated, metadata removed), then re-encoded with sharp (EXIF/GPS dropped), size-limited, stored private; served only via signed expiring links.
- CSP exception, isolated: the on-device face detector needs `unsafe-eval` for its WebAssembly glue. It runs only in the hidden same-origin page `/face/face-worker.html`, which has its own CSP (`default-src 'none'`, `connect-src 'self'`, framed only by our app, no inline scripts). The main app's CSP does not allow `unsafe-eval`. The page only receives pixel data and returns box coordinates over postMessage (same-origin checked).
- Roles: resident, committee (read-only, blurred), admin, super_admin. Every admin action is audit-logged.
- Tamper evidence: each incident's event log is hash-chained; admins can verify it.
- Secrets: env/Container Apps secrets (32+ chars enforced in production). Move to Key Vault references when ready.
- Azure: managed identity for Blob and ACR; no storage keys; TLS only; backups in-country.
- Known gaps for v1: no email verification at sign-up (invite code is the gate); Postgres allows Azure services via firewall (move to private networking for production); dev-only npm audit notices in vitest/vite tooling.


## Share links
Anyone holding a share link can see the report's title, building, resident count and first photo in the link preview (like any shared link), and must sign in to see or do anything else. Private and withdrawn reports never produce previews. Rotating `FILE_SIGNING_SECRET` invalidates all share links and photo links.


## Home Assistant (AirCon tab)
The app only ever calls `GET /api/states/<entity>` (and, for imported `source:name` ids, the read-only `recorder/*statistics*` WebSocket commands) on the configured `HA_URL`, from the server, with `HA_TOKEN`. The token, address and entity ids are never sent to browsers (a test checks this). Entity ids must match `domain.name`, so configuration cannot redirect the request path. A long-lived HA token carries its user's permissions and HA cannot limit a token to certain entities: create a **dedicated non-admin Home Assistant user** for it, keep the token only in the Unraid `.env`, and revoke it in HA if it leaks. Do not expose HA to the internet for this; the app container only needs to reach it on your LAN.

## Sign-up control
Pending and declined accounts cannot sign in (checked after the password, so it does not reveal which emails exist to strangers). Admins are created or promoted only by super admins. Set-password links for added people expire after 7 days and are single use. Every approval, decline and creation is written to the audit log.

## Smell reports
Admin routes (`/api/admin/odour*`) require the admin or super_admin role (committee and residents get 403, tested). The neighbour summary is built server-side from counts and contains no level, flat, note or user id (tested by scanning the response). Input is validated against the tower plan and the community's buildings; the observed time cannot be in the future or over a year old; a daily cap (counting deleted reports) limits abuse; notes are plain text (React escapes them) and CSV cells starting with `= + - @` are prefixed with `'`. CSV export and admin delete are audit-logged. Rate limits and CSRF header apply as for other routes.
