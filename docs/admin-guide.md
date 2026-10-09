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

## Export
Admin > Data > Export CSV (formula-injection safe).

## Locked out or forgotten admin password
Run create-admin again for the same email; it resets the password (and, from the next image, any lockout):
`docker exec -it -e ADMIN_PASSWORD='ChooseA-LongPassword-1' neighbourhood-app-1 node api/dist/scripts/create-admin.js you@example.com "Your Name"`
Older images do not clear a lockout: run `docker exec neighbourhood-db-1 psql -U np -d np -c "update users set failed_logins=0, locked_until=null;"` or wait 15 minutes. Five wrong passwords lock an account for 15 minutes.


## WhatsApp sharing
Residents get a Share sheet with "Send on WhatsApp". To add a "Post in our WhatsApp group" button, paste the group's invite link (WhatsApp > group > Invite via link) in Settings. WhatsApp cannot pre-fill a post into a chosen group, so the message is copied and the group opens for pasting. Link previews with a photo only work when the app is on a public HTTPS address.
