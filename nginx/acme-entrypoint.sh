#!/bin/sh
set -e

DOMAIN="${NGINX_HOST}"
EMAIL="${CERTBOT_EMAIL}"
DNS_HOOK="${ACME_DNS_HOOK:-dns_cf}"       # acme.sh dns hook name, e.g. dns_cf, dns_infomaniak, dns_hetzner, dns_aws
PROPAGATION="${ACME_DNS_SLEEP:-30}"       # seconds to wait for DNS propagation
ACME_SERVER="${ACME_SERVER:-letsencrypt}" # letsencrypt | zerossl | buypass | letsencrypt_test

CERT_DIR="/etc/acme/${DOMAIN}"
NGINX_PID_FILE="/var/run/nginx/nginx.pid"

echo "[acme.sh] Domain      : ${DOMAIN}"
echo "[acme.sh] DNS Hook    : ${DNS_HOOK}"
echo "[acme.sh] ACME Server : ${ACME_SERVER}"
echo "[acme.sh] Propagation : ${PROPAGATION}s"

# ── Register account ──────────────────────────────────────────────────────────
acme.sh --register-account \
    --server "${ACME_SERVER}" \
    --email "${EMAIL}" \
    --accountkeylength ec-256 \
    2>&1 | grep -v "^$" || true

# ── Issue certificate if not yet present ─────────────────────────────────────
if [ ! -f "${CERT_DIR}/fullchain.cer" ]; then
    echo "[acme.sh] Erstes Zertifikat anfordern..."
    acme.sh --issue \
        --server "${ACME_SERVER}" \
        --dns "${DNS_HOOK}" \
        --dnssleep "${PROPAGATION}" \
        -d "${DOMAIN}" \
        --key-file      "${CERT_DIR}/privkey.pem" \
        --cert-file     "${CERT_DIR}/cert.pem" \
        --ca-file       "${CERT_DIR}/chain.pem" \
        --fullchain-file "${CERT_DIR}/fullchain.pem" \
        --reloadcmd "echo '[acme.sh] Zertifikat erneuert.'"
    echo "[acme.sh] Zertifikat ausgestellt: ${CERT_DIR}"
else
    echo "[acme.sh] Zertifikat bereits vorhanden, überspringe Erstausstellung."
fi

# ── Renewal loop: check every 12h ────────────────────────────────────────────
# acme.sh renews automatically at <30 days remaining
echo "[acme.sh] Starte Renewal-Loop (alle 12h)..."
while true; do
    sleep 43200
    echo "[acme.sh] Prüfe Erneuerung für ${DOMAIN}..."
    acme.sh --renew \
        --server "${ACME_SERVER}" \
        --dns "${DNS_HOOK}" \
        --dnssleep "${PROPAGATION}" \
        -d "${DOMAIN}" \
        --key-file       "${CERT_DIR}/privkey.pem" \
        --cert-file      "${CERT_DIR}/cert.pem" \
        --ca-file        "${CERT_DIR}/chain.pem" \
        --fullchain-file "${CERT_DIR}/fullchain.pem" \
        --reloadcmd "kill -HUP \$(cat ${NGINX_PID_FILE} 2>/dev/null) 2>/dev/null && echo '[acme.sh] nginx reloaded' || true" \
        2>&1 | grep -v "^$" || true
done
ENDOFFILE