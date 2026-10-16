# Architecture

## Overview
Single container: an Express API that also serves the built React PWA. Database: SQLite in dev/tests, PostgreSQL when deployed. Photos on local disk (Unraid) or Azure Blob. Email via console/SMTP/Azure Communication Services.

```
Phone/browser (React PWA)  --HTTPS-->  Express API (Node 22, TypeScript)
                                         |-- knex -> SQLite | PostgreSQL
                                         |-- storage -> local disk | Azure Blob
                                         |-- mailer -> console | SMTP | ACS Email
                                         |-- scheduler (in-process): reminders, outbox, orphan cleanup
Inbound email (optional): mailbox rule -> POST /api/inbound/email
```
Monorepo (npm workspaces): `api/`, `web/`. `Dockerfile` builds web then api, runs `node api/dist/server.js` serving `web/dist`.

## Repository layout
- `api/src/config.ts` env config; `domain.ts` categories/severities/statuses/settings; `db.ts` knex + migrations.
- `api/src/security/` scrypt/AES-GCM/signed links (`crypto.ts`), TOTP (`totp.ts`).
- `api/src/services/` `incidents.ts` (core workflow), `events.ts` (hash chain), `kpi.ts`, `mailer.ts`, `scheduler.ts`, `serializers.ts` (role-based redaction), `similar.ts`, `images.ts` (sharp), `storage.ts`, `fileLinks.ts`, `ai.ts` (optional server AI, off), `support.ts` (audit/notify), `sleep.ts` (Azure DB wake).
- `api/src/services/air.ts` reads Home Assistant `GET /api/states/<entity>` server-side (5 s timeout, cached `HA_CACHE_SECONDS`, entity ids validated, °F converted to °C, unavailable or old readings flagged). Ids shaped `source:name` are imported long-term statistics, read over the HA WebSocket API (`recorder/statistics_during_period`) as hourly averages. `api/src/services/airScales.ts` holds the good/fair/poor bands and sensor-id endings; each reading gets a `level`, and `scales` (bands plus their source) is returned with the page data. A tower can carry a `prefix` that expands to all uHoo sensors, plus extra `metrics` (co2, pm25, voc, co, no2, o3, pressure, virus, influenza, mold). `web/src/pages/Air.tsx` is the AirCon tab, drawing a gauge per sensor and a definitions section (refreshes every minute). Community setting `aircon_enabled` (admin tick-box) gates it; `GET /admin/settings` also returns `aircon_available`.
- `api/src/services/odour.ts` smell reports: validation against the tower plan (`domain.ts` constants), daily cap, resident summary with small-group suppression, admin list, CSV. `web/src/pages/Smells.tsx` (resident) and `AdminSmells.tsx` (admin plan view, patterns, log).
- `api/src/routes/` `auth`, `me`, `incidents`, `misc` (files, KPI, inbound email), `odour` (resident and admin routers), `admin`. `app.ts` wires helmet/CSP, rate limits, CSRF, static web. `server.ts` starts the gate then the app.
- `api/src/scripts/` `seed.ts` (demo data), `seed-test.ts` + `test-data/incidents.json` (TEST reports with real photos), `create-admin.ts`. `api/test/` vitest + supertest.
- `web/src/` `App.tsx` routes/layout, `api.ts` fetch wrapper + types, `auth.tsx`, `ui.tsx`, `ownAi.ts` (browser BYO AI), `redact.ts` + `RedactSheet.tsx` (on-device photo check: decode, find faces, pixelate, export clean JPEG), `styles.css`; `pages/` Auth, Feed, Report, Incident, Scorecard, Account, Admin.
- `infra/main.bicep`, `.github/workflows/`, `backup/` (pg_dump job image), `docker-compose.unraid.yml`, `Dockerfile`.

## Roles
resident (own reports + community), committee (read-only, blurred GPS, no internal events), admin, super_admin (also demo wipe). Admins must enrol TOTP MFA when `REQUIRE_ADMIN_MFA` (default on in production).

## Data model (tables)
`communities` (settings JSON, towers, management email) · `users` · `password_resets` · `incidents` (status, case number, mgmt_closed_count, reopen_count, linked_to, visibility, timestamps, source) · `incident_events` (hash-chained: prev_hash + canonical JSON) · `uploads` (photos, kinds) · `affects` · `email_outbox` · `notifications` · `audit_log` · `odour_reports` (smell reports: building, kind tower/townhouse, level 1-13 or 14 = penthouse or 0 for townhouse, flat, smell_type, strength 1-4, frequency, where_noticed, observed_at, notes, source app/demo, soft-deleted with deleted_at) · `_migrations`. Timestamps are ISO strings, JSON as text (SQLite/Postgres portable). Migrations in `db.ts` (latest `008_odour_reports`): `001_initial`; `002_affects_case_number_and_mr_towers` (adds `affects.mgmt_case_number`, renames Tower A/B/C to MR 1/MR 2/MR 3 in communities, users, incidents, affects).

## Workflow (statuses)
`reported` -> `case_number_received` -> `in_progress` -> `mgmt_closed` (management says closed, **unverified**) -> `resolved_ok` (resident photo) | `resolved_poor` (photo) -> `reopened` -> ...; `withdrawn`. Resolutions need a photo unless an admin overrides with a note. Every transition writes a timestamped event.

## API (all under `/api`; JSON; cookie session `np_session`; header `X-Requested-With: neighbourhood` required)
- **auth:** POST register (needs consent + terms), login, logout, forgot, reset, mfa/setup, mfa/enable, consent; GET me (/terms and /privacy are public pages).
- **me:** PATCH profile, POST password, GET export, POST delete; **notifications** GET /, POST /read.
- **incidents:** POST /uploads (photo; already covered on the device, then re-encoded again here, EXIF stripped); POST /ai/suggest; GET /incidents, /attention, /similar, /:id; POST /incidents, /:id/affects (optional `case_number`), /:id/my-case-number (affected resident's own management ID), /:id/case-number, /:id/status, /:id/note.
- **misc:** GET /files/* (signed expiring links), GET /kpi/summary, GET /air (AirCon tab, returns `{enabled:false, switched_off:true}` when an admin has switched it off: fresh-air temperature and humidity per tower plus outside temperature and humidity from Home Assistant, sign-in required, `Cache-Control: no-store`; `config.air_enabled` on /auth/me drives the nav entry), POST /inbound/email (header `x-inbound-secret`).
- **odour (sign-in required; 404 when `odour_enabled` is off):** GET /odour/options (buildings, plan, labels), GET /odour/summary?days= (counts only), GET /odour/mine, POST /odour, DELETE /odour/:id (own). `config.odour_enabled` on /auth/me drives the nav entry.
- **admin odour (admin+ only):** GET /admin/odour (exact level and flat; filters days/type/where), GET /admin/odour/export.csv, DELETE /admin/odour/:id (both audited: `odour_export_csv`, `odour_delete`).
- **admin (admin+):** GET/PATCH incidents, POST case-number/status/note/resend-email/link/unlink/verify-chain, GET/PATCH settings, users (list/patch/reset-password/reset-mfa), POST import (dry_run), GET export.csv, GET audit, POST demo/wipe (super_admin).
- **system (always up):** GET /healthz, GET /api/system/status, POST /api/system/wake.

## Background jobs (scheduler, while the app is awake)
Case-number reminder ladder (after N hours, 3N hours, 7 days), verify-closed nudge, email outbox with retry/backoff (5 attempts), orphan upload cleanup (24 h).

## KPIs
Defined in `services/kpi.ts` (`KPI_DEFINITIONS`, served at `/api/kpi/summary`): acknowledgement SLA, resolution SLA by severity, disputed closure rate, verified fix rate, backlog ageing, repeat/affects, by category and tower, 12-week trend, score 0-100 (weights 25/25/30/20) with low-sample confidence flag.

## Email design
New report and each "affects me" produce an independent email to the management company with expiring signed photo links (never attachments) and a per-incident reply-to `inc+<id>@REPLY_DOMAIN`. Replies can be fed back to the inbound webhook, which extracts case numbers by regex and records a `mgmt_reply_received` event.


## Share links and previews
`GET /incident/:id` (web route, served by `app.ts`) injects Open Graph tags via `services/sharePreview.ts`. The share URL is `APP_BASE_URL/incident/<id>?affects=1&s=<token>`; the token is an HMAC of the incident id using `FILE_SIGNING_SECRET` (`services/fileLinks.ts`). A valid token shows the report title, category, building, resident count and a 30-day signed link to the first photo. Without it the card is generic. `share_url` is returned by `POST /incidents` and `GET /incidents/:id` (null for private or withdrawn reports). Setting `whatsapp_group_url` is exposed in `/api/me` config.


## Resident-sent email (default)
`settings.email_mode` = `resident` (default) or `platform`. In resident mode `createIncident`/`addAffect` do not queue a server email. `GET /incidents/:id/email-draft` returns `{kind,to,subject,body}` for the reporter (kind `new`) or an affected resident (kind `affects`) built by `composeMgmtEmail(..., {resident:true})`; the web builds a `mailto:` link. `POST /incidents/:id/email-sent` records an `email_sent` event (`resident_new` / `resident_affects`) and sets `incidents.emailed_at` or `affects.email_confirmed_at`. Photos are signed links, not attachments.


## Sign-up approval and invites
`users.approval_status` (approved/pending/rejected), `invited_by`, `invite_token` (migration 004). Settings `require_approval`, `trust_resident_invites`. `POST /auth/register` returns 202 `{pending:true}` and issues no session when approval is needed; `POST /auth/login` returns 403 `pending_approval` / `not_approved`. Admin: `GET /admin/users/pending-count`, `POST /admin/users` (create + 7-day set-password link), `POST /admin/users/:id/approve|decline`. Residents: `GET /me/invite`. Unauthenticated `/me` config includes `approval_required`.

## Sign-up and home screen
`POST /api/auth/register` returns 202 `{pending:true}` when `require_approval` (default true) applies; no invite code. `web/src/InstallPrompt.tsx` holds the install help (captures `beforeinstallprompt`, localStorage flag `np_install_done`).

## Version and system log
`api/src/version.ts` reads `APP_VERSION` (else root package.json), `BUILD_NUMBER`, `BUILD_SHA`, `BUILD_DATE` (set by the image build). `GET /api/system/version` is served by the gate in `server.ts` (works while the DB is asleep). Table `system_events` (migration 006: id, at, kind start|update|watchtower, title, message, version, build; newest 500 kept). `recordStart` runs on every boot and logs `update` when version/build differ from the last start. `POST /api/inbound/watchtower` (header `X-Watchtower-Secret` vs `WATCHTOWER_SECRET`, timing-safe) stores Watchtower notices. `GET /api/admin/system` (staff) feeds the web page `/admin/system`; `web/src/VersionBar.tsx` is the strip on every page.

## Metrics endpoints
- `GET /api/kpi/summary?days=` (any signed-in resident): resident-safe community metrics (no names, no apartments), including response-time distribution, by-priority, this week vs last, top affected, reopen rate.
- `GET /api/admin/insights?days=` (staff only): the same KPIs plus waiting-for-reply, not-yet-emailed, longest-open lists and people counts. Computed in `api/src/services/kpi.ts` (`communityKpis`) and `api/src/routes/admin.ts`.
- "My reports" summary is computed in the browser from `GET /api/incidents?scope=mine&state=all`.


## On-device photo check (2026-10-15)
- Flow: file picker -> `redactPhoto(file)` (`web/src/RedactSheet.tsx`) -> decode to a canvas (orientation corrected, max 1600 px) -> faces found -> resident reviews and edits boxes -> `exportRedacted` draws pixelated blocks over each box and exports a fresh JPEG -> `POST /uploads`. Nothing else in the web app uploads a photo.
- Detector: MediaPipe BlazeFace (Apache-2.0, `@mediapipe/face_detection` 0.4.1646425229), full-range model, whole photo plus 2x2 and 3x3 tiles, boxes merged by overlap. Runs in the hidden same-origin page `web/public/face/face-worker.html` + `face-worker.js` (own CSP with `unsafe-eval`, set in `api/src/app.ts`), talking to the app by `postMessage`. The detector files are copied to `web/public/mediapipe/face_detection/` by `web/scripts/copy-face-model.mjs` (runs before `dev` and `build`; git-ignored) and served from our own origin with a 7-day cache.
- Docker image: the build stage runs the copy script via `npm run build`, so the final image carries about 13 MB of detector files under `web/dist/mediapipe`.

## Scorecard calculations (2026-10-15)
`api/src/services/kpi.ts` `communityKpis()` returns, besides the earlier fields: `first_time_fix`, `recurrence[]` (30/60/90 days), `hotspots[]`, `evidence`, `resolution.verified_share`, `closure_quality.median_days_to_management_close` and `by_severity[].median_ack_hours`. `areaOf()` maps free-text locations to general areas (Lift, Car park, Pool, ...). All figures come from existing tables (`incidents`, `uploads`, `affects`); no migration.
