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
