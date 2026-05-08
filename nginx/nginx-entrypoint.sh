#!/bin/sh
set -e

DOMAIN="${NGINX_HOST}"
MODE="${NGINX_MODE:-https}"   # https (default) | http
CONF_TEMPLATE_HTTPS="/etc/nginx/conf.d/salto.conf.template"
CONF_TEMPLATE_HTTP="/etc/nginx/conf.d/salto-http.conf.template"
CONF_OUT="/etc/nginx/conf.d/salto.conf"

echo "[nginx] Domain : ${DOMAIN}"
echo "[nginx] Mode   : ${MODE}"

if [ "${MODE}" = "http" ]; then
    echo "[nginx] HTTP-Modus — kein TLS, kein Warten auf Zertifikat."
    sed "s/\${NGINX_HOST}/${DOMAIN}/g" "${CONF_TEMPLATE_HTTP}" > "${CONF_OUT}"
else
    CERT_PATH="/etc/nginx/certs/${DOMAIN}/fullchain.pem"
    echo "[nginx] Warte auf TLS-Zertifikat: ${CERT_PATH}"

    TRIES=0
    until [ -f "${CERT_PATH}" ] || [ ${TRIES} -ge 60 ]; do
        sleep 5
        TRIES=$((TRIES + 1))
    done

    if [ ! -f "${CERT_PATH}" ]; then
        echo "[nginx] FEHLER: Zertifikat nicht gefunden nach 5 Minuten."
        echo "[nginx] Tipp: NGINX_MODE=http setzen um ohne TLS zu starten."
        exit 1
    fi

    echo "[nginx] Zertifikat gefunden — generiere HTTPS-Konfiguration..."
    sed "s/\${NGINX_HOST}/${DOMAIN}/g" "${CONF_TEMPLATE_HTTPS}" > "${CONF_OUT}"
fi

echo "[nginx] Starte nginx..."
exec nginx -g "daemon off;"
