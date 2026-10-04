# Admin guide

## Roles
- **Resident:** reports, "affects me", adds case numbers, confirms fixed / poorly fixed with a photo.
- **Committee:** read-only view with blurred locations (for resident committee members).
- **Admin:** everything below. **Super admin:** also removes demo data.

## Everyday tasks (Admin menu)
- **Reports:** filter by flags (no case number, overdue, disputed closure, awaiting verification, unlinked duplicates). Open a report to add the DH case number, move status, add internal or public notes, edit title/category, resend the DH email, **Verify history** (checks the tamper-evident chain).
- **Link duplicates:** tick several reports and Link. They stay separate but are shown as one cluster in KPIs.
- **Users:** change role (only a super admin can grant admin), deactivate, reset password, reset MFA.
- **Settings:** the affects-me photo toggle, daily caps, reminder timing, SLA targets, registration.
- **Data:** CSV import/export, audit log, remove demo data.

## First-time setup
1. Create the admin (see docs/unraid.md), sign in, enrol MFA.
2. Admin > Settings: set the real tower names (default Tower A-C), the DH email, SLAs and toggles. 3. Remove demo data if you seeded.
4. Invite testers with the invite code.

## CSV import of existing issues
Admin > Data > Import (use **dry run** first). Columns (header row): `title` (required), `description`, `category`, `severity`, `status`, `reported_at`, `emailed_at`, `case_number`, `case_number_at`, `resolved_at`, `updated_at`, `tower`, `unit`, `location`, `reporter_email` (optional, links to an existing user).
- Dates are day-first, Dubai time (e.g. `03/10/2026 14:30`).
- `category` one of the list in `api/src/domain.ts` (e.g. plumbing_leak, electrical, lift, hvac_ac, ...); spaces/slashes are normalised.
- `severity`: low, normal, high, urgent. `status` accepts words like open, in progress, closed, fixed, resolved, poorly resolved, reopened.
- Imported rows are marked `source=import`, send no emails, and count in the scorecard.

## Export
Admin > Data > Export CSV (formula-injection safe).
