# Salto Access Matrix

Zutrittmatrix-Visualisierung für **Salto Pro Access Space**.  
Holt CSV-Exporte automatisch per FTP/SFTP und stellt sie als interaktive Matrix im Browser dar — mit Bereichen, Gruppen, Batteriestatus und optionaler Authentifizierung via Authentik.

```
  Salto Pro          FTP / SFTP        Docker            Browser
  Access Space  ──►  Server       ──►  Container   ──►  :3000
  (CSV-Export)       (Auto-Sync)       (Node.js)         (Matrix)
```

---

## Screenshots

| Personen-Ansicht | Gruppen-Ansicht | Bereiche-Ansicht |
|:---:|:---:|:---:|
| Personen mit Gruppenrechten | Gruppen × Türen | Türen pro Bereich mit Gruppen |

---

## Features

- **Drei Ansichten** — Personen, Gruppen, Bereiche
- **Bereiche als Spalten-Header** — Türen gruppiert nach Gebäudebereich
- **Effektive Rechte** — Gruppenrechte + Direktzutritt werden aufgelöst und farblich unterschieden
- **Gruppierte Personen-Ansicht** — optional, zeigt pro Gruppe nur die Rechte dieser Gruppe (Überschneidungen sichtbar)
- **Batteriestatus** — ⚡ < 30 %, ◑ < 60 % direkt im Türheader
- **FTP / SFTP Auto-Sync** — lädt CSV-Exporte automatisch, nur geänderte Dateien
- **Authentifizierung** — OAuth2/OIDC via Authentik oder Forward Auth (optional)
- **CSV-Export** — gefilterte Matrix als UTF-8 CSV herunterladen
- **Dark Mode** — automatisch per `prefers-color-scheme`
- **Docker-first** — ein `docker compose up -d` und fertig

---

## Schnellstart

### 1. Konfiguration anlegen

```bash
cp .env.example .env
```

Mindestens diese Felder ausfüllen:

```env
FTP_HOST=192.168.1.100
FTP_USER=salto-export
FTP_PASSWORD=geheim
FTP_REMOTE_PATH=/exports/salto

NGINX_HOST=salto.example.com
NGINX_MODE=https              # oder: http (kein TLS)
```

Alle weiteren Optionen (TLS, Auth, Dateinamen, ...) sind in `.env.example` dokumentiert.

### 2. Container starten

```bash
# HTTP (kein TLS):
docker compose up -d

# HTTPS mit acme.sh (TLS-Zertifikat via DNS-01):
docker compose --profile tls up -d
```

→ **http://localhost:3000** bzw. **https://salto.example.com**

> **Ohne FTP testen?** `FTP_DISABLED=true` in `.env` setzen und CSV-Dateien manuell per `docker cp` in `/data` legen (siehe [Lokale Dateien](#lokale-dateien)).

---

## Konfiguration

### FTP / FTPS

| Variable | Beschreibung | Default |
|---|---|---|
| `FTP_PROTOCOL` | `ftp` oder `sftp` | `ftp` |
| `FTP_HOST` | Hostname oder IP des FTP-Servers | — |
| `FTP_PORT` | Port | `21` |
| `FTP_USER` | Benutzername | `anonymous` |
| `FTP_PASSWORD` | Passwort | — |
| `FTP_REMOTE_PATH` | Verzeichnis auf dem FTP-Server | `/` |
| `FTP_TLS` | `true` für FTPS (explicit TLS) | `false` |

### SFTP

Wie FTP, zusätzlich mit `FTP_PROTOCOL=sftp` und `FTP_PORT=22`:

| Variable | Beschreibung |
|---|---|
| `SFTP_KEY_FILE` | Pfad zum Private Key (statt Passwort) |
| `SFTP_HOST_KEY` | `accept` = Host-Key nicht prüfen (nur Testumgebung) |

### Server

| Variable | Beschreibung | Default |
|---|---|---|
| `PORT` | HTTP-Port | `3000` |
| `DATA_DIR` | Lokaler CSV-Cache | `/data` |
| `CONFIG_FILE` | Pfad zur `ftp.json` | `/config/ftp.json` |
| `ZONES_FILE` | Pfad zur `zones.json` | `/config/zones.json` |
| `SYNC_INTERVAL_SEC` | Sync-Intervall in Sekunden | `86400` (1× täglich) |

---

## CSV-Dateien

Salto-Exporte in den konfigurierten `remotePath` auf dem FTP-Server legen. Der Dateiname wird automatisch erkannt — oder explizit per `fileMapping` in `ftp.json` zugewiesen (empfohlen).

**Unterstützte Spalten:**

| Export | Dateiname enthält (Fallback) | Pflichtfelder |
|---|---|---|
| Personen | `person`, `user`, `benutzer`, `mitarb` | `FirstName`, `LastName`, `ExtID`, `ExtAccessLevelIDList` |
| Türen | `tür`, `door`, `lock` | `Name`, `ExtID` |
| Gruppen / Access Levels | `gruppe`, `group`, `level`, `profil` | `Name`, `ExtID`, `ExtUserIDList`, `ExtDoorIDList` |
| Bereiche | `bereich`, `zone`, `area` | `Name`, `ExtID` |

Das Tool erwartet das Standard-Exportformat von Salto Pro Access Space mit `;`-Trennzeichen und `{{...}}`-ID-Listen.

---

## Bereich-Zuordnung

Da Salto keine direkte Tür→Bereich-Verknüpfung im Export liefert, wird diese einmalig in `config/zones.json` gepflegt:

```jsonc
// config/zones.json
{
  "doorZones": {
    "Office":              "Office",
    "EG Raum A1":          "Office",
    "EG Raum A2":          "Office",
    "Eingang Bürotrakt":   "Office",
    "Serverraum":          "Technikräume",
    "Übersetzer Raum":     "Technikräume",
    "Eingang Foyer":       "Halle",
    "Backstage":           "Halle",
    "Küche":               "Halle"
  }
}
```

Türen ohne Eintrag erscheinen in der Spaltengruppe **„Ohne Bereich"**. Die Datei muss nur bei neuen Türen ergänzt werden.

---

## Authentifizierung

### Modus wählen

```yaml
# docker-compose.yml
AUTH_MODE: "none"        # kein Login (default)
AUTH_MODE: "oidc"        # OAuth2/OIDC via Authentik
AUTH_MODE: "forward-auth" # Authentik Proxy (Header-basiert)
```

---

### OAuth2 / OIDC via Authentik

**Schritt 1 — Provider in Authentik anlegen:**

1. Authentik → Applications → Providers → **Create**
2. Typ: `OAuth2/OpenID Connect`
3. Name: `salto-matrix`
4. **Redirect URI:** `https://salto.example.com/auth/callback`
5. Scopes: `openid`, `profile`, `email` (optional `groups` für Gruppen-Claims)
6. Client ID und Client Secret notieren

**Schritt 2 — Application anlegen** und mit dem Provider verknüpfen

**Schritt 3 — `docker-compose.yml`:**

```yaml
AUTH_MODE:           "oidc"
OIDC_ISSUER:         "https://auth.example.com/application/o/salto-matrix/"
OIDC_CLIENT_ID:      "<Client ID aus Authentik>"
OIDC_CLIENT_SECRET:  "<Client Secret>"
OIDC_REDIRECT_URI:   "https://salto.example.com/auth/callback"
OIDC_SCOPES:         "openid profile email"
SESSION_SECRET:      "<openssl rand -hex 32>"
```

Der Login-Flow ist vollständig serverseitig — nicht eingeloggte Besucher werden automatisch zu Authentik weitergeleitet, nach erfolgreichem Login zurück zur App. Der eingeloggte Username erscheint im Header mit Abmelden-Button.

---

### Forward Auth (Authentik Proxy)

Wenn Authentik als Reverse-Proxy-Middleware vor dem Container läuft und die Authentifizierung über HTTP-Headers weitergibt:

```yaml
AUTH_MODE:       "forward-auth"
AUTH_USER_HDR:   "x-authentik-username"   # default
AUTH_EMAIL_HDR:  "x-authentik-email"      # default
AUTH_NAME_HDR:   "x-authentik-name"       # default
AUTH_GROUPS_HDR: "x-authentik-groups"     # default
```

Der Container prüft ob der Header gesetzt ist — fehlt er, wird der Request mit `401` abgewiesen.

---

## Matrix-Legende

| Zelle | Symbol | Bedeutung | CSV-Export |
|---|---|---|---|
| 🟩 Grün | ✓ Haken | Zutritt via Gruppe / Access Level | `G` |
| 🟦 Blau | ⚡ Blitz | Direktzutritt (Person direkt zugewiesen) | `D` |
| 🟩🟦 Diagonal | ✓ | Direkt + via Gruppe | `B` |
| Leer | — | Kein Zutritt | — |

**Batteriestatus im Tür-Header:**

| Symbol | Bedeutung |
|---|---|
| ⚡ rot | Batterie < 30 % |
| ◑ amber | Batterie < 60 % |
| — | ≥ 60 % oder kein Sensor |

---

## API

| Endpunkt | Methode | Auth erforderlich | Beschreibung |
|---|---|---|---|
| `/` | GET | ja | Web-Interface |
| `/auth/login` | GET | — | OIDC Login-Redirect starten |
| `/auth/callback` | GET | — | OIDC Callback |
| `/auth/logout` | GET | — | Session beenden |
| `/api/me` | GET | ja | Eingeloggter User (oder `null`) |
| `/api/data` | GET | ja | Vollständige Matrix-Daten (JSON) |
| `/api/status` | GET | ja | Sync-Status, Zähler, letzte Aktualisierung |
| `/api/sync` | POST | ja | FTP/SFTP-Sync manuell auslösen |
| `/api/reload` | POST | ja | Lokale CSVs neu einlesen (ohne FTP) |
| `/health` | GET | nein | Docker Healthcheck |

---

## Lokale Dateien

Zum Testen ohne FTP-Server:

```bash
# FTP-Sync deaktivieren
# config/ftp.json: "disabled": true

# Dateien in den Container kopieren
docker cp personen.csv salto-matrix:/data/
docker cp tueren.csv   salto-matrix:/data/
docker cp gruppen.csv  salto-matrix:/data/
docker cp bereich.csv  salto-matrix:/data/

# Neu einlesen
curl -X POST http://localhost:3000/api/reload
```

Alternativ in `docker-compose.yml` einen lokalen Ordner mounten:

```yaml
volumes:
  - ./data:/data   # Dateien direkt in ./data/ ablegen
```

---

## Netzlaufwerk / SMB-Share

Wenn Salto die CSVs direkt auf einen Share exportiert, kann FTP überbrückt werden:

```yaml
# docker-compose.yml
volumes:
  - /mnt/salto-share:/data:ro
```

`FTP_HOST` weglassen oder `"disabled": true` — der Container liest direkt aus `/data`.

---

## Projektstruktur

```
salto-matrix/
├── server.js          # Express-Server, OIDC, Sync-Scheduler
├── sync.js            # FTP & SFTP Protokoll-Handler
├── parser.js          # Salto CSV-Parser (ExtID-Format, {{...}}-Listen)
├── package.json
├── Dockerfile
├── docker-compose.yml
├── config/
│   ├── ftp.json       # FTP/SFTP-Konfiguration
│   └── zones.json     # Tür → Bereich Zuordnung
└── public/
    └── index.html     # Single-Page Frontend
```

---

## Voraussetzungen

- Docker & Docker Compose
- Salto Pro Access Space mit aktiviertem CSV-Export
- FTP- oder SFTP-Server erreichbar vom Container (oder SMB-Share als Bind-Mount)
- Für OIDC: Authentik-Instanz mit konfiguriertem OAuth2-Provider

---

## Lizenz

MIT

---

## HTTPS / nginx mit Let's Encrypt (DNS-01)

Die mitgelieferte `docker-compose.yml` enthält nginx und **acme.sh** als separate Container. acme.sh unterstützt über **150 DNS-Provider** nativ — ohne Plugins, ohne Rebuild.

Zertifikate werden via DNS-01 Challenge ausgestellt — kein Port 80 muss von aussen erreichbar sein, ideal für internen Betrieb.

### Unterstützte DNS-Provider (Auswahl)

| Provider | `ACME_DNS_HOOK` | Wichtigste Variablen |
|---|---|---|
| **Infomaniak** | `dns_infomaniak` | `INFOMANIAK_API_TOKEN` |
| Cloudflare | `dns_cf` | `CF_Token`, `CF_Account_ID` |
| Hetzner DNS | `dns_hetzner` | `HETZNER_Token` |
| Route53 (AWS) | `dns_aws` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| INWX | `dns_inwx` | `INWX_User`, `INWX_Password` |
| DigitalOcean | `dns_digitalocean` | `DO_API_KEY` |
| Gandi LiveDNS | `dns_gandi_livedns` | `GANDI_LIVEDNS_KEY` |
| Namecheap | `dns_namecheap` | `NAMECHEAP_USERNAME`, `NAMECHEAP_API_KEY` |
| Netcup | `dns_netcup` | `NC_Apikey`, `NC_Apipw`, `NC_CID` |
| OVH | `dns_ovh` | `OVH_END`, `OVH_AK`, `OVH_AS`, `OVH_CK` |
| DNSimple | `dns_dnsimple` | `DNSimple_OAUTH_TOKEN` |
| … 140+ weitere | — | [acme.sh DNS API Wiki](https://github.com/acmesh-official/acme.sh/wiki/dnsapi) |

### Ablauf

```
acme.sh ──► DNS Provider API ──► _acme-challenge TXT-Record setzen
         ──► Let's Encrypt prüft DNS (~ACME_DNS_SLEEP Sekunden)
         ──► Zertifikat → acme-certs Volume
nginx    ──► wartet auf Zertifikat ──► startet mit TLS
         ──► graceful reload via SIGHUP bei Erneuerung (alle 12h geprüft)
```

### Setup

**1. `.env` anlegen:**

```bash
cp .env.example .env
```

**2. Provider und Credentials eintragen:**

Infomaniak:
```env
NGINX_HOST=salto.intern.example.com
CERTBOT_EMAIL=admin@example.com
ACME_DNS_HOOK=dns_infomaniak
INFOMANIAK_API_TOKEN=<Token aus manager.infomaniak.com → API → Zone DNS>
```

Hetzner DNS:
```env
ACME_DNS_HOOK=dns_hetzner
HETZNER_Token=<Token aus dns.hetzner.com>
```

Cloudflare:
```env
ACME_DNS_HOOK=dns_cf
CF_Token=<Zone:DNS:Edit Token>
CF_Account_ID=<Account ID>
```

Alle weiteren Provider und Variablen sind in `.env.example` dokumentiert.  
Vollständige Liste: https://github.com/acmesh-official/acme.sh/wiki/dnsapi

**3. DNS-Eintrag setzen:**  
`salto.intern.example.com` → interne IP des Servers.  
Kein öffentlicher Zugriff nötig — nur der DNS-Provider muss den TXT-Record setzen können.

**4. Starten:**

```bash
docker compose up -d
```

acme.sh stellt beim ersten Start das Zertifikat aus. nginx wartet und startet sobald das Zertifikat vorliegt.

### Netzwerk-Topologie

```
Internet / Browser
        │ :443 / :80
   ┌────▼────┐
   │  nginx  │  (external network)
   └────┬────┘
        │ :3000 (internal network — kein Internetzugang)
   ┌────▼──────────┐
   │ salto-matrix  │
   └───────────────┘

   acme.sh ──► Internet (DNS Provider API + Let's Encrypt ACME)
```

### Zertifikat prüfen / erneuern

```bash
# Logs
docker logs salto-acme -f

# nginx Konfiguration testen
docker exec salto-nginx nginx -t

# Zertifikat manuell erneuern
docker exec salto-acme acme.sh --renew -d ${NGINX_HOST} --force

# nginx graceful reload
docker exec salto-nginx nginx -s reload
```

### ACME Server wechseln

```env
ACME_SERVER=letsencrypt       # Standard (default)
ACME_SERVER=zerossl           # ZeroSSL
ACME_SERVER=buypass           # Buypass
ACME_SERVER=letsencrypt_test  # Staging (zum Testen, kein Rate Limit)
```

### HSTS aktivieren

Nach erfolgreich verifiziertem HTTPS in `nginx/conf.d/salto.conf.template`:

```nginx
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
```
