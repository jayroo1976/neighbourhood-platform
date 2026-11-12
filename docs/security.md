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


## Outside station collector
The `collector` container makes one outbound https request per cycle to `OUTSIDE_SOURCE_URL` (set by the operator, never by a resident; a non-https address is refused), with a 20 s timeout and an 8 MB size limit, and announces itself with a descriptive User-Agent. It has no inbound port and no resident data. For the sensor history copy it holds the same read-only Home Assistant token as the app (use the dedicated non-admin HA user described below) and only reads long-term statistics for the ids listed in `HA_AIR_SENSORS`; it needs the database address and the app's secrets only because they share one configuration module. The page content is only parsed, never executed or stored (a failed parse stores a short summary of what the page contained, a few short snippets, in the system log). **Open item:** IQAir's website terms may not permit automated fetching; check them (or switch to their API under a licence) before relying on this beyond the test. Polling is every 20 minutes at most.

## Home Assistant (Fresh air monitoring tab)
The `range` query parameter of `GET /api/air` is checked against a fixed list (day, week, month, all); anything else becomes day, so it never reaches Home Assistant as input. The one-off `tools/ha-import-statistics.py` needs a long-lived token: pass it only in the `HA_TOKEN` environment variable, never in the repo.
The app only ever calls `GET /api/states/<entity>` (and, for imported `source:name` ids, the read-only `recorder/*statistics*` WebSocket commands) on the configured `HA_URL`, from the server, with `HA_TOKEN`. The token, address and entity ids are never sent to browsers (a test checks this). Entity ids must match `domain.name`, so configuration cannot redirect the request path. A long-lived HA token carries its user's permissions and HA cannot limit a token to certain entities: create a **dedicated non-admin Home Assistant user** for it, keep the token only in the Unraid `.env`, and revoke it in HA if it leaks. Do not expose HA to the internet for this; the app container only needs to reach it on your LAN.

## Public fresh-air page
`GET /api/public/air` is the one data route that needs no session. It is off unless an admin ticks the setting, rate limited (30 a minute per address), returns only sensor readings (hidden towers stripped on the server, no entity ids or tokens), sets `noindex`, and does not change anything. It reuses the cached Home Assistant read, so a flood of requests cannot multiply calls to Home Assistant beyond the cache. Residual risk: the link is guessable (`/fresh-air`), so treat the data as public once enabled.

## Sign-up control
Pending and declined accounts cannot sign in (checked after the password, so it does not reveal which emails exist to strangers). Admins are created or promoted only by super admins. Set-password links for added people expire after 7 days and are single use. Every approval, decline and creation is written to the audit log.

## Smell reports
Admin routes (`/api/admin/odour*`) require the admin or super_admin role (committee and residents get 403, tested). The neighbour summary is built server-side from counts and contains no level, flat, note or user id (tested by scanning the response). Input is validated against the tower plan and the community's buildings; the observed time cannot be in the future or over a year old; a daily cap (counting deleted reports) limits abuse; notes are plain text (React escapes them) and CSV cells starting with `= + - @` are prefixed with `'`. CSV export and admin delete are audit-logged. Rate limits and CSRF header apply as for other routes.

## Exports and printing
Every report download (incident CSV and Excel, smells CSV and PDF) is admin or super admin only, checked on the server and audit-logged (`export_csv`, `export_xlsx`, `odour_export_csv`, `odour_export_pdf`). The Print / save as PDF buttons are shown to admins only and a non-admin who prints gets a notice instead of the page; this is a deterrent, not a control, since screens can be captured. A resident can download their own data from their profile.
