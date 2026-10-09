# Changelog (newest first)

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
