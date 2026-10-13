# Legal review status (13 Oct 2026)

Source: the project's "Items to Check and Verify" checklist. **Nothing here is legal advice and nothing has been reviewed by a lawyer.** "Changed in the app" means the wording or behaviour was changed to reduce the risk; it still needs a lawyer to confirm.

## Changed in the app (needs lawyer confirmation)
| Checklist | What changed |
|---|---|
| 1.3 PDPL | Privacy notice rewritten: operator, purposes and consent basis, who sees what, hosting and processors, retention and backup ageing, rights, breach notice, age 18+. Notice version 2026-10-v2, so everyone re-accepts at next sign-in. |
| 1.4 / 1.24 Operator | Privacy notice and terms show the operator name and contact from `OPERATOR_NAME` / `OPERATOR_CONTACT`. Until set, a visible "Operator not yet named" warning is shown. |
| 1.5 Terms | Terms rewritten (12 clauses): private tracking tool, free and best-effort, declared units, resident-supplied information, false reports and impersonation, neutral wording, moderation. |
| 1.6 Anonymity | Privacy notice and terms say plainly that reports are not anonymous to the management company; neighbours never see name or apartment. |
| 1.8 Email volume | Terms ask residents to use "This affects me too" instead of sending near-duplicate emails (existing daily caps unchanged). |
| 1.10 Self-declared units | Terms: units are declared, may be checked, false identity or reports lead to removal. |
| 1.17 Cloud tunnel | Privacy notice discloses that Cloudflare carries traffic and photos and may handle them outside the UAE. A data processing agreement is still needed. |
| 1.13 / 1.19 / 1.21 AI | Privacy notice says the optional AI helper sends the photo and note from the resident's browser to their own provider, off by default. |
| 1.1 / 4.1 Wording | "Management scorecard" renamed "Response scorecard"; "Closed, but not fixed" is now "Closures disputed by residents"; status "Closed - disputed by resident"; scorecard shows a "Resident-recorded information, not a finding" banner. |
| 1.22 Emergencies | 999 / 998 / 997 shown on the report form, terms and privacy notice. |
| 1.23 Positioning | README, terms and privacy notice describe a private tracking tool for residents. |
| 1.27 Disclaimers | Liability limit rewritten so it does not exclude intentional harm, gross negligence or data protection duties. |

## Already in the app before this change
Sign-in-only access (no public pages), approval of each sign-up, photo EXIF removal, signed expiring photo links, photo warnings on the report form (no people, faces or number plates), neighbours never see names or apartments, "Keep private" option, data download and account deletion, emails sent from the resident's own account, daily caps, tamper-evident history.

## Outstanding: needs a lawyer or adviser
- UAE lawyer to review the privacy notice, terms and the new wording (1.1, 1.3, 1.5, 1.6, 1.22, 1.23, 1.27, 4.1) and confirm the "closed but not fixed" labelling is fair.
- Photos of people and private property: law and consent wording (1.2, 1.20).
- Operator entity: which company runs it, that its licence covers the activity, media/content licensing, and your Manifest agreement for IP and side-business clauses (1.4, 1.24, 1.26).
- Dubai Law 6 of 2019 and community rules; use of the developer's or management company's names (1.7).
- Data processing agreement with Cloudflare; confirm Azure backup region and retention (1.14, 1.17, 5.22).
- Domain registered in the entity's name with accurate registrant details (1.18, 1.25).

## Outstanding: needs action or a decision by you
- Set `OPERATOR_NAME` and `OPERATOR_CONTACT` on the server (the notice shows a warning until you do).
- Confirm the hosting wording in the privacy notice is true for your setup (home server behind Cloudflare, Azure UAE backups) and update it if that changes.
- Confirm the backup retention figures (30 daily, 12 monthly) are what you actually run.
- Decide on the open product questions (checklist section 6).

## Outstanding: not built yet (check before building)
- 14-day formal escalation notice (section 2): off by default; statute, recipient, forum and wording all need legal confirmation before it is switched on.
- Forwarded-email evidence capture (section 3): evidence labels, DKIM checks, redaction of third-party names, abuse controls.
- Closure-details scoring and right of reply (section 4).
- Humidity data upload and pool temperature board (1.11, 1.12): provider terms, occupancy inference, safety disclaimer.
- Face and number-plate redaction pipeline and its accuracy testing (1.19, 1.20, 5.12-5.15).
- Management replies stored in the app (1.9).
- Per-tenant terms, data processing agreements and other-country rules for resale (1.15).

## Outstanding: security checks (section 5)
Penetration test of inbound email and sign-in, MFA enforcement for admins, tunnel set-up and test from outside, backup restore drill, dependency and model licences, uptime monitoring.
