#!/usr/bin/env bash
# Verify a backup by restoring it into a fresh LOCAL D1 database and running integrity checks.
# Usage: scripts/restore-test.sh backups/arthika-YYYYMMDDTHHMMSSZ.sql
# This never touches the remote/production database.
set -euo pipefail
FILE=${1:?usage: restore-test.sh <backup.sql>}
STATE=$(mktemp -d)
npx wrangler d1 execute arthika --local --persist-to "$STATE" --file "$FILE" >/dev/null
q() { npx wrangler d1 execute arthika --local --persist-to "$STATE" --json --command "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s)[0].results)))'; }
echo "Companies:        $(q 'SELECT COUNT(*) AS n FROM companies')"
echo "Posted journals:  $(q "SELECT COUNT(*) AS n FROM journal_entries WHERE status = 'posted'")"
echo "Unbalanced posted entries (must be []):"
q "SELECT e.id FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id WHERE e.status = 'posted' GROUP BY e.id HAVING SUM(l.debit) <> SUM(l.credit)"
echo "Ledger total per company (debits - credits, must be 0):"
q "SELECT company_id, SUM(debit) - SUM(credit) AS diff FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.status = 'posted' GROUP BY company_id"
echo "Restore test database kept at: $STATE"
