# Backup and restore

| What | How | Where | Kept |
|---|---|---|---|
| Database (primary) | Azure PostgreSQL automatic backups, point-in-time restore | UAE North | 35 days |
| Database (second copy) | Nightly `pg_dump` by Container Apps Job `np-backup` at 22:30 Dubai (before the nightly database shutdown) | Storage account `...bk...`, container `dumps`, **UAE Central** | cool after 14 days, deleted after 180 days |
| Photos (primary) | Blob versioning + soft delete | UAE North | 30 days after deletion |
| Photos (second copy) | Blob object replication, continuous | UAE Central, container `photos` | follows source; soft delete 30 days |

Both regions are in the UAE, so PDPL data residency is kept. Cost is small (a Burstable DB's dumps and a few GB of photos: roughly a few dollars a month).

## Restore the database
- Recent mistake or corruption: Portal > PostgreSQL > Restore (point in time) into a new server, then repoint `DATABASE_URL`.
- Server lost: `az storage blob download --auth-mode login -a <backupAccount> -c dumps -n np-<stamp>.dump -f np.dump`, then `pg_restore --no-owner -d np np.dump`.

## Restore photos
Deleted blob: undelete in the portal (30 days). Whole account lost: copy the `photos` container from the UAE Central account back (`azcopy copy`).

## Test it
Do a restore into a scratch server once before the pilot and again each quarter. A backup you haven't restored is a hope. Check the job's last run in Container Apps > Jobs > Execution history; add an Azure Monitor alert on failed executions.

## Not covered
Secrets (GitHub secrets hold the originals), and the Bicep itself (in git). The `PG_ADMIN_PASSWORD` is also stored in the job; move to Key Vault references later.
