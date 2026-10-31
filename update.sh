#!/usr/bin/env bash
# ==============================================================================
# Driftpuls: CVE- & Versionsuppdatering (update.sh)
#
# Användning:
#   ./update.sh              # Tar backup, bygger om med senaste CVE-patchar
#                            # (Node.js 24, Alpine, Nginx), kör tester och startar om.
#   ./update.sh --audit-fix  # Uppdaterar även npm-paket (package-lock.json) vid CVE
#                            # innan ombyggnad.
# ==============================================================================
set -euo pipefail

cd "$(dirname "$0")"

NODE_IMAGE=$(awk '/^FROM node:/ {print $2; exit}' Dockerfile || echo "node:24-alpine")
AUDIT_FIX=false
if [[ "${1:-}" == "--audit-fix" ]]; then
  AUDIT_FIX=true
fi

echo "========================================================"
echo "🛡️  Driftpuls — Update & CVE Patcher"
echo "========================================================"

# 1. Ta alltid en säkerhetskopia först
echo "📦 [1/6] Skapar säkerhetskopia av data/ och .env..."
./backup.sh

# 2. Läs av nuvarande versioner om containern är igång
OLD_NODE="ej igång"
OLD_ALPINE="ej igång"
if docker ps --format '{{.Names}}' | grep -q '^drift-admin$'; then
  OLD_NODE=$(docker exec drift-admin node -v 2>/dev/null || echo "okänd")
  OLD_ALPINE=$(docker exec drift-admin cat /etc/alpine-release 2>/dev/null || echo "okänd")
fi
echo "ℹ️  Nuvarande körmiljö: Node.js ${OLD_NODE} | Alpine Linux ${OLD_ALPINE}"

# 3. Om --audit-fix angavs, uppdatera package-lock.json först
if [ "$AUDIT_FIX" = true ]; then
  echo "🔧 Uppdaterar npm-paket (package-lock.json) med 'npm audit fix'..."
  docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/app" -w /app "$NODE_IMAGE" npm audit fix --omit=dev || true
fi

# 4. Hämta senaste bas-images och bygg ny image med --pull
echo "⬇️  [2/6] Hämtar senaste säkerhetspatchade bas-images (${NODE_IMAGE} & nginx:alpine) och bygger om..."
docker compose pull drift-portal
docker compose build --pull

# 5. Kontrollera npm-beroenden mot CVE-databasen i den nybyggda imagen
echo "🔍 [3/6] Kontrollerar npm-paket mot CVE-databasen (npm audit)..."
docker run --rm storningsgenerator-admin:local npm audit --omit=dev

# 6. Kör automatiska självtester i den nybyggda imagen innan driftsättning
echo "🧪 [4/6] Kör automatiska självtester (npm test)..."
docker run --rm storningsgenerator-admin:local npm test

# 7. Starta om containrarna med den verifierade imagen
echo "🚀 [5/6] Startar om containrar med den nya, verifierade imagen..."
docker compose up -d --remove-orphans

# 8. Verifiera hälsostatus och visa versionsskillnad
echo "🩺 [6/6] Verifierar hälsokontroller (/healthz)..."
ADMIN_PORT=$(grep -E '^ADMIN_PORT=' .env 2>/dev/null | cut -d= -f2 || echo "3000")
PORTAL_PORT=$(grep -E '^PORTAL_PORT=' .env 2>/dev/null | cut -d= -f2 || echo "3001")
ADMIN_PORT="${ADMIN_PORT:-3000}"
PORTAL_PORT="${PORTAL_PORT:-3001}"

OK=false
for _ in {1..15}; do
  if curl -fsS "http://localhost:${ADMIN_PORT}/healthz" >/dev/null 2>&1 && \
     curl -fsS "http://localhost:${PORTAL_PORT}/healthz" >/dev/null 2>&1; then
    OK=true
    break
  fi
  sleep 1
done

NEW_NODE=$(docker exec drift-admin node -v 2>/dev/null || echo "okänd")
NEW_ALPINE=$(docker exec drift-admin cat /etc/alpine-release 2>/dev/null || echo "okänd")

# Städa bort gamla oanvända image-lager
docker image prune -f >/dev/null 2>&1 || true

echo ""
echo "========================================================"
if [ "$OK" = true ]; then
  echo "✅ Uppdatering slutförd och båda containrarna svarar (healthy)!"
else
  echo "⚠️  Containrarna har startats, men /healthz svarade inte inom 15s."
  echo "   Kontrollera med: docker compose ps && docker compose logs --tail=30"
fi
echo "   Node.js-version : ${OLD_NODE} -> ${NEW_NODE}"
echo "   Alpine OS       : ${OLD_ALPINE} -> ${NEW_ALPINE}"
echo "========================================================"
