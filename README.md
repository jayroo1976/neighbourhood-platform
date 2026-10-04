# Neighbourhood Reporting Platform

Resident-run incident reporting for Dubai Holding communities. Residents photograph an issue, the app emails the management company and records every step; neighbours tick "affects me"; a scorecard shows how management is performing, especially cases marked closed that are not fixed.

## Run locally
```bash
npm install
cp .env.example api/.env     # defaults work for dev (sqlite, console email)
npm run seed                 # demo community, users (@pilot.test), 26 sample issues
npm run dev:api              # http://localhost:8080
npm run dev:web              # http://localhost:5173
npm test
```
Demo logins are printed by the seed script. Create a real admin with `npm run create-admin -w api`. Demo data can be wiped by a super admin in Admin > Data.

## Deploy to Azure (UAE North)
1. Create the GitHub repo and push.
2. Create an Entra app registration with a federated credential for the repo (OIDC), give it Contributor on a resource group. Add GitHub secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `PG_ADMIN_PASSWORD`, `JWT_SECRET`, `FILE_SIGNING_SECRET`, `MFA_ENCRYPTION_KEY`, `INBOUND_EMAIL_SECRET` (each `openssl rand -base64 48`) and variables `BACKUP_JOB` (`np-backup`), `RESOURCE_GROUP`, `ACR_NAME`, `CONTAINER_APP`, `DH_EMAIL`, `APP_BASE_URL`.
3. Run the **Infra** workflow (validate first with `az deployment group what-if`; the Bicep is untested). Then push to `main`: **Deploy** builds the image in ACR and updates the app.
4. Create the first admin: `az containerapp exec` and run `node api/dist/scripts/create-admin.js`.
5. Set `EMAIL_FROM` to the ACS domain sender and wire inbound mail (see docs/roadmap.md).

Sleep mode: the database stops nightly and a "Start the service" page wakes it (docs/sleep-mode.md).

Test on your own server: see docs/unraid.md (docker-compose.unraid.yml).

Backups: nightly database dump and continuous photo copy to a second UAE region; see docs/backup-restore.md.

## Layout
`api/` Express + TypeScript (knex; SQLite dev, PostgreSQL prod) · `web/` React PWA · `infra/` Bicep · `docs/` privacy, security, roadmap.
Run a single replica: the reminder scheduler runs in-process.
