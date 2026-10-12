# Design decisions (read before changing behaviour)

| Decision | Why |
|---|---|
| Closed by management is a separate status (`mgmt_closed`) and only resident evidence marks fixed | The core aim is exposing cases closed but not actually fixed |
| Per-incident hash-chained event log with an admin "verify" | Credible, tamper-evident timeline for disputes with management |
| Linked duplicates, not merged | Preserves each resident's report and evidence; admins link into clusters |
| "Affects me" emails the management company every time, photo required (admin toggle), daily caps, one per user, not on own report | Builds pressure but stops spam; owner asked for the toggle |
| Neighbours never see names or apartment numbers; GPS blurred (3 decimals) for non-owners; "Keep private" | PDPL and safety. "Please log separately" interpreted as Keep private plus warnings |
| Photos re-encoded, EXIF/GPS stripped, served by signed expiring links, sent to the management company as links | Privacy; avoids personal data persisting in email attachments |
| Server AI **off**; optional bring-your-own-key AI runs in the resident's browser | Cross-border PDPL concern (Azure OpenAI not confirmed in UAE North); keep simple |
| Keyword drafting from the note as the default "auto title" | Free, no data leaves the app |
| Own TOTP implementation, scrypt, JWT in httpOnly cookie, CSRF header | Few dependencies, zero audit findings; strong defaults |
| SQLite for dev/tests, PostgreSQL for deployment, timestamps as ISO text | Portability and simple tests |
| Single container serving API + web | Simple to host anywhere |
| Test deployment on Unraid via GitHub image + Watchtower; Azure later | Owner's cost and speed preference; Azure remains the intended UAE-resident production target |
| Azure design: UAE North, stop DB nightly, app scales to zero with a "Start the service" page, second backup copy in UAE Central | Low cost while keeping data in-country |
| Scorecard is transparent: definitions shown, low-sample warning, demo-data banner | Fairness and defensibility; legal review still pending |
| Reporting is cheap: no email verification in v1; invite code gate | Pilot with a few people |
| English only for v1 | Scope |
| Product is generic: "the management company", not a named company | Reusable for any community/management firm; DH-specific naming removed from code and docs |


## 2026-10-09: Per-resident incident ID
Each resident who taps "This affects me too" can record the management company's reference for their own report (`affects.mgmt_case_number`). It is private to that resident and the admins, and is included in the email to management. The shared incident-level case number is unchanged. Buildings are named MR 1, MR 2, MR 3.


## 2026-10-09: Email comes from the resident, not the platform
Management is more likely to act on an email from a named resident's own address than on one from a platform. Default is now `mailto:` from the resident's own email app; the platform records the report and the resident's confirmation. Trade-off: delivery cannot be verified and photos are links. Server-sent email remains as an admin option. Adding yourself to a report no longer requires a photo (recommended only).


## 2026-10-09: Approval is a setting, invite code is the fast lane
Open sign-up is risky for a platform that shows reports to neighbours. Approval is an option (default off during testing). With it on, an invite code or a trusted resident link skips the wait, so friends and neighbours are not slowed down. Declined people are blocked at sign-in with a clear message.


## Terms of use and sign-up consent (2026-10-09)
Decision: two separate required tick boxes (privacy/data sharing, terms) with a short data notice on the form. Reason: PDPL consent should be specific and informed, and terms acceptance is a different thing from data consent. Terms are a pilot draft under UAE law (Dubai courts), pending lawyer review; the operator entity is deliberately not named yet.


## Two report types for now (2026-10-10)
Decision: the report form offers Maintenance (default) or Security only. Reason: fewer taps and no wrong-category guesses in the first pilot. The 15 detailed categories stay valid in the API and data so reports can be re-categorised by moderators and the form can offer them again later.

## No invite code; approve one by one (2026-10-10)
The pilot is small, so an admin checks each person (tower, apartment, email) rather than sharing a code that can leak. Approval defaults on. Resident invite links stay as an optional shortcut (off by default).

## Add to home screen is a prompt, not an install (2026-10-10)
Browsers will not add a shortcut without the person's tap, and iPhone has no install API. We show platform-specific steps once after first sign-in, and a one-tap button where the browser provides one (Chrome family).

## Version strip and Watchtower feed (2026-10-10)
Version is shown to everyone (not secret, useful to residents reporting a bug); update history is staff-only. The app is not given Docker socket access (too much power); instead Watchtower pushes its notices to the app through a secret-protected webhook.

## Metrics: resident-safe vs staff-only (2026-10-10)
Decision: everything computed from reports (rates, ages, response times, top-affected) is shown to all signed-in residents on the scorecard; operational chase lists (not yet emailed, people counts) are staff-only. Reason: transparency is the point, but operational lists add little for residents. A logged-out public page is deferred until the wording is legally reviewed.


## 2026-10-12: Private tracking tool, login-only, neutral wording (v0.4.0)
- The platform is a private tracking tool for residents, **not** a tool to expose or complain about the management company. Nothing is public: every screen needs sign-in, there are no public KPIs, scores or issues, and link previews are generic. Reason: owner's positioning; avoids reputational and legal exposure.
- The standard email is a plain, courteous issue report with a reference, no disclaimers and no tool name; it says only "This report is being tracked...". Notice and legal wording is **not** in the app; it sits on a review sheet (docs/review-sheet-notice-wording.md) for others to comment on.
- Tracking reference with a Luhn mod 36 check character. Reason: lets replies and forwards be matched to a case and catches typing errors; it is guessable by design so it never grants access.
- Tracking mailbox on Cc by default (setting). Reason: the Cc copy reaches the tracker at the moment of sending and gives a real sent time. Trade-off: management staff see the address, so it needs a neutral name.
- Event times come from the email (original header > forwarded text > forward header > resident-entered > receipt); receipt time is always kept separately and immutable; each time shows its source. Reason: the email's own timestamp is the more faithful record; a sender controls the header, so it is a record of what the email says, not proof.
- Management replies are accepted only from configured sender domains, only when SPF/DKIM/DMARC passes and only when they match an existing case; everything uncertain (including quoted-text guesses and two references in one message) goes to a person (Admin > Mail). Reason: a reference is guessable, so it must not let outsiders write to a case.
- Each resident's report is its own case: "This affects me too" now creates the resident's own reference and email; the backend links and counts them. Reason: management cannot aggregate separate complaints, so quantity is needed for action. Implemented on the `affects` row (not as separate incidents) to keep the existing link/count model.
- Photos: signed expiring links in the email remain the one exception to "nothing is public" (mailto cannot attach files). **Open:** attach redacted photos in a native app, or accept links.
- Closure quality: a closure with no cause/action/prevention is labelled "Closure details not provided" (factual, no judgement) and offers a polite follow-up email.
