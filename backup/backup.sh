#!/usr/bin/env bash
# Nightly logical dump of the app database to a second storage account (UAE Central).
set -euo pipefail
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE=/tmp/np-$STAMP.dump
export PGSSLMODE=require
pg_isready -h "$PGHOST" -t 20 >/dev/null || { echo "database is stopped (sleep mode): nothing to back up"; exit 0; }
pg_dump -Fc --no-owner -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -f "$FILE"
[ "$(stat -c%s "$FILE")" -gt 1000 ] || { echo "dump suspiciously small"; exit 1; }
export AZCOPY_AUTO_LOGIN_TYPE=MSI
azcopy copy "$FILE" "https://$BACKUP_ACCOUNT.blob.core.windows.net/dumps/np-$STAMP.dump"
echo "backup ok: np-$STAMP.dump"
