# Test server on Unraid

Good for a short test with a few people. Not for the real pilot (home power/internet, no managed backups).

## 0. How updates flow
You push to GitHub `main` -> the **Publish image** workflow builds the image and stores it in GitHub's registry (ghcr.io) -> Watchtower on your Unraid sees the new image within 5 minutes and restarts the app. Database changes apply automatically on start. Rollback: set `NP_IMAGE` to an older `...:<commit-sha>` tag and run `docker compose up -d`.

**Private repo:** create a GitHub personal access token with only `read:packages`, run `docker login ghcr.io -u <user>` on the Unraid, and copy the resulting `~/.docker/config.json` to `/mnt/user/appdata/neighbourhood/docker-config.json` (Watchtower uses it). Public repo: no login needed (create an empty file for that path). Do not put secrets or real data in the repo; `.env` stays on the Unraid.

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
REGISTRATION_CODE=choose-an-invite-code
```
## 2. Start it
Install the **Docker Compose Manager** plugin (Community Apps), add a stack pointing at `docker-compose.unraid.yml`, "Compose Up". Or in a terminal: `docker compose -f docker-compose.unraid.yml up -d --build`.

## 3. Create your admin
`docker compose -f docker-compose.unraid.yml exec app node api/dist/scripts/create-admin.js`

## 4. HTTPS (required)
Phones only allow GPS and a secure login cookie over HTTPS. Easiest safe options:
- **Cloudflare Tunnel** (cloudflared container): no open ports; point a hostname at `http://app:8080`.
- **Tailscale** (testers install the app) with Tailscale serve/funnel.
- Nginx Proxy Manager + Let's Encrypt (opens a port on your router; less safe).
Set `APP_BASE_URL` to the final https address.

## 5. Back up and tidy
- Share `/mnt/user/appdata/neighbourhood` (pgdata, files) in your normal Unraid backup. Add a nightly `pg_dump` (`docker compose exec db pg_dump -U np np > /mnt/user/backups/np.sql`) via User Scripts.
- Keep emails on `console` until you want real ones, so nothing reaches management by accident.
- Tell testers it is a test, use demo or low-sensitivity data, and delete the stack and `appdata` folder when finished.
