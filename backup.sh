#!/usr/bin/env bash
# ==============================================================================
# Driftpuls: Säkerhetskopiering (backup.sh)
# Skapar en komprimerad kopia av data/ och .env i ./backups/
# Rensar automatiskt säkerhetskopior som är äldre än 30 dagar.
# ==============================================================================
set -euo pipefail

cd "$(dirname "$0")"

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
TIMESTAMP="$(date +%Y-%m-%d_%H%M%S)"
ARCHIVE_NAME="drift-backup-${TIMESTAMP}.tar.gz"
ARCHIVE_PATH="${BACKUP_DIR}/${ARCHIVE_NAME}"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR" 2>/dev/null || true

ITEMS=()
[ -d "data" ] && ITEMS+=("data")
[ -f ".env" ] && ITEMS+=(".env")

if [ "${#ITEMS[@]}" -eq 0 ]; then
  echo "⚠️  Ingen data/ eller .env hittades att säkerhetskopiera."
  exit 0
fi

tar -czf "$ARCHIVE_PATH" --exclude="data/public-site" "${ITEMS[@]}"
chmod 600 "$ARCHIVE_PATH" 2>/dev/null || true

SIZE="$(du -h "$ARCHIVE_PATH" | cut -f1)"
echo "✅ Säkerhetskopia skapad: ${ARCHIVE_PATH} (${SIZE})"

# Rensa kopior äldre än RETENTION_DAYS dagar
DELETED=$(find "$BACKUP_DIR" -maxdepth 1 -name "drift-backup-*.tar.gz" -type f -mtime +"$RETENTION_DAYS" -print -delete | wc -l || true)
if [ "$DELETED" -gt 0 ]; then
  echo "🧹 Rensade ${DELETED} äldre säkerhetskopior (> ${RETENTION_DAYS} dagar)."
fi
