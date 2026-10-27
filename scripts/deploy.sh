#!/usr/bin/env bash
# Build the image, run the deploy job (migrations, then the featured runs), deploy the Cloud Run service,
# and smoke-test it. Nothing here runs until YOU run it. It never calls git: the image is tagged with the
# version you pass, or with the UTC time.
#
#   scripts/deploy.sh --project my-project
#   scripts/deploy.sh --project my-project --version 2026-10-24-a --min-instances 1
#   scripts/deploy.sh --project my-project --dry-run        print every command, run none
#
# Options
#   --project ID        your Google Cloud project (or set GCP_PROJECT)
#   --region R          default asia-south1 (Mumbai)
#   --service NAME      default ziro
#   --version TAG       image tag; default the UTC time, e.g. 20261024-101500
#   --min-instances N   default 0: scale to zero, first visitor waits for a cold start, nothing is billed idle.
#                       1 keeps one instance warm (billed around the clock): use it while people are looking.
#   --app-role NAME     the database role the SERVICE connects as; the job (the owner) grants it exactly what
#                       it needs on every deploy. Default ziro_app. Create it in Neon first (docs/DEPLOY.md).
#   --no-app-role       skip that: the service then connects as whatever role its URL names
#   --with-key          give the service the Gemini key (secret ziro-gemini-api-key), which switches
#                       on the live model option. Without it the demo, the replay and Reset all still work.
#   --with-claude       also give it the Anthropic key (secret ziro-anthropic-api-key) as a fallback model.
#                       Needs an account with credit AND a price in LLM_PRICES, or Claude is left out.
#   --skip-build        deploy an image already pushed under --version
#   --skip-prepare      do not run the migration job (only if you are sure nothing changed in the database)
#   --no-smoke          do not run scripts/smoke.mjs against the new revision
#   --dry-run           print the commands instead of running them
#
# Order matters: the new image's migrations run BEFORE the new revision takes traffic, and the service is
# only deployed if they succeed. Migrations must stay backward compatible with the revision still serving.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=lib/common.sh
source scripts/lib/common.sh

PROJECT="${GCP_PROJECT:-}"
REGION="asia-south1"
SERVICE="ziro"
VERSION=""
MIN_INSTANCES=0
WITH_KEY=0
WITH_CLAUDE=0
APP_ROLE="ziro_app"
SKIP_BUILD=0
SKIP_PREPARE=0
SMOKE=1
ENV_FILE="deploy/demo.env"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="${2:?--project needs a value}"; shift 2 ;;
    --region) REGION="${2:?--region needs a value}"; shift 2 ;;
    --service) SERVICE="${2:?--service needs a value}"; shift 2 ;;
    --version) VERSION="${2:?--version needs a value}"; shift 2 ;;
    --min-instances) MIN_INSTANCES="${2:?--min-instances needs a value}"; shift 2 ;;
    --app-role) APP_ROLE="${2:?--app-role needs a value}"; shift 2 ;;
    --no-app-role) APP_ROLE=""; shift ;;
    --with-key) WITH_KEY=1; shift ;;
    --with-claude) WITH_CLAUDE=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --skip-prepare) SKIP_PREPARE=1; shift ;;
    --no-smoke) SMOKE=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) sed -n '2,33p' "$0"; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done
export DRY_RUN

[[ -n "$PROJECT" ]] || die "--project is required"
[[ "$PROJECT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die "that does not look like a project id: $PROJECT"
[[ "$MIN_INSTANCES" =~ ^[0-9]+$ ]] || die "--min-instances must be a whole number"
[[ -n "$VERSION" ]] || VERSION="$(date -u +%Y%m%d-%H%M%S)"
[[ "$VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$ ]] || die "--version may use letters, digits, . _ - only (it becomes a Docker tag)"
[[ -f "$ENV_FILE" ]] || die "$ENV_FILE is missing"
[[ -z "$APP_ROLE" || "$APP_ROLE" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "--app-role must be a plain lowercase identifier"

# Test mode only (CLAUDE.md section 4.6). The app refuses a live key at boot; this refuses to ship one at all.
if grep -v '^[[:space:]]*#' "$ENV_FILE" | grep -qi 'rzp_live_'; then
  die "$ENV_FILE sets a live Razorpay key; Ziro is test mode only"
fi

if [[ "$DRY_RUN" != "1" ]]; then
  need docker
  need gcloud
  need curl
  need node
  [[ -n "$(gcloud config get-value account 2>/dev/null)" ]] || die "gcloud is not logged in: run  gcloud auth login"
fi

IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/ziro/ziro:${VERSION}"
RUNTIME_SA="ziro-runtime@${PROJECT}.iam.gserviceaccount.com"
MIGRATE_SA="ziro-migrate@${PROJECT}.iam.gserviceaccount.com"
JOB="${SERVICE}-prepare"

echo "project  $PROJECT"
echo "region   $REGION"
echo "service  $SERVICE   (min instances $MIN_INSTANCES, max 1)"
echo "image    $IMAGE"
echo "app role $([[ -n $APP_ROLE ]] && echo "$APP_ROLE (granted by the job)" || echo 'none: the URL decides')"
echo "key      $([[ $WITH_KEY == 1 ]] && echo 'live model ENABLED (--with-key)' || echo 'none: replay and scripted runs only')"
[[ "$DRY_RUN" == "1" ]] && echo "mode     DRY RUN: nothing below is executed"

# The non-secret settings as a YAML file for --env-vars-file (no quoting problems, nothing on a command line).
ENV_YAML="$(mktemp)"
trap 'rm -f "$ENV_YAML"' EXIT
{
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || die "$ENV_FILE: not KEY=VALUE: $line"
    printf '%s: "%s"\n' "${line%%=*}" "${line#*=}"
  done <"$ENV_FILE"
  printf 'GCP_PROJECT_ID: "%s"\n' "$PROJECT"
} >"$ENV_YAML"
# The job alone also knows which role to grant; the service has no use for it.
JOB_YAML="$(mktemp)"
trap 'rm -f "$ENV_YAML" "$JOB_YAML"' EXIT
cp "$ENV_YAML" "$JOB_YAML"
[[ -z "$APP_ROLE" ]] || printf 'APP_DB_ROLE: "%s"\n' "$APP_ROLE" >>"$JOB_YAML"

if [[ "$SKIP_BUILD" != "1" ]]; then
  say "1. Build and push the image"
  run gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
  run docker build --tag "$IMAGE" .
  run docker push "$IMAGE"
fi

DB_DIRECT="ziro-database-url-direct:$(secret_version ziro-database-url-direct)"
DB_POOLED="ziro-database-url:$(secret_version ziro-database-url)"
REDIS="ziro-redis-url:$(secret_version ziro-redis-url)"

if [[ "$SKIP_PREPARE" != "1" ]]; then
  say "2. Migrate and build the featured runs (Cloud Run job $JOB)"
  job_flags=(
    --image "$IMAGE" --region "$REGION" --project "$PROJECT"
    --service-account "$MIGRATE_SA"
    --set-secrets "DATABASE_URL=${DB_DIRECT},REDIS_URL=${REDIS}"
    --env-vars-file "$(native_path "$JOB_YAML")"
    --command node --args apps/api/dist/scripts/prepare.js
    --cpu 1 --memory 1Gi --task-timeout 900s --max-retries 0
  )
  if [[ "$DRY_RUN" == "1" ]] || ! gcloud run jobs describe "$JOB" --region "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
    run gcloud run jobs create "$JOB" "${job_flags[@]}"
  else
    run gcloud run jobs update "$JOB" "${job_flags[@]}"
  fi
  run gcloud run jobs execute "$JOB" --region "$REGION" --project "$PROJECT" --wait
fi

say "3. Deploy the service"
secrets="DATABASE_URL=${DB_POOLED},REDIS_URL=${REDIS}"
if [[ "$WITH_KEY" == "1" ]]; then
  secrets="${secrets},GEMINI_API_KEY=ziro-gemini-api-key:$(secret_version ziro-gemini-api-key)"
fi
if [[ "$WITH_CLAUDE" == "1" ]]; then
  secrets="${secrets},ANTHROPIC_API_KEY=ziro-anthropic-api-key:$(secret_version ziro-anthropic-api-key)"
fi
# --no-cpu-throttling: the demo's pipeline runs in the background after the request that started it returns,
# and Cloud Run only gives CPU to an instance while it is handling a request unless told otherwise.
# --max-instances 1: the rate limits, the circuit breaker and the featured-run check live in this process.
run gcloud run deploy "$SERVICE" \
  --image "$IMAGE" --region "$REGION" --project "$PROJECT" \
  --service-account "$RUNTIME_SA" \
  --allow-unauthenticated --port 8080 \
  --cpu 1 --memory 512Mi --no-cpu-throttling --cpu-boost \
  --min-instances "$MIN_INSTANCES" --max-instances 1 --concurrency 80 --timeout 300 \
  --env-vars-file "$(native_path "$ENV_YAML")" \
  --set-secrets "$secrets" \
  --startup-probe "httpGet.path=/health,httpGet.port=8080,initialDelaySeconds=0,timeoutSeconds=5,periodSeconds=10,failureThreshold=24" \
  --liveness-probe "httpGet.path=/health/live,httpGet.port=8080,periodSeconds=30,timeoutSeconds=3,failureThreshold=3"

if [[ "$DRY_RUN" == "1" ]]; then
  URL="https://${SERVICE}-PROJECT_NUMBER.${REGION}.run.app"
else
  URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" --format='value(status.url)')"
fi
say "Deployed: $URL"

if [[ "$SMOKE" == "1" ]]; then
  say "4. Smoke test: the stranger's path"
  smoke_flags=()
  [[ "$WITH_KEY" == "1" ]] || smoke_flags+=(--no-key)
  run node scripts/smoke.mjs "$URL" "${smoke_flags[@]}"
fi

echo
echo "Open $URL in a private window. To roll back:"
echo "  gcloud run services update-traffic $SERVICE --region $REGION --project $PROJECT --to-revisions=REVISION=100"
