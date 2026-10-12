#!/bin/sh
set -eu
export MINIO_ROOT_USER="$(cat /run/secrets/minio_admin_user)"
export MINIO_ROOT_PASSWORD="$(cat /run/secrets/minio_admin_password)"
test -n "$MINIO_ROOT_USER" && test -n "$MINIO_ROOT_PASSWORD"
exec minio server /data --address :9000 --console-address 127.0.0.1:9001
