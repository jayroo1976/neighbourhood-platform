# Changelog (newest first)

## 2026-10-11 - Screenshots, briefing PDF and icon set added to the repo
- `docs/screenshots/` (13 screenshots of the main screens, sample data only), `docs/briefing/Issue-Tracker-Briefing.pdf`, and `docs/branding/marina-residence-icons/` (full icon set including category icons, not yet used in the app). README index updated. No code change, so no new image build is needed.

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
