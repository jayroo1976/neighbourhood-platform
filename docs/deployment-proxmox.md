# Deployment runbook: Proxmox Docker VM (test/pilot)

Where it runs: a Docker VM on Proxmox (`192.168.230.10`, app on port `8080`), managed as a **Portainer stack**, updated by **Watchtower** from `ghcr.io`, reached from outside through a **Cloudflare tunnel**. Azure is not involved. No real resident data is kept in the repo.

Containers in the stack: `app` (the website and API), `collector` (same image, second job: outside readings + Home Assistant history copy), `db` or the SQLite volume, Watchtower.

Do the phases in order. Each has a **check** to pass before moving on, and a **back-out**.

## Phase 0: Before you start (10 minutes)
1. Take a backup: in Portainer, stop nothing; copy the data volume (or run the nightly dump described in [unraid.md](unraid.md)). Note the current image tag shown on Admin > System.
2. Have to hand: the GitHub repo, Portainer login, the Home Assistant address, and a **new** Home Assistant long-lived token (Home Assistant > your profile > Security > Long-lived access tokens). Never paste the token into chat, the repo or a file in a synced folder.

## Phase 1: Get this version built
1. Merge the change (say "merge" and it is committed and pushed). GitHub Actions builds the image and publishes it to `ghcr.io`.
2. In GitHub > Actions, wait for the build to go green. **Check:** the new tag appears under the repo's Packages.
3. **Back-out:** nothing is deployed yet; just do not continue.

## Phase 2: Update the app container
1. Watchtower picks up the new image within its interval (or in Portainer: `app` container > Recreate > tick "Pull latest image").
2. The app runs its database migrations on start (`009_outside_readings`, `010_sensor_readings` are new). **Check:** Admin > System shows the new version and no error in the log.
3. **Back-out:** Recreate `app` with the previous image tag (Portainer > Containers > `app` > Duplicate/Edit > image tag), data is untouched (migrations only add tables).

## Phase 3: Add the collector to the stack
1. Portainer > Stacks > your stack > **Editor**. Replace the contents with `docker-compose.mres-with-collector.yml` (or copy only the `collector` service from it into the existing file).
2. In the **Environment variables** section of the stack add: `HA_URL` (e.g. `http://<HA address>:8123`) and `HA_TOKEN` (the new token). Leave `OUTSIDE_SOURCE_URL` and `OUTSIDE_POLL_MINUTES` unset to use the defaults (20 minutes).
3. Click **Update the stack** with "Re-pull image" ticked.
4. **Check:** `collector` shows **healthy** after a minute or two (the healthcheck passes once it has completed a cycle).
5. **Back-out:** Stacks > Editor > remove the `collector` service > Update. The app does not depend on it.

## Phase 4: Prove the collector works (Portainer console, no terminal needed)
Portainer > Containers > `collector` > **Console** > Connect (command `/bin/sh`), then run each command:
1. `node api/dist/collector.js --check`: should print that the outside page was fetched and what it found. If it says it cannot find the time or values, the page layout differs from what the parser expects: stop, send me the output, and carry on with Phase 5 only after that is fixed. (The parser has not yet been verified against the live iqair.com page.)
2. `node api/dist/collector.js --once`: stores one reading. **Check:** Admin > System > "Outside station, latest report" shows today's time.
3. `node api/dist/collector.js --sync-ha`: copies the tower history from Home Assistant (the first run reads everything and can take a few minutes). **Check:** "Tower history copy, newest hour" is within the last hour or two.

## Phase 5: Point the page at the stored outside figures
1. In the stack environment, change the outside entries in `HA_AIR_SENSORS` to the stored ones: `app:outside_temperature` and `app:outside_humidity` in place of the old `sensor.iqair_palm_*_log` entities (see [admin-guide.md](admin-guide.md) item 8 for the exact layout).
2. Update the stack. **Check:** Fresh air monitoring tab shows the outside line with a current time, and the charts show outside history.
3. **Back-out:** put the old sensor entities back and update the stack.
4. Then switch off the old Claude scheduled skill that wrote the IQAir values into Home Assistant.

## Phase 6: Test that Home Assistant being offline is survivable
1. Stop the Home Assistant VM/container for five minutes.
2. **Check:** the Fresh air tab still draws charts and shows the last-known figures with the "could not be reached, figures may be out of date" notice.
3. Start Home Assistant again.

## Phase 7 (optional): The public page (no sign-in)
1. Admin > Settings > Resident tabs: tick **Public fresh-air page (no sign-in)** (the Fresh air monitoring tab must also be on). Save.
2. Open `https://<your site>/fresh-air` in a private window. **Check:** the readings show without signing in, no hidden tower appears, no print button.
3. Share the link. To close it: untick the setting; the link then shows "This page is not switched on".
4. Before sharing widely, read the cautions in [privacy-pdpl.md](privacy-pdpl.md) (the outside figures come from a third-party site whose terms may not allow republishing).

## Phase 8: Finish the cutover items still open
- Cloudflare tunnel: repoint to `http://192.168.230.10:8080`; then remove `COOKIE_SECURE=false` from the stack.
- Delete the `users.sql` copies, and **delete the old Home Assistant token and `token.txt`** (`C:\Users\james\Downloads\test`).
- OPNsense: tidy the temporary rules once the above works.

## Routine afterwards
- Watchtower updates `app` and `collector` together (same image, same label).
- Weekly: glance at Admin > System; both "Outside station" and "Sensor history" should say working.
- If the outside line goes stale: Admin > System log shows "Outside station: page not updating / fetch failing". Run `--check` in the collector console.
- Backups: the stored outside readings and the tower history copy live in the app database, so the normal database backup covers them.
