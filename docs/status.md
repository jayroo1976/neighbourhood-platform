# Status (update every build)

**Last updated:** 2026-10-15 (Smells tab) · **Version:** 0.6.1 (test/pilot) · **Target:** owner's Unraid test server via GitHub image. Azure not in use.

## Works and has been verified
- API typechecks and builds; 41 automated tests pass (`npm test`): Smells tab (floor-plan mapping, validation, daily limit, neighbour view hides flats and small counts, admin-only, CSV safety, switch off, export, erasure, demo wipe); TOTP vector, signed links, tamper detection, auth/lockout/CSRF, full report lifecycle, inbound email webhook, affects-me rules and admin toggle, privacy/blurring/private reports, EXIF stripping, data export/erasure, admin link duplicates + roles, KPI maths, Air tab (fake Home Assistant: °F conversion, unavailable/old sensors, cache, unreachable, sign-in required, nothing sensitive in the response).
- Web app builds (`vite build`). Smoke-tested in a browser with demo data: login, community feed, report form, incident page, notifications, profile, scorecard, all admin pages. No console errors. Screenshots taken.
- On-device photo check (2026-10-15), tested in headless Chromium against the running server: faces covered, manual boxes add/remove/undo, only the covered JPEG uploaded with no EXIF/XMP, unreadable file uploads nothing, missing detector files gives a warning but still allows manual covering, no outside requests. Scorecard page renders with the new panels and no console errors.
- Sleep-mode gate (start page, 503 "asleep", status/wake endpoints, normal startup) tested locally.

## Not verified (assume it needs testing)
- **Smells tab** (2026-10-15): checked on SQLite and in headless Chromium only. Not on real phones, not on Postgres (migration `008_odour_reports`). The flat layout (11 flats a level, 5 penthouses, 7 townhouses per block, blocks 1-3) is from James's plans and a guess for the townhouses: confirm. Wording not lawyer-reviewed.
- **Air tab against the real Home Assistant** (2026-10-15): built and checked only against a fake HA. Needs the real URL, a non-admin token, the real entity ids, and a check that the Unraid app container can reach HA.
- **Photo check on real phones** (iPhone Safari, Android Chrome, Huawei browser): speed of the 14 detection passes, memory on low-end phones, the ~7 MB first download on mobile data, drag-to-cover with a finger. **Face detection accuracy has not been measured** on realistic photos and there is no automatic number-plate detection. Needs a labelled test set and a recall target (checklist 5.12-5.15).
- The 13 Oct patches and legal-wording changes in the owner's download folder were not in GitHub; confirm they are applied on the real copy (see CHANGELOG 2026-10-15).
- Test-data loader `npm run seed:test` (2026-10-12): verified on local SQLite only; not yet run on the Unraid instance. See docs/admin-guide.md > Test data.
- v0.3.1 (bottom Report button removed) is the first change used to test GitHub > Watchtower auto-update; confirm the strip shows v0.3.1.
- Add-to-home-screen prompt on real iPhone / Android / Huawei phones (new 2026-10-10). Sign-up with no invite code, approval for every request.
- Version strip, Admin > System and the Watchtower notification feed (new 2026-10-10; the shoutrrr URL syntax is untested against real Watchtower).
- **Not run on Unraid / Docker** (Dockerfile, `docker-compose.unraid.yml`, Watchtower, `publish-image.yml`). First real run may need fixes.
- **Azure Bicep, backups job, sleep-mode permissions, `infra.yml`/`deploy.yml`**: written, never validated or deployed.
- Real email sending (SMTP/ACS), inbound email webhook wiring, photo upload from a real phone camera (permission fix 2026-10-09, awaiting confirmation), GPS on a phone, push of reminders over time, browser BYO-AI calls with real keys.
- Postgres in practice (tests and demo run on SQLite).
- Nothing has been reviewed by a lawyer.

## Open items before real residents use it
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
- No email verification at sign-up (invite code is the gate); no phone OTP/SSO.
- No web push; reminders are in-app notifications and email.
- No offline report queue. Faces are covered automatically on the phone (resident checks each photo); **number plates are covered by hand only**. A photo that cannot be decoded (some HEIC files) cannot be used.
- Single app instance only (in-process scheduler). Reminders and email retries only run while the app is awake.
- "Please log separately" interpreted as Keep private + warnings (not a separate private-ticket product).
- English only; no Arabic/RTL.
- Dev-only `npm audit` notices (vitest/vite tooling).

## Next steps (suggested)
Push to GitHub -> check Publish image succeeds -> start on Unraid -> add HTTPS tunnel -> create admin -> invite 3-5 testers -> collect feedback -> import existing issues -> then legal review and Azure.
