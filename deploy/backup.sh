#!/bin/sh
# Encrypted logical backup of the ActualPay database. Run from cron on the DB host
# (or a backup host) and ship the output OFF the machine.
#
#   BACKUP_RECIPIENT=age1... ./deploy/backup.sh /backups
#
# Requires: pg_dump, age (https://age-encryption.org). The recipient is a PUBLIC
# key; keep the private key offline, away from the server. Test a restore (below)
# regularly: a backup you have not restored is a hope, not a backup.
set -eu
DEST="${1:?usage: backup.sh <directory>}"
: "${BACKUP_RECIPIENT:?set BACKUP_RECIPIENT to an age public key}"
: "${PGDATABASE:=actualpay}"
umask 077
mkdir -p "$DEST"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST/actualpay-$STAMP.sql.age"
pg_dump --format=plain --no-owner --no-privileges --serializable-deferrable "$PGDATABASE" \
  | age -r "$BACKUP_RECIPIENT" > "$OUT.partial"
mv "$OUT.partial" "$OUT"
echo "wrote $OUT"
# Restore drill (on a scratch database, never on production):
#   age -d -i key.txt actualpay-<stamp>.sql.age | psql -v ON_ERROR_STOP=1 scratch_db
#   NODE ... node dist/db.mjs status    # all migrations applied
