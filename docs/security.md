# Security overview

- Passwords: scrypt (N=32768), 12+ chars, lockout after 5 failures in 15 min, generic login errors.
- Sessions: HS256 JWT in httpOnly, SameSite=Lax, Secure cookie; per-user `token_version` revokes all sessions on password change/reset.
- CSRF: state-changing calls require `X-Requested-With: neighbourhood`; CORS is same-origin only.
- MFA: TOTP (RFC 6238) with one-time recovery codes; required for admins in production.
- Headers: helmet with strict CSP; rate limits on auth, uploads and API.
- Uploads: re-encoded with sharp (EXIF/GPS dropped), size-limited, stored private; served only via signed expiring links.
- Roles: resident, committee (read-only, blurred), admin, super_admin. Every admin action is audit-logged.
- Tamper evidence: each incident's event log is hash-chained; admins can verify it.
- Secrets: env/Container Apps secrets (32+ chars enforced in production). Move to Key Vault references when ready.
- Azure: managed identity for Blob and ACR; no storage keys; TLS only; backups in-country.
- Known gaps for v1: no email verification at sign-up (invite code is the gate); Postgres allows Azure services via firewall (move to private networking for production); dev-only npm audit notices in vitest/vite tooling.


## Share links
Anyone holding a share link can see the report's title, building, resident count and first photo in the link preview (like any shared link), and must sign in to see or do anything else. Private and withdrawn reports never produce previews. Rotating `FILE_SIGNING_SECRET` invalidates all share links and photo links.
