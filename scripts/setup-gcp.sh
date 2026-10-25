#!/usr/bin/env bash
# One-time setup of the Google Cloud side of Ziro, in your project. Idempotent: run it again to add a missing
# piece or to rotate a secret. Nothing here runs until YOU run it.
#
#   scripts/setup-gcp.sh --project my-project [--region asia-south1] [--dry-run] [--no-secrets]
#
# What it does, in order:
#   1. enables the Cloud Run, Artifact Registry and Secret Manager APIs
#   2. creates the Docker repository "ziro" in the region
#   3. creates two service accounts, so the service cannot read what only the deploy job needs:
#        ziro-runtime  runs the service: the app (pooled) database URL, Redis, and optionally the model key
#        ziro-migrate  runs the deploy job: the OWNER (direct) database URL and Redis
#   4. creates the secrets, asks you for each value (typed silently, never on a command line, never in a
#      file), checks its shape, adds it as a new version, and lets only the right account read it
#
# Your database and Redis URLs come from Neon and Upstash: docs/DEPLOY.md, parts 1 and 2.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=lib/common.sh
source scripts/lib/common.sh

PROJECT="${GCP_PROJECT:-}"
REGION="asia-south1"
SECRETS=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="${2:?--project needs a value}"; shift 2 ;;
    --region) REGION="${2:?--region needs a value}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-secrets) SECRETS=0; shift ;;
    -h | --help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done
[[ -n "$PROJECT" ]] || die "--project is required"
[[ "$PROJECT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die "that does not look like a project id: $PROJECT"
[[ "$DRY_RUN" == "1" ]] || need gcloud
export DRY_RUN

RUNTIME_SA="ziro-runtime@${PROJECT}.iam.gserviceaccount.com"
MIGRATE_SA="ziro-migrate@${PROJECT}.iam.gserviceaccount.com"

say "1. APIs"
run gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com --project "$PROJECT"

say "2. Docker repository"
if [[ "$DRY_RUN" == "1" ]] || ! gcloud artifacts repositories describe ziro --location "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  run gcloud artifacts repositories create ziro --repository-format=docker --location "$REGION" \
    --description="Ziro images" --project "$PROJECT"
else
  echo "already there: ziro"
fi

say "3. Service accounts"
for sa in ziro-runtime ziro-migrate; do
  if [[ "$DRY_RUN" == "1" ]] || ! gcloud iam service-accounts describe "${sa}@${PROJECT}.iam.gserviceaccount.com" --project "$PROJECT" >/dev/null 2>&1; then
    run gcloud iam service-accounts create "$sa" --display-name="Ziro ${sa#ziro-}" --project "$PROJECT"
  else
    echo "already there: $sa"
  fi
done

# name | who may read it | what it must look like | required
SECRET_TABLE=(
  "ziro-database-url|$RUNTIME_SA|pooled|yes"
  "ziro-database-url-direct|$MIGRATE_SA|direct|yes"
  "ziro-redis-url|$RUNTIME_SA,$MIGRATE_SA|redis|yes"
  "ziro-gemini-api-key|$RUNTIME_SA|gemini-key|no"
  "ziro-anthropic-api-key|$RUNTIME_SA|key|no"
)

has_version() {
  gcloud secrets versions list "$1" --project "$PROJECT" --filter='state=ENABLED' --limit=1 --format='value(name)' | grep -q .
}

shape_error() { # name kind value -> prints a problem, or nothing
  local name="$1" kind="$2" value="$3"
  case "$kind" in
    pooled)
      [[ "$value" =~ ^postgres(ql)?:// ]] || { echo "must start with postgres:// or postgresql://"; return; }
      [[ "$value" == *-pooler* ]] || echo "must be Neon's POOLED connection string (the host contains -pooler)" ;;
    direct)
      [[ "$value" =~ ^postgres(ql)?:// ]] || { echo "must start with postgres:// or postgresql://"; return; }
      [[ "$value" != *-pooler* ]] || echo "must be the DIRECT connection string (no -pooler in the host): migrations cannot use the pooler" ;;
    redis)
      [[ "$value" == rediss://* ]] || echo "must start with rediss:// (Upstash needs TLS)" ;;
    gemini-key)
      [[ "$value" == AIza* ]] || echo "does not look like a Gemini API key (AIza...)" ;;
    key)
      [[ "$value" == sk-ant-* ]] || echo "does not look like an Anthropic API key (sk-ant-...)" ;;
  esac
}

if [[ "$SECRETS" == "1" ]]; then
  say "4. Secrets (typed silently; press Enter to skip an optional one or keep the current version)"
  for row in "${SECRET_TABLE[@]}"; do
    IFS='|' read -r name readers kind required <<<"$row"
    if [[ "$DRY_RUN" == "1" ]] || ! gcloud secrets describe "$name" --project "$PROJECT" >/dev/null 2>&1; then
      run gcloud secrets create "$name" --replication-policy=automatic --project "$PROJECT"
    else
      echo "secret exists: $name"
    fi

    if [[ "$DRY_RUN" == "1" ]]; then
      echo "+ (would ask for the value of $name and add it as a new version)"
    else
      label="optional"
      [[ "$required" == "yes" ]] && label="required"
      while true; do
        read -rsp "value for $name ($label): " value
        echo
        if [[ -z "$value" ]]; then
          if [[ "$required" == "yes" ]] && ! has_version "$name"; then
            echo "  this one is required"
            continue
          fi
          break # optional, or a required one that already has a version: keep it
        fi
        problem="$(shape_error "$name" "$kind" "$value")"
        if [[ -n "$problem" ]]; then
          echo "  $problem"
          continue
        fi
        printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- --project "$PROJECT" >/dev/null
        echo "  stored as a new version"
        break
      done
      unset value
    fi

    IFS=',' read -ra members <<<"$readers"
    for member in "${members[@]}"; do
      run gcloud secrets add-iam-policy-binding "$name" --project "$PROJECT" \
        --member="serviceAccount:${member}" --role=roles/secretmanager.secretAccessor --condition=None
    done
  done
fi

say "Done"
echo "Next: build, migrate and deploy with"
echo "  scripts/deploy.sh --project $PROJECT --region $REGION"
