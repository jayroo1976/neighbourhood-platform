# Changelog (newest first)

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
