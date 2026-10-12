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
Since v0.4.0 link previews are always generic, so a share link reveals nothing about a report to anyone who is not signed in. Signed photo links in emails to management are the one exception to "nothing is public": anyone holding one can view that photo until it expires. Rotating `FILE_SIGNING_SECRET` invalidates all share links and photo links.


## Sign-up control
Pending and declined accounts cannot sign in (checked after the password, so it does not reveal which emails exist to strangers). Admins are created or promoted only by super admins. Set-password links for added people expire after 7 days and are single use. Every approval, decline and creation is written to the audit log.


## Tracking mailbox (v0.4.0)
`POST /api/inbound/tracking` needs the shared secret (timing-safe compare). A tracking reference is guessable by design (community code, month, sequence, one check character), so it is only a filing aid. Management replies are accepted only from configured sender domains, only when SPF/DKIM/DMARC passes (taken from the Authentication-Results header your own mailbox adds) and only when they match an existing case. Resident mail must come from a member on that case. Anything else is held for a person. Email date headers are controlled by the sender, so times from emails are recorded with their source and the receipt time is stored separately and never changed.
