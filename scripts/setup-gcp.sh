#!/usr/bin/env bash
# One-time setup of the Google Cloud side of Ziro, in your project. Idempotent: run it again to add a missing
# piece, fix a wrong value or rotate a secret. Nothing here runs until YOU run it.
#
#   scripts/setup-gcp.sh --project my-project [--region asia-south1] [--check] [--dry-run] [--no-secrets]
#                        [--clipboard]
#
# What it does, in order:
#   1. enables the Cloud Run, Artifact Registry and Secret Manager APIs
#   2. creates the Docker repository "ziro" in the region
#   3. creates two service accounts, so the service cannot read what only the deploy job needs:
#        ziro-runtime  runs the service: the app (pooled) database URL, Redis, and optionally the model keys
#        ziro-migrate  runs the deploy job: the OWNER (direct) database URL and Redis
#   4. goes through the secrets ONE AT A TIME and waits for you at each one:
#        - it first checks the value already stored (shown as user and host only, never the password)
#          and tells you if it is wrong
#        - you paste the new value and press Enter (input is hidden). In Git Bash / MSYS2 paste with
#          Shift+Insert or right-click > Paste; Ctrl+V does not paste there
#        - Enter alone keeps a current value that is correct, or skips an optional key
#        - the value is cleaned (quotes, a leading "psql", Windows line endings), checked, shown back as
#          user and host, and stored only after you say yes. Only the right service account may read it.
#        - the last two, ziro-razorpay-key-id and ziro-razorpay-key-secret, are your Razorpay TEST key. They are
#          optional: skip them unless you will deploy with `scripts/deploy.sh --razorpay-test`.
#
#   --check       only report whether each stored secret looks right; changes nothing
#   --clipboard   instead of pasting: copy the value, then press Enter and the script reads the clipboard
#   --dry-run     print what would run
#   --no-secrets  steps 1-3 only
#   (--prompt, --replace, --with-key and --with-claude are still accepted from older commands; every prompt
#    now lets you replace a value or skip an optional key, so they change nothing)
#
# Your database and Redis URLs come from Neon and Upstash: docs/DEPLOY.md, parts 1 and 2.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=lib/common.sh
source scripts/lib/common.sh
DRY_RUN="${DRY_RUN:-0}"

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }

PROJECT="${GCP_PROJECT:-}"
REGION="asia-south1"
SECRETS=1
CHECK_ONLY=0
USE_CLIPBOARD=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="${2:?--project needs a value}"; shift 2 ;;
    --region) REGION="${2:?--region needs a value}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-secrets) SECRETS=0; shift ;;
    --check) CHECK_ONLY=1; shift ;;
    --clipboard) USE_CLIPBOARD=1; shift ;;
    --prompt | --replace | --with-key | --with-claude) shift ;; # old flags, see --help
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done
[[ -n "$PROJECT" ]] || die "--project is required"
[[ "$PROJECT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die "that does not look like a project id: $PROJECT"
[[ "$DRY_RUN" == "1" ]] || need gcloud
export DRY_RUN

RUNTIME_SA="ziro-runtime@${PROJECT}.iam.gserviceaccount.com"
MIGRATE_SA="ziro-migrate@${PROJECT}.iam.gserviceaccount.com"

# name | who may read it | what it must look like | required
SECRET_TABLE=(
  "ziro-database-url|$RUNTIME_SA|pooled|yes"
  "ziro-database-url-direct|$MIGRATE_SA|direct|yes"
  "ziro-redis-url|$RUNTIME_SA,$MIGRATE_SA|redis|yes"
  "ziro-gemini-api-key|$RUNTIME_SA|gemini-key|no"
  "ziro-anthropic-api-key|$RUNTIME_SA|key|no"
  "ziro-razorpay-key-id|$RUNTIME_SA|rzp-key-id|no"
  "ziro-razorpay-key-secret|$RUNTIME_SA|rzp-secret|no"
)

# ---------- values: cleaning, shape checks, safe descriptions (no function here prints a secret) ----------

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# Undoes what copying usually adds: Windows line endings, terminal paste markers, surrounding quotes,
# Neon's "psql '...'" snippet and a "NAME=" prefix copied from a .env file.
clean_value() {
  local v="$1" paste_start=$'\e[200~' paste_end=$'\e[201~'
  v="${v//$'\r'/}"
  v="${v//$'\n'/}"
  v="${v//"$paste_start"/}"
  v="${v//"$paste_end"/}"
  v="$(trim "$v")"
  if [[ "$v" == "psql "* ]]; then v="$(trim "${v#psql }")"; fi
  if [[ "$v" =~ ^[A-Z][A-Z0-9_]*=(.*)$ ]]; then v="$(trim "${BASH_REMATCH[1]}")"; fi
  if [[ ${#v} -ge 2 ]]; then
    local first="${v:0:1}" last="${v: -1}"
    if [[ ( "$first" == "'" && "$last" == "'" ) || ( "$first" == '"' && "$last" == '"' ) ]]; then
      v="${v:1:${#v}-2}"
    fi
  fi
  printf '%s' "$v"
}

url_user() { local rest="${1#*://}"; rest="${rest%%@*}"; printf '%s' "${rest%%:*}"; }
url_host() { local host="${1##*@}"; printf '%s' "${host%%[/?:]*}"; }

shape_error() { # kind value -> prints a problem, or nothing
  local kind="$1" value="$2"
  [[ "$value" != *[[:space:]]* ]] || { echo "contains spaces or line breaks: copy only the value itself"; return; }
  case "$kind" in
    pooled)
      [[ "$value" =~ ^postgres(ql)?:// ]] || { echo "must start with postgres:// or postgresql://"; return; }
      [[ "$value" == *@* ]] || { echo "has no user@host part"; return; }
      [[ "$(url_host "$value")" == *-pooler* ]] || echo "must be Neon's POOLED connection string (the host contains -pooler)" ;;
    direct)
      [[ "$value" =~ ^postgres(ql)?:// ]] || { echo "must start with postgres:// or postgresql://"; return; }
      [[ "$value" == *@* ]] || { echo "has no user@host part"; return; }
      [[ "$(url_host "$value")" != *-pooler* ]] || echo "must be the DIRECT connection string (no -pooler in the host): migrations cannot use the pooler" ;;
    redis)
      [[ "$value" == rediss://* ]] || echo "must start with rediss:// (Upstash needs TLS)" ;;
    gemini-key) # AI Studio has issued auth keys (AQ.) since May 2026; older standard keys start with AIza
      [[ "$value" == AQ.* || "$value" == AIza* ]] || echo "does not look like a Gemini API key (AQ.... or AIza...)" ;;
    key)
      [[ "$value" == sk-ant-* ]] || echo "does not look like an Anthropic API key (sk-ant-...)" ;;
    rzp-key-id)
      [[ "$value" != rzp_live_* ]] || { echo "that is a LIVE key (rzp_live_...): Ziro is Razorpay test mode only"; return; }
      [[ "$value" == rzp_test_* ]] || echo "must start with rzp_test_ (a Razorpay TEST key id)" ;;
    rzp-secret)
      [[ "$value" != rzp_* ]] || echo "that looks like a key id (rzp_...), not the key secret" ;;
  esac
}

shape_note() { # kind value -> a soft warning, or nothing
  local user
  case "$1" in
    pooled)
      user="$(url_user "$2")"
      [[ "$user" == "ziro_app" ]] || echo "note: the app normally connects as ziro_app, this one is $user (docs/DEPLOY.md part 1)" ;;
    direct)
      user="$(url_user "$2")"
      [[ "$user" != "ziro_app" ]] || echo "note: migrations need the database OWNER user, not ziro_app" ;;
  esac
}

describe_value() { # kind value -> user and host of a URL, or the start and length of a key; never the secret
  case "$1" in
    pooled | direct | redis) printf 'user %s, host %s' "$(url_user "$2")" "$(url_host "$2")" ;;
    rzp-key-id) printf '%s..., %d characters' "${2:0:9}" "${#2}" ;; # only the mode prefix of a public id
    rzp-secret) printf '%d characters' "${#2}" ;;
    *) printf '%s..., %d characters' "${2:0:4}" "${#2}" ;;
  esac
}

copy_hint() { # kind -> what to copy and where
  case "$1" in
    pooled) echo "the POOLED Neon URL. Neon > Connect > role ziro_app > Connection pooling ON (host contains -pooler)" ;;
    direct) echo "the DIRECT Neon URL. Neon > Connect > the OWNER role > Connection pooling OFF (no -pooler in the host)" ;;
    redis) echo "the Upstash Redis URL that starts with rediss://" ;;
    gemini-key) echo "the Gemini API key from aistudio.google.com/apikey (new keys start with AQ., older ones with AIza). Optional" ;;
    key) echo "the Anthropic API key (starts with sk-ant-). Optional" ;;
    rzp-key-id) echo "your Razorpay TEST key id (starts with rzp_test_): the RAZORPAY_KEY_ID of your local .env. Optional: only for deploy.sh --razorpay-test" ;;
    rzp-secret) echo "the Razorpay TEST key secret that goes with it: the RAZORPAY_KEY_SECRET of your local .env. Optional: only for deploy.sh --razorpay-test" ;;
  esac
}

# ---------- Secret Manager ----------

has_version() { # name -> true when the secret has an enabled version
  gcloud secrets versions list "$1" --project "$PROJECT" --filter='state=ENABLED' --limit=1 \
    --format='value(name)' 2>/dev/null | grep -q .
}

current_value() { # name -> the latest version's value, empty when it cannot be read. Never printed.
  gcloud secrets versions access latest --secret "$1" --project "$PROJECT" 2>/dev/null || true
}

older_versions() { # name -> enabled version ids except the newest, space separated
  local ids
  ids="$(gcloud secrets versions list "$1" --project "$PROJECT" --filter='state=ENABLED' \
    --sort-by=~createTime --format='value(name.basename())' 2>/dev/null | tail -n +2 | tr '\n' ' ' || true)"
  trim "$ids"
}

store_version() { # name value previous_state
  local name="$1" value="$2" previous="$3" older answer default="N" v
  printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- --project "$PROJECT" >/dev/null
  echo "  stored as a new version (now the latest)"
  older="$(older_versions "$name")"
  [[ -n "$older" ]] || return 0
  [[ "$previous" == "wrong" ]] && default="Y"
  read -rp "  disable the older version(s) $older? They can be re-enabled later. [$( [[ "$default" == "Y" ]] && echo "Y/n" || echo "y/N" )] " answer || answer=""
  answer="${answer:-$default}"
  if [[ "$answer" =~ ^[Yy] ]]; then
    for v in $older; do
      gcloud secrets versions disable "$v" --secret "$name" --project "$PROJECT" >/dev/null
    done
    echo "  disabled version(s): $older"
  fi
}

# ---------- clipboard (only with --clipboard). CLIPBOARD_FILE stands in for the clipboard in tests. ----------

clipboard_available() {
  [[ -n "${CLIPBOARD_FILE:-}" || -e /dev/clipboard ]] && return 0 # /dev/clipboard: MSYS2, Git Bash, Cygwin
  command -v pbpaste >/dev/null 2>&1 || command -v wl-paste >/dev/null 2>&1 || command -v xclip >/dev/null 2>&1
}

clipboard_text() { # the clipboard, empty when it cannot be read. Never printed.
  if [[ -n "${CLIPBOARD_FILE:-}" ]]; then
    tr -d '\000' <"$CLIPBOARD_FILE" 2>/dev/null || true
  elif [[ -e /dev/clipboard ]]; then
    tr -d '\000' </dev/clipboard 2>/dev/null || true
  elif command -v pbpaste >/dev/null 2>&1; then
    pbpaste 2>/dev/null | tr -d '\000' || true
  elif command -v wl-paste >/dev/null 2>&1; then
    wl-paste 2>/dev/null | tr -d '\000' || true
  elif command -v xclip >/dev/null 2>&1; then
    xclip -selection clipboard -o 2>/dev/null | tr -d '\000' || true
  fi
}

# ---------- one secret, one stop ----------

POOLED_HOST=""
DIRECT_HOST=""

remember_host() { # kind value
  case "$1" in
    pooled) POOLED_HOST="$(url_host "$2")" ;;
    direct) DIRECT_HOST="$(url_host "$2")" ;;
  esac
}

current_state() { # name kind -> sets STATE (none|ok|wrong|unreadable), CURRENT and PROBLEM
  STATE="none"; CURRENT=""; PROBLEM=""
  has_version "$1" || return 0
  CURRENT="$(current_value "$1")"
  if [[ -z "$CURRENT" ]]; then
    STATE="unreadable"
    return 0
  fi
  PROBLEM="$(shape_error "$2" "$CURRENT")"
  if [[ -n "$PROBLEM" ]]; then STATE="wrong"; else STATE="ok"; fi
}

ask_secret() { # name kind required
  local name="$1" kind="$2" required="$3" empty_means raw value problem note answer
  current_state "$name" "$kind"
  case "$STATE" in
    none) echo "  no value yet" ;;
    ok) echo "  current value looks right ($(describe_value "$kind" "$CURRENT"))" ;;
    unreadable) echo "  has a value, but your account cannot read it to check it" ;;
    wrong) echo "  current value is WRONG ($(describe_value "$kind" "$CURRENT")): $PROBLEM" ;;
  esac
  echo "  copy $(copy_hint "$kind")"

  case "$STATE" in
    ok | unreadable) empty_means="keep the current value" ;;
    wrong) [[ "$required" == "yes" ]] && empty_means="not allowed, the current value is wrong" || empty_means="leave it as it is" ;;
    none) [[ "$required" == "yes" ]] && empty_means="not allowed, this one is required" || empty_means="skip it" ;;
  esac

  while true; do
    if [[ "$USE_CLIPBOARD" == "1" ]]; then
      IFS= read -rp "  copy it, then press Enter here (type k to $empty_means): " answer || die "input ended before $name was set"
      if [[ "$answer" == [kK] ]]; then
        value=""
      else
        value="$(clean_value "$(clipboard_text)")"
        [[ -n "$value" ]] || { echo "  the clipboard is empty, copy the value first"; continue; }
      fi
    else
      IFS= read -rsp "  paste it and press Enter (hidden; Enter alone: $empty_means): " raw || { echo; die "input ended before $name was set"; }
      echo
      value="$(clean_value "$raw")"
      raw=""
    fi

    if [[ -z "$value" ]]; then
      case "$STATE" in
        ok | unreadable) echo "  kept"; [[ "$STATE" == "ok" ]] && remember_host "$kind" "$CURRENT"; break ;;
        wrong) if [[ "$required" == "yes" ]]; then echo "  a new value is needed"; continue; fi
               echo "  left as it is (still wrong)"; break ;;
        none) if [[ "$required" == "yes" ]]; then echo "  this one is required"; continue; fi
              echo "  skipped (optional)"; break ;;
      esac
    fi

    problem="$(shape_error "$kind" "$value")"
    if [[ -n "$problem" ]]; then
      echo "  that is not it: $problem. Try again."
      continue
    fi
    echo "  got: $(describe_value "$kind" "$value")"
    note="$(shape_note "$kind" "$value")"
    [[ -z "$note" ]] || echo "  $note"
    if [[ "$STATE" == "ok" && "$value" == "$CURRENT" ]]; then
      echo "  same as the current value, kept"
      remember_host "$kind" "$value"
      break
    fi
    read -rp "  store it? [Y/n] " answer || answer=""
    if [[ "$answer" =~ ^[Nn] ]]; then
      echo "  not stored. Paste it again."
      continue
    fi
    store_version "$name" "$value" "$STATE"
    remember_host "$kind" "$value"
    break
  done
  value=""
  CURRENT=""
}

check_same_endpoint() {
  [[ -n "$POOLED_HOST" && -n "$DIRECT_HOST" ]] || return 0
  if [[ "${POOLED_HOST/-pooler/}" != "$DIRECT_HOST" ]]; then
    echo "WARNING: the pooled and direct URLs point at different Neon endpoints ($POOLED_HOST vs $DIRECT_HOST)."
    echo "         Both must come from the same Neon branch and database, or migrations and the app see different data."
    return 1
  fi
  echo "pooled and direct URLs point at the same Neon endpoint"
}

# ---------- --check: report only ----------

if [[ "$CHECK_ONLY" == "1" ]]; then
  need gcloud
  say "Checking secrets in $PROJECT (nothing is changed)"
  bad=0
  for row in "${SECRET_TABLE[@]}"; do
    IFS='|' read -r name readers kind required <<<"$row"
    if ! gcloud secrets describe "$name" --project "$PROJECT" >/dev/null 2>&1; then
      echo "MISSING  $name"
      [[ "$required" == "yes" ]] && bad=1
      continue
    fi
    current_state "$name" "$kind"
    case "$STATE" in
      ok) echo "OK       $name ($(describe_value "$kind" "$CURRENT"))"; remember_host "$kind" "$CURRENT" ;;
      wrong) echo "WRONG    $name ($(describe_value "$kind" "$CURRENT")): $PROBLEM"; bad=1 ;;
      unreadable) echo "UNKNOWN  $name (has a value your account cannot read)" ;;
      none) echo "EMPTY    $name"; [[ "$required" == "yes" ]] && bad=1 ;;
    esac
    CURRENT=""
  done
  check_same_endpoint || bad=1
  if [[ "$bad" == "1" ]]; then
    echo "Fix with: scripts/setup-gcp.sh --project $PROJECT --region $REGION"
    exit 1
  fi
  exit 0
fi

# ---------- setup ----------

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

if [[ "$SECRETS" == "1" ]]; then
  if [[ "$USE_CLIPBOARD" == "1" ]]; then
    clipboard_available || die "no clipboard found; run without --clipboard and paste instead"
    say "4. Secrets, one at a time (copy each value, then press Enter here)"
  else
    say "4. Secrets, one at a time (paste with Shift+Insert or right-click > Paste; input is hidden)"
  fi
  total="${#SECRET_TABLE[@]}"
  n=0
  for row in "${SECRET_TABLE[@]}"; do
    IFS='|' read -r name readers kind required <<<"$row"
    n=$((n + 1))
    echo
    echo "[$n/$total] $name ($([[ "$required" == "yes" ]] && echo required || echo optional))"
    if [[ "$DRY_RUN" == "1" ]] || ! gcloud secrets describe "$name" --project "$PROJECT" >/dev/null 2>&1; then
      run gcloud secrets create "$name" --replication-policy=automatic --project "$PROJECT"
    fi

    if [[ "$DRY_RUN" == "1" ]]; then
      echo "+ (would check the current value and ask for $name)"
    else
      ask_secret "$name" "$kind" "$required"
    fi

    IFS=',' read -ra members <<<"$readers"
    for member in "${members[@]}"; do
      run gcloud secrets add-iam-policy-binding "$name" --project "$PROJECT" \
        --member="serviceAccount:${member}" --role=roles/secretmanager.secretAccessor --condition=None --format=none
    done
    echo "  readable by: ${readers//@${PROJECT}.iam.gserviceaccount.com/}"
  done
  echo
  check_same_endpoint || true
fi

say "Done"
echo "Check the stored values any time with"
echo "  scripts/setup-gcp.sh --project $PROJECT --region $REGION --check"
echo "Next: build, migrate and deploy with"
echo "  scripts/deploy.sh --project $PROJECT --region $REGION"