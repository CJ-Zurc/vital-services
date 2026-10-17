#!/bin/sh
set -eu
umask 077
cp /run/secrets/db-cert.pem /run/eda/server.crt
cp /run/secrets/db-key.pem /run/eda/server.key
chmod 600 /run/eda/server.key
exec /usr/local/bin/docker-entrypoint.sh "$@"
