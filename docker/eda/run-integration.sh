#!/usr/bin/env bash
set -euo pipefail
# Never enable shell tracing: the generated material is confidential.
set +x
umask 077

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$root"
project=vital-eda-test
if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
  [[ "${RUNNER_OS:-}" == Linux && "${RUNNER_ENVIRONMENT:-}" == github-hosted && "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]] || { echo 'Disposable hosted runner required' >&2; exit 1; }
  project="vital-eda-test-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
fi
for executable in docker openssl node mktemp; do
  command -v "$executable" >/dev/null || { printf 'Missing CI dependency: %s\n' "$executable" >&2; exit 1; }
done
docker info >/dev/null 2>&1 || { echo 'Docker engine is unavailable; integration tests did NOT run.' >&2; exit 1; }
docker compose version >/dev/null

lock_dir="${TMPDIR:-/tmp}/$project.bootstrap.lock"
mkdir "$lock_dir" 2>/dev/null || { echo 'Another test bootstrap or a stale lock exists; refusing to touch it.' >&2; exit 1; }
secrets_dir=''
started=false
compose=(docker compose --env-file /dev/null -p "$project" -f compose.eda.yml -f docker/eda/compose.tools.yml -f docker/eda/compose.test.yml --profile eda)

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  # Preflight excludes all existing project resources. Only our created project is removed.
  if [ "$started" = true ]; then
    if [ "$status" -ne 0 ]; then
      "${compose[@]}" ps --all || true
      # Health probes contain no credentials. Never dump container environments
      # or generated secret/definition files into a public CI log.
      for container in $("${compose[@]}" ps --all -q); do
        docker inspect --format '{{.Name}} status={{.State.Status}} oom={{.State.OOMKilled}} error={{.State.Error}} {{if .State.Health}}{{range .State.Health.Log}}probe_exit={{.ExitCode}} {{.Output}}{{end}}{{end}}' "$container" || true
      done
    fi
    if ! "${compose[@]}" down --volumes --timeout 15; then
      echo 'Cleanup failed for newly created vital-eda-test resources; inspect before retrying.' >&2
      status=1
    fi
  fi
  if [ -n "$secrets_dir" ] && [ -d "$secrets_dir" ]; then
    case "$secrets_dir" in
      "${TMPDIR:-/tmp}"/vital-eda-test.*)
        find "$secrets_dir" -maxdepth 1 -type f -delete
        rmdir "$secrets_dir"
        ;;
      *) echo 'Refusing unexpected temporary secret path.' >&2; status=1 ;;
    esac
  fi
  rmdir "$lock_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for kind in container network volume; do
  case "$kind" in
    container) existing="$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ;;
    network) existing="$(docker network ls -q --filter "label=com.docker.compose.project=$project")" ;;
    volume) existing="$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" ;;
  esac
  if [ -n "$existing" ]; then
    echo "Existing $project $kind resources found; refusing startup and deletion." >&2
    exit 1
  fi
done
# Also reject collisions with unlabelled resources bearing our exact Compose names.
for name in "${project}_postgres_data" "${project}_rabbitmq_data" "${project}_minio_data"; do
  if docker volume inspect "$name" >/dev/null 2>&1; then
    echo 'Existing test-named volume found; refusing to reuse or delete it.' >&2
    exit 1
  fi
done
for name in "${project}_private" "${project}_ingress"; do
  if docker network inspect "$name" >/dev/null 2>&1; then
    echo 'Existing test-named network found; refusing to reuse or delete it.' >&2
    exit 1
  fi
done
if [ -n "$(docker ps -aq --filter "name=^/${project}[-_]")" ]; then
  echo 'Existing test-named container found; refusing startup and deletion.' >&2
  exit 1
fi

secrets_dir="$(mktemp -d "${TMPDIR:-/tmp}/vital-eda-test.XXXXXX")"
export EDA_SECRETS_DIR="$secrets_dir"
export EDA_TOOLS_IMAGE=vital-eda-test-tools:local
export EDA_DATABASE_SUFFIX=_test
export EDA_TEST_ENABLED=true
export EDA_TEST_ISOLATED=yes
export VITAL_EDA_ENABLED=false
export VITAL_EDA_PROFILE_WRITES_ENABLED=false
export VITAL_EDA_CONSUMERS_ENABLED=false
export VITAL_EDA_DELIVERY_ENABLED=false
export VITAL_EDA_PROVISION_BROKER=false

for name in postgres-admin core-api integrations-api core-worker integrations-worker core-migrator integrations-migrator rabbit-runtime rabbit-provision; do
  openssl rand -hex 32 > "$secrets_dir/$name-password"
done

for service in db broker minio; do
  if [ "$service" = db ]; then host=postgres; elif [ "$service" = broker ]; then host=rabbitmq; else host=minio; fi
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -sha256 \
    -keyout "$secrets_dir/$service-ca-key.pem" -out "$secrets_dir/$service-ca.pem" \
    -subj "/CN=vital-eda-test-$service-ca" \
    -addext 'basicConstraints=critical,CA:TRUE' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign' >/dev/null 2>&1
  openssl req -new -newkey rsa:2048 -nodes -sha256 \
    -keyout "$secrets_dir/$service-key.pem" -out "$secrets_dir/$service.csr" \
    -subj "/CN=$host" >/dev/null 2>&1
  printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\nbasicConstraints=critical,CA:FALSE\n' "$host" > "$secrets_dir/$service.ext"
  openssl x509 -req -days 2 -sha256 -in "$secrets_dir/$service.csr" \
    -CA "$secrets_dir/$service-ca.pem" -CAkey "$secrets_dir/$service-ca-key.pem" -CAcreateserial \
    -extfile "$secrets_dir/$service.ext" -out "$secrets_dir/$service-cert.pem" >/dev/null 2>&1
done

# Synthetic process certificates are used only by the opt-in mTLS test server.
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -sha256 \
  -keyout "$secrets_dir/test-service-ca-key.pem" -out "$secrets_dir/test-service-ca.pem" \
  -subj '/CN=vital-eda-test-process-ca' -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' >/dev/null 2>&1
for service in api web; do
  if [ "$service" = api ]; then common_name=vital-api.test; usage=serverAuth; else common_name=vital-web; usage=clientAuth; fi
  openssl req -new -newkey rsa:2048 -nodes -sha256 -keyout "$secrets_dir/test-$service-key.pem" \
    -out "$secrets_dir/test-$service.csr" -subj "/CN=$common_name" >/dev/null 2>&1
  printf 'subjectAltName=DNS:%s\nextendedKeyUsage=%s\nkeyUsage=critical,digitalSignature,keyEncipherment\nbasicConstraints=critical,CA:FALSE\n' \
    "$common_name" "$usage" > "$secrets_dir/test-$service.ext"
  openssl x509 -req -days 2 -sha256 -in "$secrets_dir/test-$service.csr" -CA "$secrets_dir/test-service-ca.pem" \
    -CAkey "$secrets_dir/test-service-ca-key.pem" -CAcreateserial -extfile "$secrets_dir/test-$service.ext" \
    -out "$secrets_dir/test-$service-cert.pem" >/dev/null 2>&1
done

# RabbitMQ's salted SHA-256 format is base64(salt[4] + SHA256(salt + password)).
# Node reads local files and writes the definitions directly; no password enters argv/logs.
node --input-type=module -e '
  import {readFileSync, writeFileSync} from "node:fs";
  import {randomBytes, createHash} from "node:crypto";
  const dir = process.env.EDA_SECRETS_DIR;
  const definitions = JSON.parse(readFileSync("docker/eda/rabbitmq/definitions.test.example.json", "utf8"));
  for (const user of definitions.users) {
    const identity = user.name === "vital_runtime" ? "runtime" : "provision";
    const salt = randomBytes(4);
    const password = readFileSync(`${dir}/rabbit-${identity}-password`, "utf8").trim();
    const digest = createHash("sha256").update(salt).update(password).digest();
    user.password_hash = Buffer.concat([salt, digest]).toString("base64");
  }
  writeFileSync(`${dir}/broker-definitions.json`, JSON.stringify(definitions), {mode: 0o600});
'
# Single-file bind mounts must be readable by service UIDs. The parent temp
# directory remains 0700; private CA signing keys are never mounted.
chmod 0644 "$secrets_dir"/*-password "$secrets_dir"/*-cert.pem "$secrets_dir"/db-key.pem \
  "$secrets_dir"/broker-key.pem "$secrets_dir"/minio-key.pem "$secrets_dir"/minio-ca.pem "$secrets_dir"/db-ca.pem "$secrets_dir"/broker-ca.pem \
  "$secrets_dir"/broker-definitions.json
chmod 0644 "$secrets_dir"/test-service-ca.pem "$secrets_dir"/test-api-cert.pem "$secrets_dir"/test-api-key.pem \
  "$secrets_dir"/test-web-cert.pem "$secrets_dir"/test-web-key.pem

"${compose[@]}" config --quiet
echo 'Isolated CI environment: EDA_TEST_ENABLED, EDA_TEST_ISOLATED, EDA_DATABASE_SUFFIX configured.'
"${compose[@]}" build api
# Mark before startup so partial creation is cleaned, but never before preflight/build.
started=true
"${compose[@]}" up -d --wait --wait-timeout 120 postgres rabbitmq
"${compose[@]}" run --rm --no-deps api migrate
"${compose[@]}" exec -T postgres sh /etc/eda/postgres/grants.sh
"${compose[@]}" run --rm --no-deps api test
echo 'Real isolated PostgreSQL/RabbitMQ integration tests completed successfully.'
