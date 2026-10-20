#!/usr/bin/env bash
# Export the production D1 database to a local SQL file (schema + data).
# Requires: wrangler logged in (npx wrangler login) or CLOUDFLARE_API_TOKEN with D1 read access.
# The file is written to ./backups/ (git-ignored). Store copies somewhere safe off this machine.
set -euo pipefail
mkdir -p backups
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="backups/ledgerfox-${STAMP}.sql"
npx wrangler d1 export ledgerfox --remote --output "$OUT"
sha256sum "$OUT" > "$OUT.sha256"
echo "Backup written: $OUT ($(du -h "$OUT" | cut -f1))"
echo "This is a backup file, not a verified restore. Test restores with scripts/restore-test.sh."
