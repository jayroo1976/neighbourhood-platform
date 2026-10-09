# Status (update every build)

**Last updated:** 2026-10-04 (generalised to "management company"; tests re-run) · **Version:** 0.1.0 (test/pilot) · **Target:** owner's Unraid test server via GitHub image. Azure not in use.

## Works and has been verified
- API typechecks and builds; 22 automated tests pass (`npm test`): TOTP vector, signed links, tamper detection, auth/lockout/CSRF, full report lifecycle, inbound email webhook, affects-me rules and admin toggle, privacy/blurring/private reports, EXIF stripping, data export/erasure, admin link duplicates + roles, KPI maths.
- Web app builds (`vite build`). Smoke-tested in a browser with demo data: login, community feed, report form, incident page, notifications, profile, scorecard, all admin pages. No console errors. Screenshots taken.
- Sleep-mode gate (start page, 503 "asleep", status/wake endpoints, normal startup) tested locally.

## Not verified (assume it needs testing)
- **Not run on Unraid / Docker** (Dockerfile, `docker-compose.unraid.yml`, Watchtower, `publish-image.yml`). First real run may need fixes.
- **Azure Bicep, backups job, sleep-mode permissions, `infra.yml`/`deploy.yml`**: written, never validated or deployed.
- Real email sending (SMTP/ACS), inbound email webhook wiring, photo upload from a real phone camera (permission fix 2026-10-09, awaiting confirmation), GPS on a phone, push of reminders over time, browser BYO-AI calls with real keys.
- Postgres in practice (tests and demo run on SQLite).
- Nothing has been reviewed by a lawyer.

## Open items before real residents use it
- Lawyer review of the new Terms of use (/terms) and name the operating entity in it.
1. Set the real management company email (currently placeholder `management@example.com`; use your own address while testing).
2. Lawyer review: privacy notice text, scorecard wording (defamation risk), consent flow, cross-border points (see docs/privacy-pdpl.md).
3. HTTPS in front of the app (needed for GPS and secure cookies).
4. Wire inbound management replies (shared mailbox rule / Power Automate posting to `/api/inbound/email` with `x-inbound-secret`).
5. Decide invite code, enable admin MFA, remove demo data.
6. Import the owner's existing issues list (CSV; see docs/admin-guide.md) - **list not yet received**.
7. Test a restore of the database and photos.

## Known limitations / gaps
- No email verification at sign-up (invite code is the gate); no phone OTP/SSO.
- No web push; reminders are in-app notifications and email.
- No offline report queue; no automatic face/number-plate blurring.
- Single app instance only (in-process scheduler). Reminders and email retries only run while the app is awake.
- "Please log separately" interpreted as Keep private + warnings (not a separate private-ticket product).
- English only; no Arabic/RTL.
- Dev-only `npm audit` notices (vitest/vite tooling).

## Next steps (suggested)
Push to GitHub -> check Publish image succeeds -> start on Unraid -> add HTTPS tunnel -> create admin -> invite 3-5 testers -> collect feedback -> import existing issues -> then legal review and Azure.
