# Sleep mode (cost saving)

**What sleeps**
- **App:** scales to zero when idle. The first visit wakes it in a few seconds.
- **Database:** a scheduled job stops the PostgreSQL server at 23:00 Dubai time every night (after the 22:30 backup). Stopped servers are not billed for compute, only for storage.
- **Wake-up:** if the database is stopped, visitors see a "The service is asleep" page with a **Start the service** button. It starts the database (about 3 to 5 minutes) and the page opens the app by itself when ready. Anyone can press it, it is rate-limited, and the nightly job stops it again.

**How it works:** the app's managed identity has Contributor on the database server only. `/api/system/status` and `/api/system/wake` are served even when the database is down.

**Trade-offs to know**
- Reminders (case number nudges, verify-closed nudges) and email retries only run while the app is awake. They catch up on the next wake-up, so a nudge can be late if nobody opens the app. Emails to management for new reports and "affects me" are sent immediately when the resident submits, so they are not affected.
- Inbound replies from management (the webhook) arrive while the database may be down and will fail. Make the sender retry, or accept that these are processed only when awake. Wire this up carefully when you set up inbound email.
- Azure restarts a stopped PostgreSQL server after 7 days, but the nightly job stops it again each night.
- To change the shutdown time, edit `cronExpression` on `stopJob` in `infra/main.bicep` (UTC). For always-on during launch week, set the app `minReplicas` to 1 and disable the stop job.
