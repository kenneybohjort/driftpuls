#!/bin/sh
# Bygger public/assets/tailwind.css utan att installera något på VM:en
set -e
cd "$(dirname "$0")"
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/app -w /app node:24-alpine \
  npx --yes tailwindcss@3.4.17 -c tailwind.config.js -i src/input.css -o public/assets/tailwind.css --minify
echo "Klart: public/assets/tailwind.css ($(wc -c < public/assets/tailwind.css) byte). Kör nu ./deploy.sh"
