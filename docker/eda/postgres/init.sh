#!/bin/sh
set -eu
case "${EDA_DATABASE_SUFFIX:-}" in ''|_test) ;; *) echo 'Unsafe database suffix' >&2; exit 1 ;; esac
export CORE_API_PASSWORD="$(cat /run/secrets/core_api_password)"
export CORE_WORKER_PASSWORD="$(cat /run/secrets/core_worker_password)"
export CORE_MIGRATOR_PASSWORD="$(cat /run/secrets/core_migrator_password)"
export INTEGRATIONS_API_PASSWORD="$(cat /run/secrets/integrations_api_password)"
export INTEGRATIONS_WORKER_PASSWORD="$(cat /run/secrets/integrations_worker_password)"
export INTEGRATIONS_MIGRATOR_PASSWORD="$(cat /run/secrets/integrations_migrator_password)"
psql -v ON_ERROR_STOP=1 -U eda_bootstrap -d postgres \
  -v core_db="vital_core${EDA_DATABASE_SUFFIX:-}" \
  -v integrations_db="vital_integrations${EDA_DATABASE_SUFFIX:-}" \
  -f /etc/eda/postgres/init.sql
