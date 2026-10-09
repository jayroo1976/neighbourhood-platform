# Neighbourhood Reporting Platform

> **Current target: a test server on the owner's own hardware (Unraid, local drive), not Azure.** Azure files exist (`infra/`, `docs/sleep-mode.md`, `docs/backup-restore.md`) but are **untested and not in use yet**. Everything here is in a *test/pilot* state. See [docs/status.md](docs/status.md).

Resident-run incident reporting and accountability for residential communities. Residents photograph an issue, the app emails the management company and records every step with a timestamp. Neighbours tick "affects me". A transparent scorecard shows how well the management company is performing, especially cases it marks **closed that are not actually fixed**.

**Owner:** James (Venture Foundry). **Repo is private**, on his personal GitHub. Unraid pulls the image automatically (see below).

## If you are Claude starting a new session
Read [CLAUDE.md](CLAUDE.md) first (working agreement, how to run/test, and the rule to **update all docs on every build**), then [docs/status.md](docs/status.md), [docs/architecture.md](docs/architecture.md) and [docs/decisions.md](docs/decisions.md).

## What it does
- **Report:** photo + a few words; date/time and GPS captured automatically; title/category/urgency drafted from the note (keyword rules, no AI by default); tower and apartment entered once and reused; similar-issue nudge before submitting; privacy warnings; "keep private" option.
- **Workflow:** reported -> case number received -> in progress -> Management closed (unverified) -> resolved OK (photo) / resolved poor (photo) -> reopened / withdrawn. Every event is timestamped in a tamper-evident hash chain. Reminders prompt the reporter to add the case number.
- **Community:** everyone sees all (non-private) issues, never names or apartment numbers; "affects me" (button on each dashboard card, with a "N reported" badge on the photo; photo required by default, admin toggle; optional own management incident ID) emails the management company separately each time, with daily caps.
- **Scorecard / KPIs:** acknowledgement SLA, resolution SLA, disputed ("closed but not fixed") rate, verified-fix rate, backlog ageing, repeat reports, by type and tower, 12-week trend, transparent 0-100 score. Per-issue KPIs too.
- **Admin:** update progress, add case numbers, link duplicates, edit, verify history integrity, settings, users, CSV import/export, audit log, demo-data wipe.
- **Privacy/security (UAE PDPL-minded):** see [docs/privacy-pdpl.md](docs/privacy-pdpl.md) and [docs/security.md](docs/security.md).

## Run on your own server (Unraid) - the current target
Full steps: **[docs/unraid.md](docs/unraid.md)**. In short:
1. Push this repo to your **personal** GitHub (private). The **Publish image** workflow builds `ghcr.io/<you>/neighbourhood-platform:latest`.
2. On Unraid, use `docker-compose.unraid.yml` (app + PostgreSQL + Watchtower) with a `.env` (secrets, `NP_IMAGE`, `APP_BASE_URL`).
3. Put HTTPS in front (Cloudflare Tunnel or Tailscale). GPS and secure cookies need HTTPS.
4. Create the admin: `docker exec -it neighbourhood-app-1 node api/dist/scripts/create-admin.js you@example.com "Your Name"` (prints a temporary password once; you must enrol an authenticator app at first sign-in; container name may differ, check `docker ps`).
5. Updates: push to `main` -> new image -> Watchtower restarts the app within ~5 minutes.
Keep `EMAIL_PROVIDER=console` and `MGMT_EMAIL` set to your own address while testing so nothing reaches the management company by accident.

## Develop locally
```bash
npm install
npm run seed         # demo community, @pilot.test users, 26 sample issues (prints logins once)
npm run dev:api      # http://localhost:8080   (SQLite, console email)
npm run dev:web      # http://localhost:5173
npm test             # 17 API tests
npm run typecheck && npm run build
```
Config is by environment variables: see [docs/configuration.md](docs/configuration.md) and `.env.example`.

## Azure (later, not in use)
Bicep in `infra/main.bicep` (UAE North: Container Apps scale-to-zero, PostgreSQL Flexible Server stopped nightly, Blob storage, ACS Email, Key Vault, nightly dump to UAE Central). Workflows `infra.yml` and `deploy.yml` are **manual-only**. Unvalidated: run a what-if first. Details: [docs/sleep-mode.md](docs/sleep-mode.md), [docs/backup-restore.md](docs/backup-restore.md).

## Documentation index
| Doc | What it covers |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Orientation and rules for Claude sessions (read first) |
| [docs/status.md](docs/status.md) | What works, what is tested/untested, open items, next steps |
| [docs/architecture.md](docs/architecture.md) | Stack, code layout, data model, workflow, API, background jobs |
| [docs/decisions.md](docs/decisions.md) | Design decisions and the reasoning (read before changing behaviour) |
| [docs/configuration.md](docs/configuration.md) | Every environment variable |
| [docs/admin-guide.md](docs/admin-guide.md) | Roles, daily admin tasks, settings, CSV import format |
| [docs/unraid.md](docs/unraid.md) | Run and auto-update on Unraid via GitHub |
| [docs/privacy-pdpl.md](docs/privacy-pdpl.md) | Data map, PDPL notes, open legal points |
| [docs/security.md](docs/security.md) | Security controls and known gaps |
| [docs/sleep-mode.md](docs/sleep-mode.md) | Azure cost saving: nightly stop, "Start the service" page |
| [docs/backup-restore.md](docs/backup-restore.md) | Backups and restore (Azure design; Unraid notes in unraid.md) |
| [docs/roadmap.md](docs/roadmap.md) | Pilot enhancements and later ideas |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each build |
