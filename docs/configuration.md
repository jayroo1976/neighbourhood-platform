# Configuration (environment variables)

Set in `.env` (Unraid) or the host's settings. Production (`NODE_ENV=production`) refuses weak secrets.

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | development | `production` enables Secure cookies, MFA for admins, 32+ char secrets check |
| `PORT` | 8080 | HTTP port |
| `APP_BASE_URL` | - | Public https URL (used in emails/links) |
| `DATABASE_URL` | sqlite | `sqlite:./data/dev.sqlite` or `postgres://user:pass@host:5432/db` |
| `DATABASE_SSL` | off (dev) / require (prod) | `off`, `require`, `no-verify` (use `off` for the Unraid Postgres container) |
| `JWT_SECRET`, `FILE_SIGNING_SECRET`, `MFA_ENCRYPTION_KEY` | - | 32+ random chars each (required in production) |
| `SESSION_HOURS` | 12 | Session lifetime |
| `COOKIE_SECURE` | true in prod | Override only for plain-HTTP LAN testing (passed through by the Unraid compose file) |
| `REQUIRE_ADMIN_MFA` | true in prod | Admins must enrol TOTP |
| `DEFAULT_COMMUNITY_NAME` / `DEFAULT_COMMUNITY_SLUG` | Pilot Community / pilot | Created on first start |
| `MGMT_EMAIL` | placeholder `management@example.com` | Management company inbox. **Use your own address while testing** |
| `EMAIL_PROVIDER` | console | `console` (log only), `smtp`, `acs` |
| `SMTP_URL`, `EMAIL_FROM`, `EMAIL_FROM_NAME` | - | SMTP sending |
| `ACS_ENDPOINT`, `ACS_CONNECTION_STRING` | - | Azure Communication Services email |
| `EMAIL_LINK_TTL_DAYS` | 30 | Lifetime of photo links in emails to management |
| `WATCHTOWER_SECRET` | - | Unraid compose only: shared secret Watchtower sends with update notices to `/api/inbound/watchtower` (shown on Admin > System). Empty = endpoint refuses |
| `APP_VERSION`, `BUILD_NUMBER`, `BUILD_SHA`, `BUILD_DATE` | package.json / dev | Stamped into the image by the GitHub workflow; shown in the version strip and `/api/system/version` |
| `REPLY_DOMAIN`, `INBOUND_EMAIL_SECRET` | - | Per-incident reply address domain; shared secret for the inbound webhook |
| `STORAGE_PROVIDER` | local | `local` or `azure` |
| `STORAGE_LOCAL_DIR` | ./data/files | Photo folder (a mounted volume on Unraid) |
| `AZURE_STORAGE_ACCOUNT`, `AZURE_STORAGE_CONTAINER`, `AZURE_STORAGE_CONNECTION_STRING` | - / incident-photos / - | Azure Blob |
| `SCHEDULER_ENABLED` | true (not in tests) | Reminders, outbox, cleanup |
| `AI_SUGGEST_ENABLED`, `ANTHROPIC_API_KEY`, `AI_MODEL` | off | Server-side AI (leave off) |
| `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `PG_SERVER_NAME` | - | Azure sleep mode only (wake the stopped database) |

Docker Compose variables for Unraid (`PG_PASSWORD`, `NP_IMAGE`, `APPDATA`, `COMMUNITY_NAME`) are documented in docs/unraid.md.

Per-community settings (Admin > Settings, stored in the database): require photo for affects-me, affects/day cap, reports/day cap, case-number reminder hours, verify reminder days, acknowledgement SLA hours, resolution SLA days by severity, CC reporter on emails, registration open, AI suggest.
