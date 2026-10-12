# Status (update every build)

**Last updated:** 2026-10-12 (v0.4.0 tracking references, Cc mailbox, email-based times) · **Version:** 0.4.0 (test/pilot) · **Target:** owner's Unraid test server via GitHub image. Azure not in use.

## Works and has been verified
- API typechecks and builds; 35 automated tests pass (`npm test`; v0.4.0 added reference check character, email-date rules, tracking-mailbox matching and trust rules, review inbox, closure details): TOTP vector, signed links, tamper detection, auth/lockout/CSRF, full report lifecycle, inbound email webhook, affects-me rules and admin toggle, privacy/blurring/private reports, EXIF stripping, data export/erasure, admin link duplicates + roles, KPI maths.
- Web app builds (`vite build`). Smoke-tested in a browser with demo data: login, community feed, report form, incident page, notifications, profile, scorecard, all admin pages. No console errors. Screenshots taken.
- Sleep-mode gate (start page, 503 "asleep", status/wake endpoints, normal startup) tested locally.

## Not verified (assume it needs testing)
- **v0.4.0:** the new screens (email panel with Cc, case reference, email-time notes on the timeline, "Closure details not provided" banner and follow-up, Admin > Mail, new settings) compile and the API is tested, but they have **not been looked at in a browser**.
- **Tracking mailbox in real life:** `POST /api/inbound/tracking` has only been exercised with test payloads. Needs a real mailbox rule/Power Automate flow (secret header, ideally raw `message/rfc822`), real Gmail/Outlook Cc copies and a real Dubai Holding reply to confirm authentication results and dates arrive as expected. The raw-message parser covers common multipart and forwarded `.eml` cases only.
- Community code, tracking mailbox address and management sender domains must be set in Admin > Settings before the Cc and reply-all routes work.
- v0.3.1 (bottom Report button removed) is the first change used to test GitHub > Watchtower auto-update; confirm the strip shows v0.3.1.
- Add-to-home-screen prompt on real iPhone / Android / Huawei phones (new 2026-10-10). Sign-up with no invite code, approval for every request.
- Version strip, Admin > System and the Watchtower notification feed (new 2026-10-10; the shoutrrr URL syntax is untested against real Watchtower).
- **Not run on Unraid / Docker** (Dockerfile, `docker-compose.unraid.yml`, Watchtower, `publish-image.yml`). First real run may need fixes.
- **Azure Bicep, backups job, sleep-mode permissions, `infra.yml`/`deploy.yml`**: written, never validated or deployed.
- Real email sending (SMTP/ACS), inbound email webhook wiring, photo upload from a real phone camera (permission fix 2026-10-09, awaiting confirmation), GPS on a phone, push of reminders over time, browser BYO-AI calls with real keys.
- Postgres in practice (tests and demo run on SQLite).
- Nothing has been reviewed by a lawyer.

## Open items before real residents use it
- v0.4.0 decisions waiting on the owner: how photos reach management (mailto cannot attach; links are the only exception to login-only), whether to show "Other residents have also reported this issue: N" (setting, off), Cc tracking mailbox on by default (it is), mailbox and community code naming. Resident-side "inbox to review" is not built (admins review). Face redaction / small-model detection are **not built** and not yet approved.
- Notice/legal wording is intentionally not in the app (see docs/review-sheet-notice-wording.md); counsel to check "This report is being tracked" and the Cc.
- Insights panel, richer scorecard and My reports strip are new and untested on real data.
- Decide whether to offer a logged-out public scorecard (needs legal review).
- Report form offers only Maintenance / Security for now (detailed categories kept in the data model for later).
- Lawyer review of the new Terms of use (/terms) and name the operating entity in it.
1. Set the real management company email (currently placeholder `management@example.com`; use your own address while testing).
2. Lawyer review: privacy notice text, scorecard wording (defamation risk), consent flow, cross-border points (see docs/privacy-pdpl.md).
3. HTTPS in front of the app (needed for GPS and secure cookies).
4. Wire inbound management replies (shared mailbox rule / Power Automate posting to `/api/inbound/email` with `x-inbound-secret`).
5. Decide invite code, enable admin MFA, remove demo data.
6. Import the owner's existing issues list (CSV; see docs/admin-guide.md) - **list not yet received**.
7. Test a restore of the database and photos.

## Known limitations / gaps
- Link previews are generic; signed photo links in emails are viewable by anyone holding the link until they expire (30 days by default).
- No email verification at sign-up (invite code is the gate); no phone OTP/SSO.
- No web push; reminders are in-app notifications and email.
- No offline report queue; no automatic face/number-plate blurring.
- Single app instance only (in-process scheduler). Reminders and email retries only run while the app is awake.
- "Please log separately" interpreted as Keep private + warnings (not a separate private-ticket product).
- English only; no Arabic/RTL.
- Dev-only `npm audit` notices (vitest/vite tooling).

## Next steps (suggested)
Push to GitHub -> check Publish image succeeds -> start on Unraid -> add HTTPS tunnel -> create admin -> invite 3-5 testers -> collect feedback -> import existing issues -> then legal review and Azure.
