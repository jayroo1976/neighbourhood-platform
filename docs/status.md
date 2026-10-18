# Status (update every build)

**Last updated:** 2026-10-16 (AirCon old-reading limit 120 min) · **Version:** 0.8.0 (test/pilot) · **Target:** owner's Unraid test server via GitHub image. Azure not in use.

## Works and has been verified
- API typechecks and builds; 47 automated tests pass (`npm test`): Smells tab (floor-plan mapping, validation, daily limit, neighbour view hides flats and small counts, admin-only, CSV safety, switch off, export, erasure, demo wipe); TOTP vector, signed links, tamper detection, auth/lockout/CSRF, full report lifecycle, inbound email webhook, affects-me rules and admin toggle, privacy/blurring/private reports, EXIF stripping, data export/erasure, admin link duplicates + roles, KPI maths, AirCon tab (good/fair/poor bands, tower prefix expansion, admin on/off, imported hourly statistics, fake Home Assistant: °F conversion, unavailable/old sensors, cache, unreachable, sign-in required, nothing sensitive in the response).
- Web app builds (`vite build`). Smoke-tested in a browser with demo data: login, community feed, report form, incident page, notifications, profile, scorecard, all admin pages. No console errors. Screenshots taken.
- On-device photo check (2026-10-15), tested in headless Chromium against the running server: faces covered, manual boxes add/remove/undo, only the covered JPEG uploaded with no EXIF/XMP, unreadable file uploads nothing, missing detector files gives a warning but still allows manual covering, no outside requests. Scorecard page renders with the new panels and no console errors.
- Sleep-mode gate (start page, 503 "asleep", status/wake endpoints, normal startup) tested locally.

## Not verified (assume it needs testing)
- **AirCon v0.9.1 layout** (2026-10-18): table (four rows) fits 360 and 390 px wide in headless Chromium; tower tiles are temperature and humidity only (extra uHoo sensors are still returned by the API but not drawn). Not re-checked on James's phone.
- **AirCon hidden MR 2 view, dew point and moisture charts, all-towers table and print button** (2026-10-18): checked with a fake Home Assistant in tests and headless Chromium (desktop, phone width, printed PDF). Not against the real HA, not the browser print dialog on a real phone. Dew point and moisture are calculated from temperature and humidity, not measured. The hidden view is a display choice only; the figures are still in the `GET /air` answer.
- **AirCon all-tower charts, tile layout and last-known fallback** (2026-10-16): checked with mock data in headless Chromium and a fake Home Assistant in tests. Not against the real HA history for the uHoo entities or the `tower1:*` statistics, not on real phones. Needs HA to hold 72 hours of history for each sensor; a sensor with none shows no fallback. Chart wording is not lawyer-reviewed.
- **Smells tab** (2026-10-15): checked on SQLite and in headless Chromium only. Not on real phones, not on Postgres (migration `008_odour_reports`). The flat layout (11 flats a level, 5 penthouses, 7 townhouses per block, blocks 1-3) is from James's plans and a guess for the townhouses: confirm. Wording not lawyer-reviewed.
- **AirCon gauges** (2026-10-16): the reference bands (uHoo, WHO 2021, US EPA) are not lawyer-reviewed and the Fair margins for temperature and humidity are our own. The mould and influenza index bands are assumed to match the virus index. Tower 2 nitrogen dioxide currently reads Poor: confirm the sensor before residents rely on it.
- **AirCon tab against the real Home Assistant** (2026-10-15): built and checked only against a fake HA, including the WebSocket statistics read for `tower1:*` ids (the exact ids come from screenshots). Needs the real URL, a non-admin token, the real entity ids, and a check that the Unraid app container can reach HA.
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
