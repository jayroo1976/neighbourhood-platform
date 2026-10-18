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
- **Data:** CSV import/export, audit log, remove demo data.

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
Admin > Data > Export CSV (formula-injection safe).

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

## AirCon tab (Home Assistant sensors)
Shown as **AirCon** to residents. Turn it on or off for residents in **Admin > Settings > Resident tabs** (it also needs the setup below). Shows the fresh-air temperature and humidity for each tower (same large tiles in every tower), small tiles for any extra sensors, two charts at the bottom (fresh-air temperature and fresh-air humidity, all towers on one chart, last 72 hours; needs Home Assistant to hold history for the sensors; a sensor with no current reading shows its last known reading, marked old), and the outside temperature, refreshed every minute, to all signed-in residents. It stays hidden until set up.
1. In Home Assistant create a **non-admin user** (for example `neighbourhood-readonly`), sign in as it, open its profile and create a **long-lived access token**.
2. Find the entity ids in HA under Settings > Devices & services > Entities (for example `sensor.thermo_hygrometer_temperature` and `sensor.thermo_hygrometer_humidity` for an X-Sense thermo-hygrometer, which the X-Sense Home Assistant integration exposes as ordinary live sensors).
3. In the Unraid `.env` set `HA_URL` (an address the app container can reach, such as `http://192.168.1.20:8123`), `HA_TOKEN`, and `HA_AIR_SENSORS` as one line of JSON (see docs/configuration.md). Re-apply the compose file.
4. For a uHoo monitor, give the tower a `prefix` instead of listing every sensor, for example `{"name":"MR 2","prefix":"sensor.outside_tower_2_fresh_air_"}`; find the prefix by opening one of its sensors in HA (Settings > Entities) and removing the last word(s) of the entity id. Each reading gets a gauge with a Good / Fair / Poor label; the page lists how each band is decided. VOC and pressure are not rated. If a reading looks wrong (for example a very high nitrogen dioxide figure), check the sensor before residents see it, or switch AirCon off in Settings > Resident tabs.
5. A sensor id like `sensor.x` is read live. An id like `tower1:fresh_air_temperature` (shown in HA as "Entity not found" in History) is an **imported statistic**: it is read as an hourly average and labelled so. Both kinds can be used together.
6. To keep a tower out of sight until someone presses **Show**, add `"hidden":true` to its entry, for example `{"name":"MR 2","hidden":true,"prefix":"sensor.outside_tower_2_fresh_air_"}`. It is then left out of the table, charts and printout too. This only tidies the page: the figures are still available to anyone signed in.
7. The **Print / save as PDF** button opens the browser print dialog (choose "Save as PDF", or on a phone use Share > Save to Files / Print). The printout has the all-towers table, the four charts and the definitions, dated in Dubai time, ready to send to a maintenance team. Dew point and moisture are calculated from temperature and humidity, not measured.
8. Tower names are free text; use the names residents know. A sensor that is missing, `unavailable`, or has not reported for 120 minutes (`HA_STALE_MINUTES`) shows as "Sensor not reporting" or "old reading". Each figure shows the exact time of its last reading (Dubai time).
Temperatures in °F are converted to °C. Readings are shown as recorded; they are not a measurement standard or a finding.

## Smells tab (odour reports)
Residents log smells under **Smells**; you see exactly which flats under **Admin > Smells**. Neighbours only ever see counts per building and group of levels (fewer than 3 shows as "fewer than 3").
- **Plan view:** each tower from the top (penthouses) down, flats 1-5 | 6 | 7-11 with the flat type letters. Darker cells mean more reports. Tap a flat to filter the log below; tap again to clear. Townhouse blocks are shown as numbered tiles.
- **Patterns to look at:** the same flat position reported on 3 or more levels (a vertical stack, so think shared riser or duct), and 3 or more flats reporting on one level (think corridor or that floor's plant). They are prompts for investigation, not findings.
- **Filters:** 7, 30, 90 days or all time, smell type, where it was noticed. **Download CSV** gives every report with level, flat and type (audit-logged). Admins (not committee) can delete a report.
- **Settings > Resident tabs:** tick or untick **Smells tab** (and **AirCon tab**) to show or hide the tab for residents. **Settings > Smell reports:** reports per resident per day; townhouses per block; which townhouse blocks to include (for example `1, 2, 3`). To hide a tower (such as MR 4-6) remove it from **Towers** on the same page.
- Demo data from `npm run seed` includes smell reports; **Remove demo data** deletes them. A resident's smell reports are in their data export and are deleted if they erase their account.
