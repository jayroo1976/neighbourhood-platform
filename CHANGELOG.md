# Changelog (newest first)

## 2026-10-16 - AirCon: same-size main tiles, small sensor tiles, 24-hour comparison chart (v0.8.1)
- Every tower now shows Fresh-air temperature and humidity as the same two large tiles (MR 2 was shrinking them to fit its extra sensors). The extra uHoo sensors (CO2, PM2.5, VOC, CO, NO2, ozone, pressure, virus, influenza, mould) sit in a row of small tiles underneath, with a short "Read 21:08" note instead of the long one.
- New chart per tower: the last 24 hours (hourly averages) of temperature and humidity, plus one other sensor chosen with a button (default: carbon dioxide). Each line is scaled to its own 24-hour range so the shapes can be compared; the real range and the exact value for any hour (point at it, or arrow keys) are written beside it. Towers with only temperature and humidity get the two-line chart. Plain SVG, no new library.
- API: `GET /air` adds `towers[].history` (`hours` = 25 hour-start timestamps, `series` = hourly values per sensor, null where no reading). Live sensors come from one Home Assistant `GET /api/history/period` call (minimal_response, °F converted); imported `source:name` statistics come from the WebSocket statistics call. Failures are swallowed: no history just means no chart. Cached with the rest of the answer.
- Tests: 48 pass (new history test, one request count updated 6 to 7). Typecheck and build pass. Rendered in headless Chromium with mock data at desktop and phone widths; main tiles measured identical in all three towers.
- Untested: against the real Home Assistant (history for the real uHoo entities and the `tower1:*` imports), on real phones.

## 2026-10-16 - v0.8.0: AirCon shows every uHoo reading with a Good / Fair / Poor gauge
- Each tower on the AirCon tab can now show all the readings a uHoo monitor reports: carbon dioxide, PM2.5 (fine dust), volatile organic compounds, carbon monoxide, nitrogen dioxide, ozone, air pressure, and the virus, influenza and mould indices, as well as temperature and humidity. Each rated reading has a **gauge**: a bar split into good / fair / poor bands with a marker at the reading, and the band written out in words (colour is never the only signal). A tile with an old reading shows "Old reading" instead of a band. VOC and pressure are shown but **not rated** (no single agreed indoor reference). Outside readings are not rated.
- **Definitions are shown**: a "How Good, Fair and Poor are decided" section at the bottom of the page lists every band and where it comes from (uHoo's ideal ranges and Virus Index white paper, WHO 2021 guidelines, US EPA standards), and says these are not health findings or a legal standard. The same definitions come from `GET /api/air` (`scales`). Fair margins for temperature and humidity are our own choice and are labelled as such. Bands live in `api/src/services/airScales.ts`.
- **Short config:** a tower can now be written `{"name":"MR 2","prefix":"sensor.outside_tower_2_fresh_air_"}`; the prefix expands to every uHoo sensor id (`..._carbon_dioxide`, `..._pm2_5`, `..._volatile_organic_compounds`, `..._mold_index` and so on). Explicit `temperature`, `humidity` and `metrics` entries still win over the prefix. A sensor that does not exist in Home Assistant is left out rather than shown as "not reporting".
- 47 tests pass (new: prefix expansion, ratings per sensor, missing sensors left out, config validation, band boundaries). Checked in headless Chromium against a fake Home Assistant on phone and desktop width, no console errors.
- **Check before residents see it:** the Tower 2 nitrogen dioxide reading (about 141 ppb) rates **Poor** against the 100 ppb band. That may be real or a sensor/placement effect; the sensors are not calibrated or certified. If in doubt, switch the AirCon tab off in Admin > Settings > Resident tabs until it is understood. **Not tested against the real Home Assistant.** The uHoo bands for mould and influenza indices are assumed to match the virus index (1-3 good, 4-6 moderate, 7-10 bad). Wording not lawyer-reviewed.

## 2026-10-15 - v0.7.0: "Air" is now AirCon; admins can switch the AirCon and Smells tabs on or off; MR 1 imported readings
- **Renamed Air to AirCon** (tab, page heading and docs). The route `/air`, `GET /api/air` and the `HA_*` settings are unchanged.
- **Admin > Settings > Resident tabs** (new panel at the top): two tick-boxes, **Smells tab** (the existing `odour_enabled`, moved here from the Smell reports panel) and **AirCon tab** (new setting `aircon_enabled`, default on). Off hides the tab from residents; nothing is deleted. AirCon only shows when it is ticked **and** Home Assistant is configured (`config.air_enabled` on `/api/auth/me` is both). With it off, `GET /api/air` answers `{enabled:false, switched_off:true}` and the page says AirCon has been switched off. `GET /api/admin/settings` now also returns `aircon_available` so the panel can say when Home Assistant is not connected.
- **Imported statistics (option 1):** `HA_AIR_SENSORS` ids shaped `source:name` (for example `tower1:fresh_air_temperature`) are read as Home Assistant **imported long-term statistics** over its WebSocket API (`recorder/statistics_during_period`), not as entities. These are hourly averages, so the tile reads "Hourly average, hour from HH:MM" and counts as old after 3 hours. Ordinary `sensor.x` ids still use the live REST read. Both can be mixed in one layout. No new dependency (Node 22 global WebSocket). If the WebSocket read fails, those tiles show "Sensor not reporting", the live ones are unaffected and the page shows the unreachable warning.
- 44 tests pass (new: admin switch off/on for AirCon, plus two imported-statistics tests with a fake HA WebSocket). **Not tested against the real Home Assistant**, so the MR 1 statistic ids are taken from James's screenshots. Not tested: the new panel on a real phone.
- To use MR 1: in the Unraid `.env` add to `HA_AIR_SENSORS` `{"name":"MR 1","temperature":"tower1:fresh_air_temperature","humidity":"tower1:fresh_air_humidity"}`; make sure the compose file passes `HA_URL`, `HA_TOKEN`, `HA_AIR_SENSORS` through, then Compose Up.

## 2026-10-15 - v0.6.1: Air tab shows outside humidity and the exact time of each last reading
- The Air tab now has an **Outside humidity** tile next to the outside temperature. In `HA_AIR_SENSORS` add `"humidity":"sensor.palm_outside_humidity"` inside `"outside"` (optional; without it the tile shows "Sensor not reporting").
- Every figure (outside and each tower) now shows **Last read 22:04 (3 min ago)**, with the date and time in Asia/Dubai taken from Home Assistant's own `last_updated`. A sensor that reports `unavailable` shows "Sensor not reporting. Last seen ..." and old readings are labelled "old reading".
- API: `/api/air` outside block gained `humidity`. 30 tests pass (outside humidity and the exact timestamp are now asserted). Not run against the real Home Assistant yet.

## 2026-10-15 - v0.6.0: Smells tab (odour reports and a map of affected flats)
- New **Smells** tab for residents: log a smell against a home (building, level, flat, what it is like, strength, where, how often, when, optional note). Towers use the floor plan James supplied: levels 1-13 with **11 flats a level** (1-5 along one side, 6 at the end, 7-11 along the other; types D C C C B A B C C C D, so D = flats 1 and 11) plus a **penthouse** level (F1, F2, G1, G2, H). Townhouses are logged by block and number. The flat is picked on a tappable row where the letter is the flat type; a "1204"-style apartment number pre-selects level 12, flat 4. Residents see and can delete their own reports (a delete hides the report and erases its note; the row stays, hidden, so the daily limit still counts it). A "gas or burning: call 997 first" notice sits on the form.
- **Neighbours never see a flat.** The community view shows counts per building and per group of levels (1-4, 5-8, 9-13, penthouses), by smell type and by hour of day (Dubai time). A group or building with fewer than 3 reports is shown as "fewer than 3" and its detail is withheld. Notes and exact homes are only visible to the resident who wrote them and to admins.
- **Admin > Smells** (admins only; committee role is refused): plan view of every tower (levels from the top, flats 1-5 | 6 | 7-11, heat shading by number of reports), townhouse blocks, "patterns to look at" (same flat position on 3 or more levels = one vertical stack; 3 or more flats reporting on one level), filters (period, smell type, where noticed), tap a flat to filter the log, delete a report, **Download CSV** (formula-safe; each export and delete is written to the audit log).
- **Settings > Smell reports:** switch on/off (off hides the tab and refuses new reports; admins still see existing ones), reports per resident per day (default 10; deleting a report does not free a slot), townhouse blocks included (default 1, 2, 3) and townhouses per block (default 7). **Towers 4-6 are hidden** simply because they are not in the community's tower list (MR 1-3 only); remove or add a tower under Settings > Towers.
- New table `odour_reports` (migration `008_odour_reports`); new routes `/api/odour/*` and `/api/admin/odour/*`; `config.odour_enabled` on `/api/auth/me`. Data export now includes the resident's smell reports, account erasure deletes them, and Remove demo data deletes demo smell reports. `npm run seed` adds demo smell reports (MR 2 flat 4 on five levels, MR 1 level 6, townhouses) so the pattern view has something to show.
- 41 tests pass (11 new: floor-plan mapping, validation, daily limit, own-report delete, neighbour view never exposes level/flat/notes and suppresses small groups, admin-only access, CSV safety, audit, settings, switch off, export, erasure, demo wipe). Screenshot checked in headless Chromium (phone and desktop), no console errors. No new environment variables.
- **Assumptions to confirm:** 11 flats on every level of every tower; 5 penthouses with the unit names above on every tower; townhouse blocks 1-3 with 7 homes each (a guess). The standalone published odour-map artifact is separate and can be retired once this is in use.
- **Not tested:** real phones, the Postgres migration (SQLite only), accessibility with a screen reader on the flat picker, lawyer review of the wording (patterns are residents' reports, not a finding; the notice on the page says so).

## 2026-10-15 - v0.5.0: Air tab (fresh-air temperature and humidity per tower, outside temperature)
- New **Air** tab for signed-in residents: fresh-air temperature and humidity for each tower, and the outside temperature, from the owner's Home Assistant. Refreshes every minute. Each figure shows how long ago it was updated; a sensor that is unavailable, missing or silent for 30 minutes is shown as "Sensor not reporting" or "Old reading". Wording is factual ("readings from sensors, shown as recorded").
- Server-side and read-only: the API calls `GET /api/states/<entity>` on Home Assistant with a token kept in the server environment; the browser never sees the token, address or entity ids. Answers are cached for `HA_CACHE_SECONDS` (60). If HA cannot be reached the tab says so and shows the last good figures marked old. °F is converted to °C.
- **Off by default.** Needs `HA_URL`, `HA_TOKEN` and `HA_AIR_SENSORS` (one-line JSON mapping towers to entity ids). Invalid JSON or an entity id not shaped `domain.name` leaves it off. The nav entry appears only when it is on (`config.air_enabled` on `/api/auth/me`). `docker-compose.unraid.yml` now passes the three variables through. New `GET /api/air` (sign-in required, no-store).
- 30 tests pass (5 new, with a fake Home Assistant). Screenshot checked in headless Chromium on a phone-sized screen.
- **Not tested against the real Home Assistant.** Entity ids are not known yet, and the Unraid app container must be able to reach HA on the LAN. Use a dedicated non-admin HA user for the token (HA cannot limit a token to specific entities). No live history or charts yet.

## 2026-10-15 - v0.4.0: photos are checked and faces covered on the phone before upload; scorecard additions
**Photo check on the device (new)**
- Every photo (report, "affects me too", resolution photos) now opens a **Check your photo** screen before anything is uploaded. Faces are found and covered automatically with heavy pixelation (about 6 blocks across, plus a 30% margin). The resident sees exactly what will be sent, can **drag a box** over anything else (number plates, children, papers, screens), **tap a box to remove it**, and undo. Only the covered image is uploaded; the original never leaves the phone. Re-drawing also removes all metadata (EXIF, GPS, embedded thumbnails). The server still re-encodes with sharp as before.
- Detector: Google MediaPipe BlazeFace (Apache-2.0), full-range model, run on the whole photo plus overlapping 2x2 and 3x3 tiles so small or distant faces are caught. **Number plates are not detected automatically yet** (manual box only). Files are **self-hosted** (`/mediapipe/face_detection/`, copied from node_modules by `web/scripts/copy-face-model.mjs` at dev/build time and git-ignored); no photo and no request goes to a third party. First use downloads about 7 MB, then the browser caches it (7 days).
- **Isolated page.** The detector's WebAssembly glue needs `unsafe-eval`, which the app must not allow. It therefore runs in a hidden same-origin page `/face/face-worker.html` with its own Content-Security-Policy (set in `api/src/app.ts`; no network except our own origin, framed only by the app). The main app keeps its strict CSP unchanged. The page receives pixels via postMessage and returns box coordinates.
- **Fails safe.** If the photo cannot be decoded (for example some HEIC files) nothing is uploaded and the resident is told to retake or choose a JPEG/PNG. If the face detector cannot start, the resident gets a warning and covers faces by hand; the original is still never uploaded. The old `shrinkImage` helper (which could send the original) was removed.
- Warning text on the report form updated. Own-AI drafting (optional, off by default) now only ever sees the covered photo.
- **Checked** in headless Chromium on the app server: 4 faces found in a sample portrait (one false alarm removed by tap), manual box add / tap-remove / undo, one upload only, no Exif/XMP in the uploaded bytes, unreadable file uploads nothing, detector files missing gives the warning and still allows manual covering, no request to any outside host. **Not checked on real phones**: speed (14 detection passes per photo; about 10 s in a software-rendered test browser, expected much faster on a phone GPU), memory on low-end Android, iPhone Safari, Huawei browser. Accuracy has **not** been measured on realistic photos (corridors, car parks, lifts, evening shots); do not claim it removes all faces.

**Scorecard additions (from data already stored; no schema change)**
- New tiles/panels on the scorecard: **fixes that held first time** (verified fixed and never reopened), **median time to management closure**, **median reply time by priority** (safety-risk row shows the safety-priority response), **did the problem come back?** (30/60/90 day recurrence, only closures whose window has fully passed), **where reports cluster** (tower plus a general area such as Lift or Car park, at least 2 reports, private reports excluded, no apartment or bay numbers), and **evidence behind these figures** (share with photo, case number, management reply, GPS). Also `resolution.verified_share` in the API.
- Wording changed to match the 13 Oct legal review status: page title **Response scorecard**, banner "Resident-recorded information, not a finding", "Closures disputed by residents" (tile, panel and definition). Still not reviewed by a lawyer.
- Not built (needs data we do not store): reports per 100 units, contractor performance, resident satisfaction, "confirmed fixed" action, closure detail scoring (cause/repair/prevention).
- 25 tests pass (new test covers first-time fix, recurrence windows, hotspots, evidence, safety reply time and area mapping). No new environment variables.
- **Repo note:** the 13 Oct patches in the owner's download folder (`app-changes-2026-10-13.patch`, `whatsapp-share-message.patch`) and the rewritten privacy notice/terms were **not in GitHub** when this was built; they apply cleanly on top of this change except for overlapping lines in `CHANGELOG.md`, `docs/status.md` and `web/src/ui.tsx`.

## 2026-10-12 - Test-data loader (18 TEST reports with photos, tower "MR Test", apartment Test01)
- New script `api/src/scripts/seed-test.ts` (`npm run seed:test -w api -- "<photo folder>"`) with manifest `api/src/scripts/test-data/incidents.json`. Loads 18 clearly-labelled reports (titles start "TEST - ", references `TEST-0001`..`TEST-0018`, management case numbers `TEST-SR-20xx`) using 65 supplied photos (max 4 per report), spread over every status (reported, case number received, in progress, management closed, resolved OK, resolved poor, reopened, withdrawn).
- Everything belongs to one test resident `test01@pilot.test` (tower **MR Test**, apartment **Test01**, flagged demo). "MR Test" is added to the community tower list.
- Reports are flagged `source=demo`, send **no email**, and go through the normal photo pipeline (EXIF stripped, thumbnails) and the tamper-evident event chain. Remove them with Admin > Data > Remove demo data (super admin). Refuses to run twice, and refuses in production unless `FORCE_SEED=true`.
- Needs an existing admin account (used as the actor for "in progress"). Photos are **not** stored in the repo.
- Checked locally on SQLite: 18 reports, 65 photos stored, 50 events with unbroken hash chains, no unclaimed uploads; 24 tests pass. **Not run against the Unraid instance.**

## 2026-10-12 - v0.3.1: removed the floating orange Report button from the bottom bar
- The orange "+ Report" button in the middle of the bottom navigation is gone (the big orange "Report an issue" button at the top of the home screen stays). Bottom bar is now Community, Alerts, Scores, Me/Admin. Also used as the test of the GitHub to Watchtower auto-update: the version strip should change to v0.3.1 and a new build number.

## 2026-10-10 - No invite code (admins approve one by one), add-to-home-screen prompt, email on "affects me too"
- **Invite code removed.** `REGISTRATION_CODE` and the invite-code box are gone (it was mandatory when approval was off, which blocked sign-up). Every self sign-up now waits for an admin to approve it under Admin > People. "Approve new sign-ups" now defaults to **on**, and migration `007_approval_default_on` turns it on for existing communities. An old `REGISTRATION_CODE` line in `.env` is simply ignored. Personal resident invite links still exist but only skip approval if "Trust residents' invite links" is switched on (default off). **Admin-added people and the admin you create from the command line are unaffected.**
- **Add to home screen.** First time someone is signed in on a phone browser (not already installed) a sheet explains how to add the app to the home screen, once. Also on the "Request sent" screen after signing up, and under Profile > Add to home screen. Android Chrome/Edge/Samsung: one-tap install button when the browser offers it, else menu steps. iPhone: Share > Add to Home Screen (Safari). Huawei browser: menu > Add to > Home screen. **Untested on real iPhone, Android and Huawei devices; the instructions follow each browser's usual menu wording and may differ slightly by version.** Browsers do not allow a site to add itself to the home screen without the person tapping, so this is a prompt plus steps.
- **"This affects me too" and email.** Already built: adding yourself gives you your own email to management (your tower/apartment, your photo) and a box for your own incident ID, listed under the report (admins see each neighbour's ID). Now the email app **opens automatically straight after you add yourself**, so it is one flow: tap, add, send, then enter your ID when management replies.
- 24 tests pass (new: approval is the default and an invite code is ignored).

## 2026-10-10 - Version strip on every page, and Admin > System (update history)
- **Version strip** at the very top of every page, e.g. `v0.3.0 - build 42 - 7164f7b`. Build number and commit are stamped into the image by the GitHub workflow (Dockerfile `ARG`s, `build-args` in `publish-image.yml`), so you can compare it with the build number shown on GitHub Actions to see whether Watchtower has updated you. Open pages check every 5 minutes and when the tab is re-opened; if the build changes a "New version available. Tap to reload" button appears. Admins can tap the strip to open System.
- **Admin > System** (new tab): version, build, commit, build time, running since, uptime, and a filterable history of "App started", "App updated" (version/build changed) and Watchtower messages. Staff-only `GET /api/admin/system`; public `GET /api/system/version` (answers even while the database is asleep).
- **Watchtower log feed:** the app cannot read Docker logs, so Watchtower now posts its notices to `POST /api/inbound/watchtower` (shared secret header `X-Watchtower-Secret`, new env `WATCHTOWER_SECRET`). The full raw log is still under Unraid > Docker > watchtower > Logs.
- Migration `006_system_events`; table keeps the newest 500 rows. Root version bumped to 0.3.0. 23 tests pass.
- **Untested against real Watchtower:** the `generic+http://...?template=json&@X-Watchtower-Secret=...` notification URL (shoutrrr syntax) was written from documentation, not run. If Admin > System shows no Watchtower lines after an update, the "App updated" lines still prove the new build is live; tell me what Watchtower's log says and I will adjust.
- **You must:** add `WATCHTOWER_SECRET=<any long random string>` to the `.env` on Unraid and re-apply the compose file (or add the variable to the app and watchtower containers).

## 2026-10-10 - More metrics: admin insights, scorecard, "My reports" at a glance
- **Admin > Reports: new Insights panel** (collapsible, last 90 days): open and overdue, no reply in time (median reply hours), closed-but-not-fixed, awaiting verification, reported and fixed this week versus last week, reopened after closure, residents (and how many are waiting for approval or have reported). Each alert tile has "Show these" to filter the list. Lists: waiting longest for a reply, saved but not yet emailed (resident never confirmed sending), open the longest, issues affecting the most homes. New staff-only endpoint `GET /api/admin/insights`.
- **Scorecard (resident view) gains:** This week vs last week, how fast management replies (under 4h / 4-24h / 1-3 days / over 3 days / no reply yet), a by-priority table (target days, open, overdue, median fix), issues affecting the most homes, residents who have reported, share of reports with a neighbour added, and the reopen rate after management closures. Still no names or apartment numbers.
- **My reports:** a summary strip on the "My reports" tab: reported by you, joined, still open, fixed, no case number yet, neighbours who joined yours, oldest open report.
- No migration. 22 tests pass (extended: resident-safe metrics, staff-only insights).
- Not done: a logged-out public page. The scorecard still needs a sign-in; say if you want a public, read-only version (it would need legal review of the wording first).

## 2026-10-10 - Simpler report form: Maintenance or Security
- The report form no longer shows 15 issue types. It asks one question, "What kind of issue?", with two choices, **Maintenance** (pre-selected) and **Security**, so a normal report is photo, title, send. Urgency stays.
- New category `maintenance` added; all older categories remain valid, so existing reports, imports, the scorecard category breakdown and the admin category editor are unchanged. Moderators can still re-categorise a report in Admin.
- Duplicate suggestions no longer filter by category (every new report is "maintenance" or "security", so filtering would hide matches with older, more specific reports). Own-AI photo drafting can only pick Security; anything else stays Maintenance.
- No migration needed. Tests: 22 pass. Easy to bring the detailed types back later by restoring the chip list in `web/src/pages/Report.tsx`.

## 2026-10-09 - Join request on the login page, data notice, terms of use
- **Login page:** a clear "Request to join" box (shows "Create an account" when approval is off). The form asks for name, email, tower, apartment and password.
- **"What we store" notice** on the sign-up form lists what is kept about you and who sees it, followed by two tick boxes: one for the privacy notice and data sharing, one for the terms of use. Both must be ticked; the server rejects sign-ups without them.
- **New Terms of use page (`/terms`)** written for the UAE: independent resident-run service, 18+ residents only, factual and lawful posts (defamation, privacy, cybercrime), moderation, scorecard wording, no emergency use, PDPL (Federal Decree-Law 45 of 2021), UAE law with Dubai courts. Draft pilot text, **needs lawyer review** before a wider launch. Operator entity is not named yet.
- Acceptance is stored per person (`users.terms_at`, `terms_version`; migration `005_terms_acceptance`) alongside the existing privacy consent. 22 tests pass (new: sign-up refused without terms).
- Approve/decline already works from People (see the entry below); turn on "Approve new sign-ups" in Settings to use it.

## 2026-10-09 - Adding people: approval, invites, admin add
- **Self-request with approval:** new Settings toggle "Approve new sign-ups". People fill in the sign-up form, see "request sent", and cannot sign in until a moderator approves (new `users.approval_status`: approved / pending / rejected). Moderators get an email per request, a red number on People and Admin, and a "waiting for approval" panel with Approve / Decline at the top of People. The person is emailed the outcome. Entering the invite code (if you use one) skips the wait.
- **Resident invites:** Profile has "Invite neighbours" with a personal link (`/register?ref=...`), WhatsApp and copy buttons. Joiners are recorded as invited by that resident (shown to moderators on the request). Setting "Trust residents' invite links" lets those joiners skip approval.
- **Admin add:** People > "+ Add a person" (name, email, tower, apartment, role). They get an email with a set-your-password link valid 7 days; the link is also shown to copy and send yourself (useful while email is still on console). Only super admins can add admins.
- Sign-in messages: pending and declined people see a clear reason instead of "wrong password". Migration `004_signup_approval_and_invites`. 22 tests pass (new: approval flow, invites, admin add).
- Default unchanged for now: approval is OFF until you turn it on.

## 2026-10-09 - Residents email management from their own email app
- **New default (`email_mode: resident`):** reporting saves the report on the platform, then opens the resident's own email app with the email to management already written (subject, details, secure photo links), so it comes from them. They press Send, return and tap "I've sent it"; that confirmation is recorded with a timestamp (`email_sent` event, `emailed_at`). If they skip it, the report page shows the same panel until done. The same applies when adding yourself with "This affects me too" (`affects.email_confirmed_at`). The server no longer sends the email in this mode. Admins can switch back to "Platform sends the email" in Settings.
- Limits to know: the app cannot tell whether the email was really sent (it relies on the resident's confirmation), and photos go as secure links, not attachments (mailto cannot attach files). Reminders and the response-time clock start when the resident confirms.
- "This affects me too": a photo is now **recommended, not required** (default off; migration 003 switches it off for existing communities, admins can turn it back on), and the sheet no longer asks for an incident ID (it can still be added later on the report page).
- Smaller community title on the dashboard. Migrations: `003_resident_email_and_optional_affect_photo`. 20 tests pass (new: resident email flow).
- Main "Report an issue" form still requires a photo; tell me if that should also become optional.

## 2026-10-09 - Cleaner top of the dashboard
- Removed the green top bar on phones (navigation is the bottom bar) and the extra "+ Report" button at the top right. On desktop the bar stays for navigation; the duplicate logo/title in the page header is hidden there.
- The orange "REPORT AN ISSUE" button now looks like a physical button: gradient, raised edge, shadow, arrow, and presses down when tapped.

## 2026-10-09 - Share sheet, WhatsApp, link previews
- Replaced the browser popups with a "Share with neighbours" sheet: **Send on WhatsApp** (opens WhatsApp with the message and link pre-filled), **Copy message and link**, **Copy link only**, and the phone's share sheet where available. Copying now works on plain http (home server) via a fallback; the old popups appeared because browsers block the modern clipboard/share APIs on non-HTTPS pages.
- Optional **WhatsApp group invite link** in Admin > Settings adds "Post in our WhatsApp group": WhatsApp cannot pre-fill a post into a chosen group, so the message is copied and the group opens for pasting.
- **Link preview card** (photo, title, "N residents reported"): the app now serves Open Graph tags for `/incident/:id`. Details show only when the link carries a valid share token (`&s=`, HMAC of the incident id); otherwise a generic card with the app icon. Never includes names, apartment numbers or location text; private/withdrawn reports never show. The photo link in the preview is valid for 30 days. Needs a public HTTPS address (Cloudflare Tunnel) and the right `APP_BASE_URL`: WhatsApp cannot fetch previews from 192.168.x.x. 19 tests pass (new: preview privacy).

## 2026-10-09 - New app icon
- Main app icon (building with teal dome) from your icon set now used for the browser tab, the Android install/shortcut icon (any + maskable PNGs, 32-512 px) and the iPhone home-screen icon (`web/public/icons/apple-touch-icon.png`, 180 px). Theme colour changed to the icon's navy `#0a1c34`. Old `icon.svg` / `icon-192.png` / `icon-512.png` removed; service-worker cache bumped to v2.
- The per-category icons from the set (plumbing, electrical, elevator, etc.) are NOT used yet, by choice.
- Not checked on a real phone. Already-installed shortcuts may keep the old icon until removed and re-added.
- Admin > Settings now has an editable Community name (the dashboard heading showed the placeholder `127.0.01`).
- Dashboard redesign: app icon beside the heading and in the top bar; full-width search box with a magnifier; Open/Closed/All as a segmented control; Community / My reports as underline tabs; tower and sort selectors side by side. Checked at phone width in a browser against demo data.
- Report button: big amber "Report an issue" button at the top of the dashboard, and the bottom-bar "+" is now a labelled "+ Report" pill.
- "Needs your attention" is collapsed into one line ("6 incidents need your attention") that opens on tap.
- Share link: after reporting, and on any open community report, "Share link so neighbours can add themselves" (phone share sheet, or copies the link). The link is `/incident/<id>?affects=1`; it survives sign-in and account creation (sign-in now returns you to the page you were opening) and opens the "This affects me too" sheet. Private reports cannot be shared. Checked in a browser: logged out -> link -> sign in -> lands on the sheet.

## 2026-10-09 - MR towers, dashboard "affects me" button, per-resident incident ID
- Towers renamed MR 1 / MR 2 / MR 3 (new default, seed, tests). Migration `002` renames existing Tower A/B/C in communities, users, incidents and affects, so your current data is converted on the next start. Admins can still edit the list in Settings.
- Dashboard cards: "N reported" badge on the photo and a "This affects me too" button under it (shown only when you can still add yourself). It opens the report with the sheet ready.
- The sheet has an optional "your own incident ID from the management company" field; it is stored per resident (`affects.mgmt_case_number`), added to the email to management, and editable later on the report page ("Your own incident ID"). New endpoint `POST /api/incidents/:id/my-case-number`.
- List API items gain `can_affect`; admin affects list shows each resident's ID. 18 tests pass. Not checked on a real phone; layout of the card is untested visually.

## 2026-10-09 - Photo upload fix
- Cause (most likely): Docker creates the bind-mounted `files` folder as root while the app runs as user `node`, so saving a photo failed with a permission error (HTTP 500) and the report form could not continue.
- Fix: new `docker-entrypoint.sh` starts as root, `chown`s the photo folder, then drops to `node` (via `setpriv`). No manual `chown` needed any more.
- The Dockerfile now sets the entrypoint's executable bit and strips CRLF itself (uploading via the GitHub website drops the +x flag, which stopped the container starting).
- The web client now shows a clear message when the server/proxy returns a non-JSON error (e.g. 413 too large) instead of failing silently.

## 2026-10-09 - create-admin resets lockout
- Re-running create-admin for an existing user now also clears failed-login count and lockout. Documented recovery steps in docs/admin-guide.md. Untested on Unraid (needs a new image to take effect; tsc passes).

## 2026-10-04 - Unraid compose: COOKIE_SECURE pass-through
- `docker-compose.unraid.yml` now passes `COOKIE_SECURE` so plain-http LAN testing can log in; docs/unraid.md and docs/configuration.md explain the symptom and the fix. Untested on Unraid.

## 2026-10-04 - Docs fix
- Corrected the create-admin command in docs/unraid.md and README.md (it needs an email and name); explained invite code vs admin creation.

## 2026-10-04 - Compose fix
- `docker-compose.unraid.yml`: removed `build: .` (it would try to build from a missing source folder on Unraid), added `pull_policy: always`. docs/unraid.md updated. Untested on Unraid.

## 2026-10-04 - Generalised "Dubai Holding" to "management company"
- All user-facing text, emails, privacy notice and docs now say "the management company". No brand name remains in the code or docs.
- Internal renames (nothing deployed yet, so no data migration): `dh_*` columns/fields/event types -> `mgmt_*` (e.g. `mgmt_email`, `mgmt_case_number`, `mgmt_closed_at`, `mgmt_closed_count`, status `mgmt_closed`, event `mgmt_reply_received`), env var `DH_EMAIL` -> `MGMT_EMAIL` (also in Bicep param `mgmtEmail`, compose, workflows), function names `queueMgmtEmail`/`recordMgmtReply`. CSV export header `dh_case_number` -> `mgmt_case_number`.
- **Breaking for any existing database or `.env`**: re-seed local demo DBs; rename `DH_EMAIL` to `MGMT_EMAIL` in your Unraid `.env` and the GitHub variable `DH_EMAIL` to `MGMT_EMAIL`.

## 2026-10-04 - Documentation and repo handover
- README rewritten: current target is the owner's own Unraid server; Azure marked as future/untested.
- Added CLAUDE.md (working agreement + "update all docs every build" rule), docs/status.md, architecture.md, decisions.md, configuration.md, admin-guide.md.
- Untested: nothing new in code.

## 2026-10-04 - GitHub publishing and Unraid
- `publish-image.yml` builds `ghcr.io/<owner>/neighbourhood-platform` on push to `main`; `docker-compose.unraid.yml` (app + Postgres + Watchtower); docs/unraid.md.
- Azure `deploy.yml` made manual-only.

## 2026-10-04 - Sleep mode (Azure cost saving)
- Server starts instantly and serves a "Start the service" page while the database is stopped; `/api/system/status` and `/api/system/wake`; Bicep scale-to-zero and nightly stop job; backup moved to 22:30 Dubai.
- Tested locally (gate page, 503 asleep, normal start). Azure side untested.

## 2026-10-04 - Optional bring-your-own AI (browser only)
- Profile > "Smart drafting": resident's own Anthropic/OpenAI key kept in browser storage; photo goes straight to that provider; falls back to keyword drafting. CSP allows only api.anthropic.com and api.openai.com. Server AI still off.

## 2026-10-04 - Backups (Azure design)
- PostgreSQL 35-day backups, blob versioning/soft delete, second copy in UAE Central (nightly pg_dump job + blob replication). Untested.

## 2026-10-04 - Initial build (v0.1.0)
- API, web PWA, KPI engine, admin portal, CSV import, demo seed, tests (17 passing), Bicep and CI files.
