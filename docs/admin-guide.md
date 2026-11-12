# Admin guide

## Roles
- **Resident:** reports, "affects me", adds case numbers (the reporter's, and each affected resident's own incident ID, which is included in the email to management), confirms fixed / poorly fixed with a photo.
- **Committee:** read-only view with blurred locations (for resident committee members).
- **Admin:** everything below. **Super admin:** also removes demo data.

## Everyday tasks (Admin menu)
- **Reports:** filter by flags (no case number, overdue, disputed closure, awaiting verification, unlinked duplicates). Open a report to add the management case number, move status, add internal or public notes, edit title/category, resend the management email, **Verify history** (checks the tamper-evident chain).
- **Link duplicates:** tick several reports and Link. They stay separate but are shown as one cluster in KPIs.
- **Users:** change role (only a super admin can grant admin), deactivate, reset password, reset MFA.
- **Settings:** the affects-me photo toggle, daily caps, reminder timing, SLA targets, registration.
- **Data:** CSV import, Excel and CSV export, audit log, remove demo data.

## First-time setup
1. Create the admin (see docs/unraid.md), sign in, enrol MFA.
2. Admin > Settings: set the real tower names (default MR 1-C), the management email, SLAs and toggles. 3. Remove demo data if you seeded.
4. Invite testers with the invite code.

## CSV import of existing issues
Admin > Data > Import (use **dry run** first). Columns (header row): `title` (required), `description`, `category`, `severity`, `status`, `reported_at`, `emailed_at`, `case_number`, `case_number_at`, `resolved_at`, `updated_at`, `tower`, `unit`, `location`, `reporter_email` (optional, links to an existing user).
- Dates are day-first, Dubai time (e.g. `03/10/2026 14:30`).
- `category` one of the list in `api/src/domain.ts` (e.g. plumbing_leak, electrical, lift, hvac_ac, ...); spaces/slashes are normalised.
- `severity`: low, normal, high, urgent. `status` accepts words like open, in progress, closed, fixed, resolved, poorly resolved, reopened.
- Imported rows are marked `source=import`, send no emails, and count in the scorecard.

## Test data with photos (MR Test / Test01)
Loads 18 labelled TEST reports (refs `TEST-0001`.., case numbers `TEST-SR-20xx`) for tower **MR Test**, apartment **Test01**, from a folder of photos plus `test-data-incidents.json` (file names; copy in `api/src/scripts/test-data/incidents.json`). It sends no email, flags everything as demo (remove with Admin > Data > Remove demo data), needs an existing admin, and will not run twice.

On Unraid (needs the build that contains the script):
1. Copy the photos and `test-data-incidents.json` into `/mnt/user/appdata/neighbourhood/files/_testdata` (the app sees it as `/data/files/_testdata`). Delete the folder afterwards.
2. In the Unraid terminal: `docker exec -u node -e FORCE_SEED=true <app container> node api/dist/scripts/seed-test.js /data/files/_testdata` (find the name with `docker ps`).
3. Dev: `npm run seed:test -w api -- "<photo folder>"`.

## Export
Admin > Data > Export: **Download all reports (Excel)** gives a formatted workbook (a Summary sheet with totals by status, category and tower, and a Reports sheet with readable labels, dates in Dubai time, filters, colour-coded status and an age-in-days column). **Download all reports (CSV)** gives the same rows with raw codes and ISO timestamps, for scripts or re-import (formula-injection safe). Neither contains resident names or emails. Both downloads are audit-logged.

## Locked out or forgotten admin password
Run create-admin again for the same email; it resets the password (and, from the next image, any lockout):
`docker exec -it -e ADMIN_PASSWORD='ChooseA-LongPassword-1' neighbourhood-app-1 node api/dist/scripts/create-admin.js you@example.com "Your Name"`
Older images do not clear a lockout: run `docker exec neighbourhood-db-1 psql -U np -d np -c "update users set failed_logins=0, locked_until=null;"` or wait 15 minutes. Five wrong passwords lock an account for 15 minutes.


## WhatsApp sharing
Residents get a Share sheet with "Send on WhatsApp". To add a "Post in our WhatsApp group" button, paste the group's invite link (WhatsApp > group > Invite via link) in Settings. WhatsApp cannot pre-fill a post into a chosen group, so the message is copied and the group opens for pasting. Link previews with a photo only work when the app is on a public HTTPS address.


## How reports reach management
Default: after reporting, the resident's own email app opens with the email written; they press Send and confirm. Check Settings > "How reports reach management" to switch to server-sent email. Reports show "waiting for the reporter to send their email" until confirmed.


## Adding people
- **Add directly:** Admin > People > + Add a person. They are emailed a set-password link (7 days); the link is also shown so you can send it yourself.
- **Let people request access:** Settings > turn on *Approve new sign-ups*. Requests appear at the top of People with Approve / Decline; you also get an email and a number on the People tab. There is no invite code: every request is approved one by one (Approve new sign-ups is on by default).
- **Resident invites:** each resident has a personal link under Profile > Invite neighbours. With *Trust residents' invite links* on, people who use it are approved at once; otherwise they wait for you and you see who invited them.
- Roles: only a super admin can add or promote admins. Declined people cannot sign in.


## Join requests and terms
People reach the form from the login page ("Request to join"). They enter name, email, tower, apartment and a password, read the data notice, and tick the privacy and terms boxes. With "Approve new sign-ups" on (Settings), the request waits in People for Approve or Decline. The terms and privacy text are at /terms and /privacy.


## Report types
Residents choose Maintenance or Security when reporting. Older, detailed categories still exist on earlier reports and you can change a report's category from its page in Admin.

## System tab (versions and updates)
Admin > System shows the running version/build and a history of starts, updates and Watchtower messages. Compare the strip at the top of any page with the build number of the latest green "Publish image" run on GitHub: if they match, the update has arrived. Watchtower checks every 5 minutes. The raw log is in Unraid > Docker > watchtower > Logs.

## Insights panel
Admin > Reports opens with Insights (last 90 days). Tiles with "Show these" filter the list below. Watch "Saved but not yet emailed": in the default mode the resident sends the email, so reports the resident never confirmed are not yet with management. "Waiting longest for a reply" is the list to chase.


## Photo check and the scorecard (2026-10-15)
- **Photos are covered on the resident's phone.** Residents see a "Check your photo" screen: faces are covered automatically, they can drag boxes over number plates or anything else, and only the covered image is uploaded. You will never see an unredacted original. If a resident reports a face or plate showing, ask them to retake the photo; there is no admin tool to edit an uploaded photo. First use on a phone downloads about 7 MB.
- **New scorecard panels:** fixes that held first time, time to management closure, reply time by priority, did the problem come back (30/60/90 days), where reports cluster, and evidence behind the figures. Definitions are under "How this is measured" on the page. "Where reports cluster" only shows general areas with at least 2 reports and leaves out private reports.

## Fresh air monitoring tab (Home Assistant sensors)
Shown as **Fresh air monitoring** to residents (was AirCon). Turn it on or off for residents in **Admin > Settings > Resident tabs** (it also needs the setup below). Shows the fresh-air temperature and humidity for each tower (same large tiles in every tower), an all-towers table (temperature, humidity, dew point, moisture in the air), three charts at the bottom (temperature, humidity, and moisture in the air, each with the outside reading as a purple Outside line; all towers on one chart; the dew point chart was removed on 2026-11-12 but the dew point figure stays in the table). Buttons above the charts switch between **Day** (last 24 hours, the default), **Week**, **Month** (hourly averages) and **All time** (daily averages); this needs Home Assistant to hold long-term statistics for the sensors. A sensor with no current reading shows its last known reading, marked old, and the outside temperature, refreshed every minute, to all signed-in residents. It stays hidden until set up.
1. In Home Assistant create a **non-admin user** (for example `neighbourhood-readonly`), sign in as it, open its profile and create a **long-lived access token**.
2. Find the entity ids in HA under Settings > Devices & services > Entities (for example `sensor.thermo_hygrometer_temperature` and `sensor.thermo_hygrometer_humidity` for an X-Sense thermo-hygrometer, which the X-Sense Home Assistant integration exposes as ordinary live sensors).
3. In the Unraid `.env` set `HA_URL` (an address the app container can reach, such as `http://192.168.1.20:8123`), `HA_TOKEN`, and `HA_AIR_SENSORS` as one line of JSON (see docs/configuration.md). Re-apply the compose file.
4. For a uHoo monitor, give the tower a `prefix` instead of listing every sensor, for example `{"name":"MR 2","prefix":"sensor.outside_tower_2_fresh_air_"}`; find the prefix by opening one of its sensors in HA (Settings > Entities) and removing the last word(s) of the entity id. Each reading gets a gauge with a Good / Fair / Poor label; the page lists how each band is decided. VOC and pressure are not rated. If a reading looks wrong (for example a very high nitrogen dioxide figure), check the sensor before residents see it, or switch AirCon off in Settings > Resident tabs.
5. A sensor id like `sensor.x` is read live. An id like `tower1:fresh_air_temperature` (shown in HA as "Entity not found" in History) is an **imported statistic**: it is read as an hourly average and labelled so. Both kinds can be used together.
6. To keep a tower out of sight until someone presses **Show**, add `"hidden":true` to its entry, for example `{"name":"MR 2","hidden":true,"prefix":"sensor.outside_tower_2_fresh_air_"}`. It is then left out of the table, charts and printout too. This only tidies the page: the figures are still available to anyone signed in.
7. The **Print / save as PDF** button opens the browser print dialog (choose "Save as PDF", or on a phone use Share > Save to Files / Print). The printout has the four-row all-towers table (no Good/Fair/Poor wording; the wettest tower is marked "highest" with a one-line comparison), the four charts and a short note on the figures, dated in Dubai time, ready to send to a maintenance team. Dew point and moisture are calculated from temperature and humidity, not measured.
8. **Outside line (recommended: the collector container).** The stack has a second container, `collector`, that fetches the public station page every 20 minutes and keeps the hourly figures in the app's database. Set `"outside":{"temperature":"app:outside_temperature","humidity":"app:outside_humidity"}` in `HA_AIR_SENSORS` (Portainer: Stacks > your stack > Environment variables > edit > Update the stack, tick re-pull image) and the Outside lines and tiles use it. The first start loads the readings collected since 25 Oct. Check it: **Admin > System** shows the newest outside report, and an "Outside station" line appears there if the fetch fails or the station stops updating. To see exactly what it reads, in Portainer open the `collector` container > Console > Connect and run `node api/dist/collector.js --check`. To add hours from a station readings CSV: copy the file in and run `node api/dist/collector.js --import-csv /path/file.csv` (existing hours are never overwritten). The same container also **copies the tower sensor history out of Home Assistant** into the app's database about once an hour (it needs `HA_URL`, `HA_TOKEN` and `HA_AIR_SENSORS` in its environment, already in the supplied compose files). The first run copies everything Home Assistant holds; to force it now, in the collector's Console run `node api/dist/collector.js --sync-ha`. **Admin > System** shows "Tower history copy, newest hour" and the log shows "Sensor history" entries when it starts or stops working. If Home Assistant is offline the page keeps working from the copy: charts as normal, tiles marked old readings. Only sensors that have long-term statistics in Home Assistant (a measurement state class) are copied, and only the ones listed in `HA_AIR_SENSORS`. Keep Home Assistant's own backups too. The older outside-history way follows, using Home Assistant statistics; it is no longer needed.
   Older way: put the outside sensor under `outside.temperature` in `HA_AIR_SENSORS`, for example `"outside":{"temperature":"sensor.palm_outside_temperature","humidity":"sensor.palm_outside_humidity"}` (use your real entity ids; the new Proxmox stack's Portainer variable must contain this block too, then redeploy the stack). The Week/Month/All time ranges read Home Assistant's long-term statistics, so the sensor needs a measurement state class. To fill in the outside history from before it was recorded, run once `tools/ha-import-statistics.py` on any computer that can reach Home Assistant: `pip install websocket-client`, put a long-lived token in the `HA_TOKEN` environment variable, then `python3 tools/ha-import-statistics.py iqair-palm-readings.csv --url http://<ha-address>:8123 --dry-run`, and again without `--dry-run`. It only adds hours earlier than the entity's first statistic. `--external` imports the history as `iqair:palm_temperature` instead (then use that id in the layout). `--metric humidity` does the same for humidity (default sensor `sensor.palm_outside_humidity`, external id `iqair:palm_humidity`). To check whether Home Assistant's outside values are the real station readings, run it with `--compare` first: it writes nothing and prints how many hours match the CSV and which differ.
9. Tower names are free text; use the names residents know. A sensor that is missing, `unavailable`, or has not reported for 120 minutes (`HA_STALE_MINUTES`) shows as "Sensor not reporting" or "old reading". Each figure shows the exact time of its last reading (Dubai time).
Temperatures in °F are converted to °C. Readings are shown as recorded; they are not a measurement standard or a finding.

### Public page (no sign-in)
In **Admin > Settings > Resident tabs** tick **Public fresh-air page (no sign-in)** and save. The link is `https://<your site>/fresh-air`. Anyone with the link sees the readings, read-only; hidden towers are left out completely. Untick to close it. The Fresh air monitoring tab setting must also be on. Rollout steps: [deployment-proxmox.md](deployment-proxmox.md).

## Smells tab (odour reports)
Residents log smells under **Smells**; you see exactly which flats under **Admin > Smells**. Neighbours only ever see counts per building and group of levels (fewer than 3 shows as "fewer than 3").
- **Plan view:** each tower from the top (penthouses) down, flats 1-5 | 6 | 7-11 with the flat type letters. Darker cells mean more reports. Tap a flat to filter the log below; tap again to clear. Townhouse blocks are shown as numbered tiles.
- **Patterns to look at:** the same flat position reported on 3 or more levels (a vertical stack, so think shared riser or duct), and 3 or more flats reporting on one level (think corridor or that floor's plant). They are prompts for investigation, not findings.
- **Filters:** 7, 30, 90 days or all time, smell type, where it was noticed. **Download CSV** gives every report with level, flat and type (audit-logged). **Download PDF** makes a report for the management company that follows the filters you have set: the numbers, charts, a plan of each tower with the affected flats shaded and numbered, the townhouses and the log of reports. Residents' notes are not in the PDF. Open it and read it before you send it; the app never sends it for you. It says on every page that the figures are resident reports, not measurements. Admins (not committee) can delete a report.
- **Settings > Resident tabs:** tick or untick **Smells tab** (and **Fresh air monitoring tab**) to show or hide the tab for residents. **Settings > Smell reports:** reports per resident per day; townhouses per block; which townhouse blocks to include (for example `1, 2, 3`). To hide a tower (such as MR 4-6) remove it from **Towers** on the same page.
- Demo data from `npm run seed` includes smell reports; **Remove demo data** deletes them. A resident's smell reports are in their data export and are deleted if they erase their account.
