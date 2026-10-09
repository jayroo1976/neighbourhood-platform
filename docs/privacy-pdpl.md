# Privacy and UAE PDPL notes (working document, not legal advice)

Have a UAE data-protection lawyer review before launch. Federal Decree-Law No. 45 of 2021 (PDPL) applies; check whether the management company's own policies add obligations if they become a joint controller.

## Data map
| Data | Why | Where | Retention |
|---|---|---|---|
| Name, email, phone (optional), tower, apartment | Account, put on reports to management | Azure PostgreSQL, UAE North | Until account deletion (anonymised, not kept) |
| Password | Sign-in | Scrypt hash only | Until deletion |
| MFA secret | Admin sign-in | AES-256-GCM encrypted | Until MFA reset/deletion |
| Report text, photos, GPS | Core service | PostgreSQL + Blob (UAE North); EXIF stripped | Kept as community record; photos deleted if reporter withdraws |
| Event history | Evidence of what management did and when | Hash-chained rows | Kept (anonymised after deletion) |
| Audit log | Admin accountability | PostgreSQL | Review annually |
| Outbound emails | Delivery to management | Outbox table, Azure Communication Services (UAE data location) | Prune sent mail after 90 days (to implement) |

## Principles built in
- Sign-up shows a plain-language "what we store / who sees it" box with two required tick boxes (privacy consent, terms of use); both are recorded with versions (`consent_version`, `terms_version`, `terms_at`).
- Consent recorded with notice version; re-consent prompt when the notice changes.
- Neighbours never see name or apartment number; GPS blurred for non-owners; "Keep private" option.
- Photo links are signed and expire; photos go to management as links, not attachments.
- Data export and erasure are self-service (Profile). Erasure anonymises the user and can withdraw their reports.
- Everything is hosted in UAE North; backups are not geo-replicated outside the UAE (second copy is in UAE Central).

## Open points to resolve
1. **AI suggestions**: the server-side option is OFF and unused. Residents can optionally connect their OWN Anthropic/OpenAI key in Profile; the key stays in their browser and the photo goes from their device to that provider, never through our server. That is the resident's own choice and transfer, but the privacy notice should say so. Server-side AI should stay off unless counsel agrees (cross-border transfer).
2. **Roles**: you are likely the controller; the management company receives data as a recipient. Document this and decide who answers data-subject requests.
3. **Third parties in photos**: warn users (done) and consider automatic face/plate blurring.
4. **Scorecard**: it publishes performance claims about a named company. Get legal review for defamation risk before sharing outside the pilot. Wording is evidence-based and definitions are shown.
5. **Breach process**: define who notifies the UAE Data Office and residents, and how fast.
6. **Retention schedule** for sent emails and old reports needs a decision.


## Resident-sent email
In the default mode the email goes from the resident's own account, so management sees their email address and name along with tower and apartment. The privacy notice should say so. Photo links in the email expire after the configured number of days.


## Sign-up requests
A request stores name, email, tower, apartment and who invited the person. Declined requests keep the record so the person cannot simply re-register with the same email; delete them from People if you do not want to keep them. Update the privacy notice to mention that a moderator reviews requests.
