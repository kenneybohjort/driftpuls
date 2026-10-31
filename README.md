# Driftpuls

Komplett, fristående system för driftinformation (**Stadsnät & Fjärrvärme**), publik driftportal, FrameFlow-larminkorg, utgående larmnotiser och automatiska incidentrapporter enligt **Cybersäkerhetslagen (NIS2)**.

Projektet är helt portabelt och körs i två isolerade Docker-containrar:
- **`drift-admin`**: Admin-gränssnitt, API och rapportmotor (Node.js 24 Alpine, kör som `UID 1000` på port `3000`).
- **`drift-portal`**: Statisk, skrivskyddad publik driftportal (Nginx Alpine på port `3001`).

---

## Huvudfunktioner

- **Flerkanalsutskick:** Genererar automatiskt färdiga texter för SMS, publik driftportal, sociala medier och intern NOC-rapport.
- **Publik Driftportal (Statisk & Skrivskyddad):** Visar aktiva driftstörningar med publik tidslinje för lägesuppdateringar, planerade arbeten och nyligen åtgärdade händelser (senaste 24h), samt `/rss.xml` och `/status.json`.
- **NIS2-incidentrapportering:** Automatisk sammanställning av incidentrapporter (Markdown + utskriftsvänlig HTML/PDF-vy) med lagstadgade tidsfrister (24h/72h/1 mån) och möjlighet att komplettera NIS2-uppgifter i efterhand i arkivet.
- **FrameFlow-integration & Nodregister:** Tar emot larm via både **Push (Webhook)** och **Pull (API-polling)** och matchar automatiskt mot nodregistret.
- **Utgående Larmnotiser (Webhooks):** Skickar automatiska notiser till Microsoft Teams, Slack, Discord, Mattermost eller ntfy vid publicering, uppdatering, stängning eller inkommande kritiska larm.
- **Säkerhet, Roller & 2FA:**
  - Rollbaserad behörighet (`admin` och `tekniker`).
  - Tvåfaktorsautentisering (**TOTP / RFC 6238**) kompatibel med Microsoft/Google Authenticator, Bitwarden och 1Password.
  - Sök- och filtrerbar revisionslogg (`audit.jsonl`) direkt i webbgränssnittet.

---

## Installation & Uppstart på en ny server

### 1. Förkrav på servern
Servern behöver ha **Git**, **Docker** och **Docker Compose v2** installerat.
*(På Ubuntu/Debian kan du vid behov installera Docker med `curl -fsSL https://get.docker.com | sh`).*

### 2. Ladda ner och starta applikationen
Klona ditt privata GitHub-repo och kör driftsättningsskriptet `./deploy.sh`:

```bash
git clone https://github.com/kenneybohjort/driftpuls.git driftpuls
cd driftpuls
./deploy.sh
```
*(Använder du SSH-nycklar: `git clone git@github.com:kenneybohjort/driftpuls.git driftpuls`)*

### Vad gör `./deploy.sh` vid första körningen?
1. Skapar `.env` (med rättigheter `0600`) om den saknas.
2. Skapar mappstrukturen under `data/` med rätt ägarskap (`UID 1000:1000`).
3. Genererar automatiskt ett första administratörskonto (`admin` + ett slumpat 16-teckens lösenord) om `data/users.json` saknas, och **skriver ut inloggningsuppgifterna direkt i terminalen**.
4. Bygger och startar containrarna `drift-admin` och `drift-portal` med `restart: unless-stopped`.

> **Tips – Eget startlösenord eller publik URL före start:**
> Om du vill ange egen port eller publik adress innan första starten kan du kopiera mallen först:
> ```bash
> cp .env.example .env
> nano .env
> ./deploy.sh
> ```

### 3. Flytta med data från en tidigare server (Valfritt)
Om du flyttar **Driftpuls** från en befintlig server till en ny har du två enkla sätt:
- **Via webbgränssnittet:** Logga in i nya Driftpuls &rarr; **⚙️ Integrationer &rarr; 💾 Backup & Uppdatering** &rarr; välj din nedladdade `.json`-backupfil och klicka **Återställ från backup**.
- **Via `.tar.gz`-arkiv i terminalen:** Kopiera över en arkivfil från `./backups/` och packa upp i projektmappen innan du kör `./deploy.sh`:
  ```bash
  tar -xzf drift-backup-YYYY-MM-DD_HHMMSS.tar.gz
  ./deploy.sh
  ```

---

## Portar & Åtkomst

När `./deploy.sh` är klar når du tjänsterna direkt via serverns IP-adress eller hostnamn:

| Tjänst | Direktåtkomst (`HTTP`) | Beskrivning |
| :--- | :--- | :--- |
| **Driftpuls Admin** (`drift-admin`) | **`http://<server-ip>:3000`** | Administrationsgränssnitt, larminkorg, NIS2 & inställningar |
| **Publik Driftportal** (`drift-portal`) | **`http://<server-ip>:3001`** | Skrivskyddad publik statussida, `/rss.xml` och `/status.json` |

*(Portarna kan ändras via `ADMIN_PORT` och `PORTAL_PORT` i `.env`).*

---

## Uppdatera applikationen (Git + CVE-patchar)

När du vill hämta nya uppdateringar från GitHub och samtidigt uppdatera bas-images (Node.js 24, Alpine Linux, Nginx) på servern:

```bash
git pull
./update.sh
```

`./update.sh` utför automatiskt i ordning:
1. **Säkerhetskopia:** Kör `./backup.sh` och sparar en tidsstämplad `.tar.gz`-kopia av `data/` och `.env` i `./backups/`.
2. **Bas-image-uppdatering:** Hämtar senaste säkerhetspatchade `node:24-alpine` och `nginx:alpine` (`docker compose build --pull`).
3. **CVE-granskning (`npm audit`):** Kontrollerar att inga kända sårbarheter finns i npm-paketen (kör `./update.sh --audit-fix` om `package-lock.json` behöver patchas).
4. **Automatiska självtester (`npm test`):** Kör samtliga enhets- och API-tester i den nybyggda imagen innan driftsättning.
5. **Omstart & Hälsokontroll:** Startar om containrarna och verifierar att `/healthz` svarar `200 OK`.

---

## Användarhantering, Roller & 2FA (Webb-GUI & CLI)

Du hanterar användarkonton, roller (`admin` / `tekniker`), lösenord och tvåfaktorsautentisering (TOTP 2FA) direkt i webbgränssnittet under **⚙️ Integrationer &rarr; 👤 Användare & Lösenord**.

Du kan även hantera användare via kommandoraden på servern:

```bash
# Lista alla användare, deras roll och 2FA-status
docker exec -it drift-admin node users.js list

# Lägg till användare (välj roll: admin eller tekniker, standard är admin)
docker exec -it drift-admin node users.js add anna tekniker
docker exec -it drift-admin node users.js add erik admin

# Byt lösenord eller ändra roll
docker exec -it drift-admin node users.js passwd anna
docker exec -it drift-admin node users.js role anna admin

# Nollställ 2FA om en användare tappat sin telefon
docker exec -it drift-admin node users.js 2fa-off anna

# Ta bort en användare
docker exec -it drift-admin node users.js remove anna
```

---

## Säkerhetskopiering & Loggrotation

All beständig driftdata lagras i `./data/` (som är exkluderad i `.gitignore` så att varken lösenord, `.env` eller kunddata någonsin hamnar på GitHub).

- **Via webbgränssnittet:** Gå till **⚙️ Integrationer &rarr; 💾 Backup & Uppdatering** för att ladda ner eller återställa en komplett `.json`-säkerhetskopia.
- **Via kommandorad / Cron:** Kör `./backup.sh` för att skapa ett komprimerat arkiv i `./backups/drift-backup-YYYY-MM-DD_HHMMSS.tar.gz` (rensar automatiskt kopior äldre än 30 dagar).
- **Automatisk loggrotation:** Revisionsloggen `data/audit.jsonl` roteras automatiskt vid `5 MB` (`audit.jsonl.1` &ndash; `.3`).
