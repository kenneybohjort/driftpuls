#!/bin/sh
set -e
cd "$(dirname "$0")"

# 1. Förkontroll av Docker och Docker Compose
if ! command -v docker >/dev/null 2>&1; then
  echo "Fel: 'docker' hittades inte. Installera Docker först." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Fel: 'docker compose' hittades inte. Installera Docker Compose v2-pluginet." >&2
  exit 1
fi

# 2. Skapa mappstruktur för beständig data
mkdir -p data/public-site/assets data/rapporter

# 3. Skapa .env och första admin-konto automatiskt vid nyinstallation
GENERATED_USER=""
GENERATED_PASS=""

if [ ! -f .env ]; then
  umask 077
  cat > .env <<'EOF'
# Automatiskt skapad av deploy.sh
PUBLIC_URL=
ADMIN_PORT=3000
PORTAL_PORT=3001
EOF
  chmod 600 .env
fi

# Om inga användare finns ännu och ADMIN_PASS saknas i .env -> generera startkonto
if [ ! -f data/users.json ]; then
  EXISTING_PASS="$(grep -E '^ADMIN_PASS=' .env 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
  if [ -z "$EXISTING_PASS" ]; then
    GENERATED_USER="$(grep -E '^ADMIN_USER=' .env 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
    [ -z "$GENERATED_USER" ] && GENERATED_USER="admin"
    GENERATED_PASS="$(tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c 16 || date +%s | sha256sum | head -c 16)"
    grep -vE '^ADMIN_(USER|PASS)=' .env > .env.tmp || true
    mv .env.tmp .env
    chmod 600 .env
    printf "ADMIN_USER=%s\nADMIN_PASS=%s\n" "$GENERATED_USER" "$GENERATED_PASS" >> .env
  fi
fi

# 4. Säkerställ att public/assets/tailwind.css finns
if [ ! -f public/assets/tailwind.css ]; then
  echo "=== Bygger saknad tailwind.css ==="
  ./build-css.sh
fi

# 5. Säkerställ att drift-admin (UID 1000:1000) äger data-mappen
if [ "$(id -u)" = "1000" ] && [ "$(id -g)" = "1000" ]; then
  : # Redan rätt ägare
elif [ "$(id -u)" = "0" ]; then
  chown -R 1000:1000 data/public-site data/rapporter
  chown 1000:1000 data
  for f in data/*.json data/*.jsonl; do
    [ -e "$f" ] && chown 1000:1000 "$f"
  done
else
  docker run --rm -v "$PWD/data:/data" node:24-alpine sh -c \
    'chown 1000:1000 /data && chown -R 1000:1000 /data/public-site /data/rapporter && for f in /data/*.json /data/*.jsonl; do [ -e "$f" ] && chown 1000:1000 "$f"; done'
fi

# 6. Städa bort eventuella gamla containrar
docker rm -f storningsgenerator drift-caddy 2>/dev/null || true

# 7. Bygg och starta drift-admin och drift-portal
docker compose up -d --build --force-recreate --remove-orphans

docker image prune -f >/dev/null 2>&1 || true
sleep 2

echo ""
echo "=== Loggar drift-admin ==="
docker logs --tail 5 drift-admin
echo "=== Loggar drift-portal ==="
docker logs --tail 5 drift-portal

echo ""
echo "=== Containerstatus ==="
docker compose ps

# 8. Visa tydlig sammanfattning med lokalt IP och portar
LOCAL_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -z "$LOCAL_IP" ] && LOCAL_IP="127.0.0.1"
ADMIN_PORT_VAL="$(grep -E '^ADMIN_PORT=' .env 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
PORTAL_PORT_VAL="$(grep -E '^PORTAL_PORT=' .env 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
[ -z "$ADMIN_PORT_VAL" ] && ADMIN_PORT_VAL="3000"
[ -z "$PORTAL_PORT_VAL" ] && PORTAL_PORT_VAL="3001"

echo ""
echo "=================================================================="
echo " Driftpuls & Publik Driftportal är igång!"
echo "------------------------------------------------------------------"
echo "   Driftpuls Admin    : http://${LOCAL_IP}:${ADMIN_PORT_VAL}"
echo "   Publik Driftportal : http://${LOCAL_IP}:${PORTAL_PORT_VAL}"
if [ -n "$GENERATED_PASS" ]; then
  echo "------------------------------------------------------------------"
  echo " NYINSTALLATION – Första inloggningskonto skapat:"
  echo "   Användarnamn : ${GENERATED_USER}"
  echo "   Lösenord     : ${GENERATED_PASS}"
  echo " (Sparat i .env och krypterat i data/users.json)"
fi
echo "=================================================================="
