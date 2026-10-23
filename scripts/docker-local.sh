#!/usr/bin/env bash
# Build the production image and run it on this machine against the docker-compose services, the way Cloud
# Run will run it: same image, same environment file, the deploy job first, then the service.
#
#   scripts/docker-local.sh up        build, migrate + build the featured runs, start on http://127.0.0.1:8080
#   scripts/docker-local.sh down      stop and remove the container
#   scripts/docker-local.sh logs      follow its logs
#
# Environment (all optional):
#   IMAGE     image name              (ziro:local)
#   PORT      host port               (8080)
#   DB_NAME   database to use         (ziro). Anything else is created in the compose Postgres if missing.
#   LEAST_PRIVILEGE  1 (default) = the service connects as a role that cannot change the audit trail, which
#             the deploy job grants, exactly as in production. 0 = connect as the compose owner for both.
#   WITH_KEY  1 = pass ANTHROPIC_API_KEY from your shell through. Off by default, so the replay is shown to
#             work with no key.
#
# Needs Docker and `docker compose`. Touches nothing but local containers. It never calls git.
set -euo pipefail

cd "$(dirname "$0")/.."
# Git Bash on Windows would rewrite /tmp/... in arguments into a Windows path.
export MSYS_NO_PATHCONV=1

IMAGE="${IMAGE:-ziro:local}"
PORT="${PORT:-8080}"
DB_NAME="${DB_NAME:-ziro}"
LEAST_PRIVILEGE="${LEAST_PRIVILEGE:-1}"
NAME="ziro-local"
ENV_FILE="deploy/demo.env"

if [[ ! "$DB_NAME" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  echo "DB_NAME must be lowercase letters, digits and underscores" >&2
  exit 2
fi

compose_network() {
  docker inspect ziro-postgres-1 --format '{{range $k, $_ := .NetworkSettings.Networks}}{{$k}}{{end}}'
}

up() {
  docker build -t "$IMAGE" .

  docker compose up -d --wait postgres redis
  if [[ "$DB_NAME" != "ziro" ]]; then
    docker compose exec -T postgres psql -U ziro -d ziro -tAc \
      "select 1 from pg_database where datname = '${DB_NAME}'" | grep -q 1 \
      || docker compose exec -T postgres psql -U ziro -d ziro -c "create database ${DB_NAME}"
  fi

  local network
  network="$(compose_network)"
  local common=(--network "$network" --env-file "$ENV_FILE" -e "REDIS_URL=redis://redis:6379")
  if [[ "${WITH_KEY:-0}" == "1" ]]; then common+=(-e ANTHROPIC_API_KEY); fi

  # The deploy job runs as the owner. The service runs as the application role, when there is one.
  local job_db="postgres://ziro:ziro_dev@postgres:5432/${DB_NAME}"
  local job_extra=()
  local service_db="$job_db"
  if [[ "$LEAST_PRIVILEGE" == "1" ]]; then
    docker compose exec -T postgres psql -U ziro -d ziro -tAc "select 1 from pg_roles where rolname = 'ziro_app'" | grep -q 1 \
      || docker compose exec -T postgres psql -U ziro -d ziro -c "create role ziro_app login password 'ziro_app_dev'"
    job_extra=(-e APP_DB_ROLE=ziro_app)
    service_db="postgres://ziro_app:ziro_app_dev@postgres:5432/${DB_NAME}"
  fi

  echo "--- deploy job: migrate, grant the application role, build the featured runs"
  docker run --rm "${common[@]}" -e "DATABASE_URL=${job_db}" "${job_extra[@]}" "$IMAGE" \
    node apps/api/dist/scripts/prepare.js

  docker rm -f "$NAME" >/dev/null 2>&1 || true
  echo "--- service"
  docker run -d --name "$NAME" --init -p "127.0.0.1:${PORT}:8080" "${common[@]}" \
    -e "DATABASE_URL=${service_db}" "$IMAGE" >/dev/null

  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
      echo "up: http://127.0.0.1:${PORT}   (logs: scripts/docker-local.sh logs)"
      return 0
    fi
    sleep 1
  done
  echo "the service did not become healthy in 60 s; its log:" >&2
  docker logs --tail 40 "$NAME" >&2
  exit 1
}

case "${1:-up}" in
  up) up ;;
  down) docker rm -f "$NAME" ;;
  logs) docker logs -f "$NAME" ;;
  *)
    echo "usage: $0 [up|down|logs]" >&2
    exit 2
    ;;
esac
