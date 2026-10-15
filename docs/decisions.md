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
| Air tab reads Home Assistant from the server, read-only, with entity ids in configuration (not in the database or the browser) | The token must never reach a phone, the strict CSP stops the browser calling HA anyway, and one config line adds a tower. Readings are shown as recorded with their age; an old or missing sensor is shown as such, never filled in. Off unless fully configured |
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


## Photos are checked and faces covered on the phone before upload (2026-10-15)
Decision: every photo goes through a mandatory review screen on the device. Faces are covered automatically; the resident covers number plates and anything else by hand; only the covered image is uploaded and the original stays on the phone. Reasons: the privacy risk (faces, children, plates) is removed before the data reaches the server, Cloudflare or any backup; no hosted AI sees an unredacted photo; no per-image cost. Trade-off accepted: the platform keeps no unredacted original, so evidence value is lower and residents must keep their own originals for authorities. Faces are covered with heavy pixelation, not a light blur (a light blur can be partly reversed). Automatic number-plate detection is deferred: the popular detectors use copyleft licences that would affect resale, so a plate model needs its own licence check and testing. A second server-side detector pass (from the original design) is not built yet.

## Detector runs in an isolated page with its own CSP (2026-10-15)
The face detector's WebAssembly glue builds functions at run time, so it needs `unsafe-eval`. Adding that to the whole app would weaken the XSS defence everywhere. Decision: run the detector in a hidden same-origin page (`/face/face-worker.html`) whose CSP allows it but forbids everything else (no network except our origin, framed only by the app), and keep the main app's CSP unchanged. Detector files are self-hosted so no photo or request goes to Google.

## If the face detector cannot run, the resident covers faces by hand (2026-10-15)
Decision: show a clear warning and still allow the photo after manual review; never upload the original. A photo that cannot be decoded is blocked. Reason: a hard stop would stop reports on older phones; the review screen is the safeguard. Revisit once accuracy is measured (a stricter fail-closed rule is possible).

## Scorecard additions use stored data only (2026-10-15)
Added first-time fix, recurrence, hotspots, evidence completeness, time to management closure and reply time by priority because they come from fields we already hold. Hotspots use general area labels only, need at least 2 reports and leave out private reports, so no apartment or bay numbers appear. Recurrence only counts closures whose window has fully passed, so recent closures cannot flatter it. Wording follows the 13 Oct legal review ("Response scorecard", "Closures disputed by residents", "not a finding" banner); the 0-100 overall score is unchanged but a plain-figures-only scorecard is an open option for legal review.
