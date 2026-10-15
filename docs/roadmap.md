# v1 pilot suggestions and next steps

**Do before the pilot:** set the real management company email; lawyer review of privacy notice and scorecard; wipe demo data; enable admin MFA; set an invite code.

**Quick wins during the pilot**
1. Web push notifications for case-number reminders and management replies.
2. Offline draft queue so reports made in a basement car park send later.
3. Automatic face blurring is done (on the phone, v0.4.0). Still to do: automatic number-plate detection (licence check), a labelled test set with a recall target, and a server-side second pass.
4. Email verification and phone OTP (or UAE Pass SSO) to stop fake accounts.
5. Daily digest mode for "affects me" emails so management is not flooded.
6. Auto-chase: scheduled escalation email when no case number or no update after N days.
7. Inbound email wiring (Power Automate or shared-mailbox rule posting to `/api/inbound/email`) so management replies update the case automatically.
8. Weekly scorecard email to committee members.
9. Azure Monitor alerts on errors and outbox failures.
10. Public scorecard only after legal review.
11. Arabic translation and right-to-left layout.
8. Air tab history (charts and thresholds, from Home Assistant history) and extra sensors such as pool readings. The first version (2026-10-15) shows live values only.
