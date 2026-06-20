#!/bin/bash
set -e
cd "$(dirname "$0")"

openssl req -x509 -newkey rsa:4096 -keyout server.key -out server.crt \
    -days 365 -nodes -subj "/CN=audio-bridge"

echo ""
echo "Certificate fingerprint (add to config.json as server_cert_sha256):"
openssl x509 -noout -fingerprint -sha256 -in server.crt | \
    sed 's/SHA256 Fingerprint=//' | tr -d ':' | tr '[:upper:]' '[:lower:]'
echo ""
echo "Add to .env:"
echo "  SSL_CERT_FILE=$(pwd)/server.crt"
echo "  SSL_KEY_FILE=$(pwd)/server.key"
