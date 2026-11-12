# Test server on Unraid

Good for a short test with a few people. Not for the real pilot (home power/internet, no managed backups).

## 0. How updates flow
You push to GitHub `main` -> the **Publish image** workflow builds the image and stores it in GitHub's registry (ghcr.io) -> Watchtower on your Unraid sees the new image within 5 minutes and restarts the app. Database changes apply automatically on start. Rollback: set `NP_IMAGE` to an older `...:<commit-sha>` tag and run `docker compose up -d`.

**Watchtower messages in the app:** add `WATCHTOWER_SECRET=` (any long random string) to your `.env`, re-apply the compose file; update notices then appear on Admin > System. The version at the top of every page shows which build is running. Raw log: Docker tab > watchtower > Logs.

**Private repo:** create a GitHub personal access token with only `read:packages`, run `docker login ghcr.io -u <user>` on the Unraid, and copy the resulting `~/.docker/config.json` to `/mnt/user/appdata/neighbourhood/docker-config.json` (Watchtower uses it). Public repo: no login needed, but the file must still exist: run `echo '{}' > /mnt/user/appdata/neighbourhood/docker-config.json` (otherwise Docker creates a folder of that name and Watchtower fails). Do not put secrets or real data in the repo; `.env` stays on the Unraid.

## 1. Get the compose file and set secrets
1. You only need `docker-compose.unraid.yml` on the Unraid (copy it, or `git clone`). The code itself arrives as the pre-built image.
2. Create `.env` next to `docker-compose.unraid.yml`:
```
PG_PASSWORD=<openssl rand -base64 24>
JWT_SECRET=<openssl rand -base64 48>
FILE_SIGNING_SECRET=<openssl rand -base64 48>
MFA_ENCRYPTION_KEY=<openssl rand -base64 48>
NP_IMAGE=ghcr.io/<your-github-user>/neighbourhood-platform:latest
APP_BASE_URL=https://np.yourdomain.com
MGMT_EMAIL=your-own-address@...      # NOT the management company while testing
```
**Outside station collector:** `docker-compose.unraid.yml` has a `collector` service (same image, command `node api/dist/collector.js`, shares the database settings). On the Proxmox/Portainer stack add the same service to `docker-compose.mres.yml` under `services:` (next to `app`):
```yaml
  collector:
    image: ${NP_IMAGE:?set NP_IMAGE}
    pull_policy: always
    command: ["node", "api/dist/collector.js"]
    labels:
      - com.centurylinklabs.watchtower.enable=true
    restart: unless-stopped
    depends_on:
      db: { condition: service_healthy }
    environment:
      NODE_ENV: production
      DATABASE_URL: postgres://np:${PG_PASSWORD}@db:5432/np
      DATABASE_SSL: "off"
      JWT_SECRET: ${JWT_SECRET:?set JWT_SECRET}
      FILE_SIGNING_SECRET: ${FILE_SIGNING_SECRET:?set FILE_SIGNING_SECRET}
      MFA_ENCRYPTION_KEY: ${MFA_ENCRYPTION_KEY:?set MFA_ENCRYPTION_KEY}
      OUTSIDE_SOURCE_URL: ${OUTSIDE_SOURCE_URL:-}
      OUTSIDE_POLL_MINUTES: ${OUTSIDE_POLL_MINUTES:-20}
      HA_URL: ${HA_URL:-}
      HA_TOKEN: ${HA_TOKEN:-}
      HA_AIR_SENSORS: ${HA_AIR_SENSORS:-}
    healthcheck:
      test: ["CMD-SHELL", "test -n \"$$(find /tmp/collector.alive -mmin -90 2>/dev/null)\""]
      interval: 5m
      timeout: 10s
      retries: 3
      start_period: 3m
```
It needs outbound internet (https) for the station page, and, for the sensor history copy, a route to Home Assistant: add the same `HA_URL`, `HA_TOKEN` and `HA_AIR_SENSORS` lines to its `environment:` as the app has (`HA_URL: ${HA_URL:-}` and so on; the supplied `docker-compose.mres-with-collector.yml` already has them). It waits for the app to create the table, so start the stack as usual. Watchtower updates it with the app (the label).

Optional Fresh air monitoring tab (was AirCon): add `HA_URL=`, `HA_TOKEN=` and `HA_AIR_SENSORS=` to `.env` (see docs/admin-guide.md > Fresh air monitoring tab). The app container must be able to reach Home Assistant at that address.

## 2. Start it
Install the **Docker Compose Manager** plugin (Community Apps), add a stack pointing at `docker-compose.unraid.yml`, "Compose Up". Or in a terminal: `docker compose -f docker-compose.unraid.yml up -d`.

## 3. Create your admin
`docker exec -it neighbourhood-app-1 node api/dist/scripts/create-admin.js you@example.com "Your Name"` (prints a temporary password once; you must enrol an authenticator app at first sign-in; container name may differ, check `docker ps`)

Residents ask to join on the site and you approve each one under Admin > People (there is no invite code). The admin above is created by this command, not by sign-up.

## 4. HTTPS (required)
**Symptom if missing:** you sign in, the page returns to the login screen (the browser discards the secure cookie over plain http). For LAN-only testing you can set `COOKIE_SECURE=false` in `.env`, then Compose Down/Up. Remove it once HTTPS works.

Phones only allow GPS and a secure login cookie over HTTPS. Easiest safe options:
- **Cloudflare Tunnel** (cloudflared container): no open ports; point a hostname at `http://app:8080`.
- **Tailscale** (testers install the app) with Tailscale serve/funnel.
- Nginx Proxy Manager + Let's Encrypt (opens a port on your router; less safe).
Set `APP_BASE_URL` to the final https address.

## 5. Back up and tidy
- Share `/mnt/user/appdata/neighbourhood` (pgdata, files) in your normal Unraid backup. Add a nightly `pg_dump` (`docker compose exec db pg_dump -U np np > /mnt/user/backups/np.sql`) via User Scripts.
- Keep emails on `console` until you want real ones, so nothing reaches management by accident.
- Tell testers it is a test, use demo or low-sensitivity data, and delete the stack and `appdata` folder when finished.


## WhatsApp previews need a public address
Share links built on `http://192.168.x.x` work for copying, but WhatsApp cannot fetch a preview photo from a private address. Put the app behind the Cloudflare Tunnel and set `APP_BASE_URL` to the public https address.


## Photo check files
From v0.4.0 the image includes the on-device face-detection files (about 13 MB, under `web/dist/mediapipe`). Nothing to configure. Phones download about 7 MB the first time someone adds a photo. If your Cloudflare tunnel or rules restrict `.wasm`, `.tflite` or `.binarypb` files, allow them or photos will fall back to manual covering with a warning.

For the Proxmox Docker VM (Portainer stack, Watchtower, Cloudflare tunnel) use the phased runbook in [deployment-proxmox.md](deployment-proxmox.md). The public fresh-air page `/fresh-air` works the same on Unraid once ticked in Admin > Settings.
