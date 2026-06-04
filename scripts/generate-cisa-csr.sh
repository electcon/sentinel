#!/usr/bin/env bash
# generate-cisa-csr.sh — generate a CSR + private key for CISA AIS TAXII
# enrollment. Output: cisa-ais.key (private key) and cisa-ais.csr (CSR).
# Submit cisa-ais.csr to your chosen federally-cross-certified CA
# (IdenTrust / DigiCert Federated Trust / Entrust). Once the cert
# is issued, save it as `cisa-ais.crt` (or `.txt` per CISA's note)
# alongside the .key file. Both go to Sentinel as env vars at deploy
# time — see sentinel/lib/cisa.js for env-var contract.
#
# Requirements (per CISA AIS Onboarding email):
#   - Medium assurance (encoded by the CA, not the CSR)
#   - Client authentication EKU
#   - Cross-certified to FCPCA or FBCA
#
# This script generates a CSR with the right key parameters + EKU
# request; the assurance level + cross-cert chain are determined by the
# CA when they issue.

set -euo pipefail

# ── Config — edit these to match your enrollment ─────────────────────────
ORGANIZATION="Parallax Advisory LLC"
ORGANIZATIONAL_UNIT="Sentinel"
COMMON_NAME="sentinel-ais.parallaxadvisory.llc"
EMAIL="david@parallaxadvisory.llc"
COUNTRY="US"
STATE="North Carolina"
LOCALITY="Spruce Pine"

# Output filenames
KEY_FILE="cisa-ais.key"
CSR_FILE="cisa-ais.csr"
CONFIG_FILE="cisa-ais-csr.cnf"

# Key strength (CISA accepts RSA-2048 minimum; RSA-3072 or RSA-4096 are
# preferred for medium-assurance issuance windows of >1 year).
RSA_BITS=3072
# ──────────────────────────────────────────────────────────────────────────

cat > "$CONFIG_FILE" <<EOF
[ req ]
default_bits        = $RSA_BITS
default_md          = sha256
prompt              = no
distinguished_name  = dn
req_extensions      = req_ext

[ dn ]
C  = $COUNTRY
ST = $STATE
L  = $LOCALITY
O  = $ORGANIZATION
OU = $ORGANIZATIONAL_UNIT
CN = $COMMON_NAME
emailAddress = $EMAIL

[ req_ext ]
# Extended Key Usage — CISA AIS requires Client Authentication.
extendedKeyUsage = clientAuth
# Key Usage — minimum set for an mTLS client cert.
keyUsage         = critical, digitalSignature, keyEncipherment
# Subject Alternative Name — include the CN as a DNS name + email so
# the CA's vetting and the AIS server's cert-matching logic both have
# something to anchor against.
subjectAltName   = @san

[ san ]
DNS.1   = $COMMON_NAME
email.1 = $EMAIL
EOF

echo "[generate-cisa-csr] Generating $RSA_BITS-bit RSA key → $KEY_FILE"
openssl genrsa -out "$KEY_FILE" "$RSA_BITS"

echo "[generate-cisa-csr] Generating CSR → $CSR_FILE"
openssl req -new -key "$KEY_FILE" -out "$CSR_FILE" -config "$CONFIG_FILE"

echo "[generate-cisa-csr] Verifying CSR contents:"
openssl req -in "$CSR_FILE" -noout -text | head -25

cat <<EOF

────────────────────────────────────────────────────────────────────────
DONE.

Files generated:
  $KEY_FILE  — private key. KEEP SECRET. Never commit. Never email.
  $CSR_FILE  — Certificate Signing Request. Submit this to your CA.
  $CONFIG_FILE — OpenSSL config (regeneratable; safe to delete).

Next steps:
  1. Submit $CSR_FILE to a federally-cross-certified CA. Recommended:
       IdenTrust IGC Public S2 — \$199/yr, fastest federal-bridge track
       https://www.identrust.com/identity-services/digital-certificates/igc-public
     Alternatives:
       DigiCert Federated Trust line (https://www.digicert.com/federated-trust)
       Entrust Federal credentials (https://www.entrust.com)
  2. Complete identity proofing (typically 1–2 business days for IGC).
  3. CA emails the issued cert. Save as cisa-ais.crt or cisa-ais.txt.
  4. Set Sentinel env vars on Render:
       CISA_TAXII_CLIENT_CERT_PEM=<contents of cisa-ais.crt>
       CISA_TAXII_CLIENT_KEY_PEM=<contents of cisa-ais.key>
     OR (preferred for >4KB cert chains):
       CISA_TAXII_CLIENT_CERT_PATH=/etc/secrets/cisa-ais.crt
       CISA_TAXII_CLIENT_KEY_PATH=/etc/secrets/cisa-ais.key
  5. Reply to taxiiadmins@cisa.dhs.gov with the cert + ISA + IPs.
  6. CISA provisions account, sends collection ID + base URL.
  7. Set CISA_TAXII_BASE_URL + CISA_TAXII_COLLECTION_ID env vars.
  8. Hit POST /api/_smoke/cisa-run to verify the connection.
────────────────────────────────────────────────────────────────────────
EOF
