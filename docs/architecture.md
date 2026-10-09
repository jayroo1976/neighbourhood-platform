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
- `api/src/routes/` `auth`, `me`, `incidents`, `misc` (files, KPI, inbound email), `admin`. `app.ts` wires helmet/CSP, rate limits, CSRF, static web. `server.ts` starts the gate then the app.
- `api/src/scripts/` `seed.ts` (demo data), `create-admin.ts`. `api/test/` vitest + supertest.
- `web/src/` `App.tsx` routes/layout, `api.ts` fetch wrapper + types, `auth.tsx`, `ui.tsx`, `ownAi.ts` (browser BYO AI), `styles.css`; `pages/` Auth, Feed, Report, Incident, Scorecard, Account, Admin.
- `infra/main.bicep`, `.github/workflows/`, `backup/` (pg_dump job image), `docker-compose.unraid.yml`, `Dockerfile`.

## Roles
resident (own reports + community), committee (read-only, blurred GPS, no internal events), admin, super_admin (also demo wipe). Admins must enrol TOTP MFA when `REQUIRE_ADMIN_MFA` (default on in production).

## Data model (tables)
`communities` (settings JSON, towers, management email) · `users` · `password_resets` · `incidents` (status, case number, mgmt_closed_count, reopen_count, linked_to, visibility, timestamps, source) · `incident_events` (hash-chained: prev_hash + canonical JSON) · `uploads` (photos, kinds) · `affects` · `email_outbox` · `notifications` · `audit_log` · `_migrations`. Timestamps are ISO strings, JSON as text (SQLite/Postgres portable). Migrations in `db.ts`: `001_initial`; `002_affects_case_number_and_mr_towers` (adds `affects.mgmt_case_number`, renames Tower A/B/C to MR 1/MR 2/MR 3 in communities, users, incidents, affects).

## Workflow (statuses)
`reported` -> `case_number_received` -> `in_progress` -> `mgmt_closed` (management says closed, **unverified**) -> `resolved_ok` (resident photo) | `resolved_poor` (photo) -> `reopened` -> ...; `withdrawn`. Resolutions need a photo unless an admin overrides with a note. Every transition writes a timestamped event.

## API (all under `/api`; JSON; cookie session `np_session`; header `X-Requested-With: neighbourhood` required)
- **auth:** POST register, login, logout, forgot, reset, mfa/setup, mfa/enable, consent; GET me.
- **me:** PATCH profile, POST password, GET export, POST delete; **notifications** GET /, POST /read.
- **incidents:** POST /uploads (photo; re-encoded, EXIF stripped); POST /ai/suggest; GET /incidents, /attention, /similar, /:id; POST /incidents, /:id/affects (optional `case_number`), /:id/my-case-number (affected resident's own management ID), /:id/case-number, /:id/status, /:id/note.
- **misc:** GET /files/* (signed expiring links), GET /kpi/summary, POST /inbound/email (header `x-inbound-secret`).
- **admin (admin+):** GET/PATCH incidents, POST case-number/status/note/resend-email/link/unlink/verify-chain, GET/PATCH settings, users (list/patch/reset-password/reset-mfa), POST import (dry_run), GET export.csv, GET audit, POST demo/wipe (super_admin).
- **system (always up):** GET /healthz, GET /api/system/status, POST /api/system/wake.

## Background jobs (scheduler, while the app is awake)
Case-number reminder ladder (after N hours, 3N hours, 7 days), verify-closed nudge, email outbox with retry/backoff (5 attempts), orphan upload cleanup (24 h).

## KPIs
Defined in `services/kpi.ts` (`KPI_DEFINITIONS`, served at `/api/kpi/summary`): acknowledgement SLA, resolution SLA by severity, disputed closure rate, verified fix rate, backlog ageing, repeat/affects, by category and tower, 12-week trend, score 0-100 (weights 25/25/30/20) with low-sample confidence flag.

## Email design
New report and each "affects me" produce an independent email to the management company with expiring signed photo links (never attachments) and a per-incident reply-to `inc+<id>@REPLY_DOMAIN`. Replies can be fed back to the inbound webhook, which extracts case numbers by regex and records a `mgmt_reply_received` event.
