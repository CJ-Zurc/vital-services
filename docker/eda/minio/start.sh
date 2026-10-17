#!/bin/sh
set -eu
umask 077
for file in minio-cert.pem minio-key.pem minio-ca.pem; do
  test -s "/run/secrets/$file" || { echo 'MinIO TLS material missing' >&2; exit 1; }
done
# Native MinIO names live in an owner-only tmpfs, never in the data volume.
mkdir -p /run/minio-tls/CAs
cp /run/secrets/minio-cert.pem /run/minio-tls/public.crt
cp /run/secrets/minio-key.pem /run/minio-tls/private.key
cp /run/secrets/minio-ca.pem /run/minio-tls/CAs/storage.crt
export MINIO_ROOT_USER="$(cat /run/secrets/minio_admin_user)"
export MINIO_ROOT_PASSWORD="$(cat /run/secrets/minio_admin_password)"
test -n "$MINIO_ROOT_USER" && test -n "$MINIO_ROOT_PASSWORD"
exec minio server /data --certs-dir /run/minio-tls --address :9000 --console-address 127.0.0.1:9001
