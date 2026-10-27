# Shared by scripts/setup-gcp.sh and scripts/deploy.sh. Source it; do not run it.
#
# DRY_RUN=1 prints every command that would change something instead of running it. Reads that only
# look (describe, list) still run when they are needed to plan, unless they need your account: in a dry run
# those are replaced by placeholders, so `--dry-run` works on a machine that is not logged in.
# None of this calls git.

DRY_RUN="${DRY_RUN:-0}"

# Git Bash and MSYS2 on Windows rewrite an argument like httpGet.path=/health into a Windows path before gcloud
# sees it. Leave only those arguments alone. Do NOT set MSYS_NO_PATHCONV=1 here: gcloud's own bash wrapper needs
# the translation to find gcloud.py, and with it off every gcloud command fails ("D:\c\Users\...\gcloud.py").
# Harmless everywhere else.
export MSYS2_ARG_CONV_EXCL="httpGet."

# A path a native program (gcloud) can open: the same file in the form Windows understands. Elsewhere it
# returns the path unchanged.
native_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

say() { printf '\n== %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Run a command, or show it. %q quotes it so what is printed can be pasted.
run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed"
}

# The newest ENABLED version number of a secret, so a deploy pins it (Cloud Run reads an env-var secret once,
# at instance start, and recommends a pinned version over `latest`).
secret_version() {
  local name="$1" v
  if [[ "$DRY_RUN" == "1" ]]; then
    printf 'VERSION_OF_%s' "$name"
    return 0
  fi
  v="$(gcloud secrets versions list "$name" --project "$PROJECT" \
    --filter='state=ENABLED' --sort-by='~createTime' --limit=1 --format='value(name)')"
  [[ -n "$v" ]] || die "secret $name has no enabled version; run scripts/setup-gcp.sh first"
  printf '%s' "${v##*/}"
}
