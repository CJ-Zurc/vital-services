#!/bin/sh
set -eu
case "${EDA_DATABASE_SUFFIX:-}" in ''|_test) ;; *) echo 'Unsafe database suffix' >&2; exit 1 ;; esac
for domain in core integrations; do
  psql -v ON_ERROR_STOP=1 -U eda_bootstrap -d "vital_${domain}${EDA_DATABASE_SUFFIX:-}" \
    -v api_role="vital_${domain}_api" -v worker_role="vital_${domain}_worker" \
    -f /etc/eda/postgres/grants.sql
done
