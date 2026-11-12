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
| `HA_URL`, `HA_TOKEN`, `HA_AIR_SENSORS` | - | Fresh air monitoring tab, shown in the app as the Fresh air monitoring tab (admins switch it on/off in Settings > Resident tabs). Home Assistant base URL (must be reachable from the app container), a long-lived access token (use a dedicated non-admin HA user), and the layout as one-line JSON: A tower may add `"hidden":true` to keep it behind a "Show" button on the Fresh air monitoring page (display only, not access control). Each sensor id is either `sensor.x` (live) or `source:name` such as `tower1:fresh_air_temperature` (imported statistics, hourly). Each tower may also carry `"prefix":"sensor.<device>_"` (expands to temperature, humidity and every uHoo sensor: `carbon_dioxide`, `carbon_monoxide`, `nitrogen_dioxide`, `ozone`, `pm2_5`, `pressure`, `volatile_organic_compounds`, `virus_index`, `influenza_index`, `mold_index`) and/or `"metrics":{"co2":"sensor.x",...}` (keys `co2 pm25 voc co no2 o3 pressure virus influenza mold`) which override the prefix. `outside.temperature` and `outside.humidity` are drawn as the Outside line on the temperature and humidity charts (and the moisture chart, worked out from both); for Week/Month/All time it needs long-term statistics in Home Assistant (a normal `sensor.x` with a measurement state class, or an imported `source:name`). Layout: `{"outside":{"temperature":"sensor.x","humidity":"sensor.h"},"towers":[{"name":"MR 1","temperature":"sensor.y","humidity":"sensor.z"}]}`. All three must be set or the tab stays hidden. Invalid JSON or an entity id that is not `domain.name` also leaves it off |
| `OUTSIDE_SOURCE_URL`, `OUTSIDE_POLL_MINUTES`, `OUTSIDE_USER_AGENT` | Palm Jumeirah station page on iqair.com / 20 (minimum 10) / a descriptive name | Read by the `collector` container only. The https page it fetches for the outdoor station figures, how often (minutes), and the User-Agent it announces. Use `app:outside_temperature` and `app:outside_humidity` under `outside` in `HA_AIR_SENSORS` to show them. The collector also reads `HA_URL`, `HA_TOKEN` and `HA_AIR_SENSORS` (the same values as the app) to copy the sensor history out of Home Assistant; leave them out of its environment to switch that copy off. |
| `HA_CACHE_SECONDS`, `HA_STALE_MINUTES` | 60 / 120 | How long a Home Assistant answer is reused, and how old a reading may be before it is shown as an old reading |
| `REPLY_DOMAIN`, `INBOUND_EMAIL_SECRET` | - | Per-incident reply address domain; shared secret for the inbound webhook |
| `STORAGE_PROVIDER` | local | `local` or `azure` |
| `STORAGE_LOCAL_DIR` | ./data/files | Photo folder (a mounted volume on Unraid) |
| `AZURE_STORAGE_ACCOUNT`, `AZURE_STORAGE_CONTAINER`, `AZURE_STORAGE_CONNECTION_STRING` | - / incident-photos / - | Azure Blob |
| `SCHEDULER_ENABLED` | true (not in tests) | Reminders, outbox, cleanup |
| `AI_SUGGEST_ENABLED`, `ANTHROPIC_API_KEY`, `AI_MODEL` | off | Server-side AI (leave off) |
| `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `PG_SERVER_NAME` | - | Azure sleep mode only (wake the stopped database) |

Docker Compose variables for Unraid (`PG_PASSWORD`, `NP_IMAGE`, `APPDATA`, `COMMUNITY_NAME`) are documented in docs/unraid.md.

Per-community settings (Admin > Settings, stored in the database): require photo for affects-me, affects/day cap, reports/day cap, case-number reminder hours, verify reminder days, acknowledgement SLA hours, resolution SLA days by severity, CC reporter on emails, registration open, AI suggest.

Note: the public fresh-air page is a **setting**, not an environment variable: Admin > Settings > Resident tabs > "Public fresh-air page (no sign-in)" (`air_public_enabled`, default off). It uses the same `HA_*` variables as the Fresh air monitoring tab and needs that tab switched on.
