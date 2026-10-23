# Deploying Ziro

One container image serves the API and the console on one URL. It runs on **Google Cloud Run (asia-south1)**,
with **Postgres on Neon** and **Redis on Upstash**; secrets live in **Secret Manager**. Nothing in this repo
runs against your accounts until you run it, and nothing here calls git.

```
 stranger's browser ──https──▶ Cloud Run service "ziro"  (1 instance max, 512 MiB, CPU always on)
                                 │  /            the console (React, served by the API)
                                 │  /demo/runs   start a run · /demo/reset · /runs/:id/…  read the results
                                 │  /health      startup probe (database + redis)    /health/live  liveness
                                 ├──▶ Neon Postgres   POOLED url, role ziro_app (cannot touch the audit trail)
                                 ├──▶ Upstash Redis   rediss:// (health check and job producer only)
                                 └──▶ Anthropic API   only if you deployed with --with-key

 scripts/deploy.sh ─▶ Cloud Run JOB "ziro-prepare"  (same image, role ziro_migrate, Neon DIRECT url)
                        1. apply migrations   2. grant ziro_app its privileges   3. build the featured runs
```

## 0. The decisions, and what they cost

| Decision          | Choice                                                            | Why                                                                                                                                                                                                                                                                                                      |
| ----------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CPU               | **always allocated** (`--no-cpu-throttling`)                      | By default Cloud Run gives an instance CPU only while it is handling a request. A demo run continues in the background after `POST /demo/runs` has answered, so with the default it would crawl between the browser's polls. ([docs](https://docs.cloud.google.com/run/docs/configuring/cpu-allocation)) |
| Instances         | **max 1**                                                         | The per-visitor rate limits, the model circuit breaker and the featured-run check live in the process. One instance makes them exact, and bounds Neon connections and cost. The daily model budget is summed from the database, so it holds regardless.                                                  |
| Minimum instances | **0 normally; 1 while people are looking** (see below)            | Cost against first-visit latency.                                                                                                                                                                                                                                                                        |
| Memory            | 512 MiB (the job: 1 GiB)                                          | Measured: about 80 MiB resident after a whole smoke run, 228 KB of generated data in `/tmp`. Always-on CPU needs at least 512 MiB.                                                                                                                                                                       |
| Queue worker      | **off** (`AGENT_WORKER_ENABLED=false`)                            | The demo runs the agent in-process; the BullMQ worker would poll Redis while idle, and Upstash bills per command. ([Upstash](https://upstash.com/docs/redis/integrations/bullmq))                                                                                                                        |
| Featured runs     | built by the deploy job, not at boot (`DEMO_SEED_ON_BOOT=false`)  | A visitor never waits for a 500-order run, and a cold start stays short.                                                                                                                                                                                                                                 |
| Image             | production dependencies only, **no Agent SDK binary**, non-root   | The SDK's native binary (about 285 MB) belongs to harness B, an eval-time tool. Harness A (the loop) is what runs here.                                                                                                                                                                                  |
| Database roles    | `ziro_owner`-style role migrates; **`ziro_app`** runs the service | ADR-005: a role that does not own the tables cannot disable the audit trail's append-only trigger. The job re-grants on every deploy, so a new table is covered at once.                                                                                                                                 |

### Minimum instances: 0 or 1

With always-allocated CPU an instance is billed for its whole life, idle or not
([docs](https://docs.cloud.google.com/run/docs/configuring/min-instances)).

|                             | `--min-instances 0`                                                | `--min-instances 1`                                      |
| --------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------- |
| Idle cost                   | nothing (no instance)                                              | one instance, around the clock                           |
| Estimate                    | pay only while an instance is alive after a visit                  | about **$49 a month** at the listed Mumbai rates (below) |
| First visitor               | waits for a cold start: container start, Node boot, Neon waking up | none                                                     |
| Stranger's first impression | a slow first page, then normal                                     | instant                                                  |

The estimate is arithmetic on Google's Tier 1 instance-based rates as listed for Mumbai, about $0.000018 per
vCPU-second and $0.000002 per GiB-second: (1 × 0.000018 + 0.5 × 0.000002) × 2,592,000 s in 30 days ≈ $49. The
pricing page was not readable when this was written, so **check the price calculator before you rely on it**.

**Recommendation: deploy with 0, and switch to 1 for the days someone is going to open the link** (the
application window), then back. `--cpu-boost` is on for both, which speeds a cold start.

```bash
gcloud run services update ziro --region "$REGION" --project "$PROJECT" --min-instances 1   # warm
gcloud run services update ziro --region "$REGION" --project "$PROJECT" --min-instances 0   # back to idle
```

Do **not** point an uptime check at the service while `--min-instances` is 0: it would keep an instance alive
and defeat the point.

## 1. What you need

- A Google Cloud project with billing on, and the `gcloud` CLI logged in (`gcloud auth login`).
- Docker (the image is built on your machine and pushed; no Cloud Build, so nothing here touches git or a
  build API).
- Node 24 (for the smoke test), `curl`, and **bash 4.4 or later**. On Windows use Git Bash or WSL.
- A Neon account and an Upstash account.

```bash
export PROJECT=your-project-id          # e.g. ziro-demo-123456
export REGION=asia-south1
gcloud config set project "$PROJECT"
```

## 2. Rehearse locally first

This builds the production image and runs it exactly as Cloud Run will, against the compose services, with the
service connected as the restricted role. The Anthropic key is **not** passed in.

```bash
docker compose up -d --wait postgres redis        # once; the script also does this
scripts/docker-local.sh up                         # build, migrate, grant, build the featured runs, start
node scripts/smoke.mjs http://127.0.0.1:8080 --no-key
scripts/docker-local.sh down
```

`smoke.mjs` plays the stranger's path and exits non-zero on the first thing that is wrong: page loads, probes,
the replay is ready and read-only, a run finishes, a proposal can be approved, the endpoints a public demo must
refuse are refused, Reset demo works, and the server has no model key. The same script runs after a deploy.

## 3. Neon (Postgres)

1. Create a project. Pick the region nearest `asia-south1` that Neon offers: every query crosses that gap.
2. Create a database (the default is fine). Note its name.
3. **Roles.** The default role owns the tables and runs migrations. In the console (Roles & Databases) add a
   second role named **`ziro_app`** and keep its password. Never use the owner for the service.
4. **Two connection strings**, from the console's _Connect_ dialog (choose the role in the dropdown):
   - **Direct** (connection pooling **off**), role = the owner: for migrations.
     `postgresql://OWNER:PASSWORD@ep-xxxx.REGION.aws.neon.tech/DBNAME?sslmode=require`
   - **Pooled** (connection pooling **on**; the host has `-pooler`), role = `ziro_app`: for the service.
     `postgresql://ziro_app:PASSWORD@ep-xxxx-pooler.REGION.aws.neon.tech/DBNAME?sslmode=require`

   The pooler runs in transaction mode and does not support session state such as `SET`, `LISTEN` or session
   advisory locks ([docs](https://neon.com/docs/connect/connection-pooling)). The service uses none (checked:
   its only `set_config` is transaction-local), and migrations use the direct string and take their lock there.

5. Check the plan's storage limit. A demo run is small, but runs are **archived, never deleted** (the audit
   trail is append-only), and the rate limits are what bound growth.

## 4. Upstash (Redis)

1. Create a database. Region: nearest to `asia-south1`.
2. Leave TLS on. **Leave Eviction off** (the default): BullMQ needs `noeviction`
   ([BullMQ](https://docs.bullmq.io/guide/going-to-production),
   [Upstash](https://upstash.com/docs/redis/features/eviction)).
3. Copy the TCP URL, which starts `rediss://default:PASSWORD@HOST:6379`. Ziro turns TLS on for `rediss://`.
4. With the worker off, Redis sees a health ping and nothing else, so the free or pay-as-you-go plan is fine.
   **If you ever turn the worker on** (`AGENT_WORKER_ENABLED=true`), move to a fixed plan: BullMQ talks to
   Redis even when idle, and pay-as-you-go bills per command.

## 5. Google Cloud, once

```bash
scripts/setup-gcp.sh --project "$PROJECT" --region "$REGION" --dry-run   # read what it will do
scripts/setup-gcp.sh --project "$PROJECT" --region "$REGION"
```

It enables Cloud Run, Artifact Registry and Secret Manager, creates the Docker repository `ziro`, and creates
two service accounts so the service cannot read what only the deploy job needs:

| Account        | Runs        | May read                                                                      |
| -------------- | ----------- | ----------------------------------------------------------------------------- |
| `ziro-runtime` | the service | `ziro-database-url` (pooled, `ziro_app`), `ziro-redis-url`, and the model key |
| `ziro-migrate` | the job     | `ziro-database-url-direct` (owner), `ziro-redis-url`                          |

It then asks for each secret, **typed silently** (never on a command line or in a file), checks its shape (the
pooled URL must contain `-pooler`, the direct one must not, Redis must be `rediss://`), and stores it as a new
version. The Anthropic key is optional: press Enter to skip it.

## 6. Deploy

```bash
scripts/deploy.sh --project "$PROJECT" --dry-run        # every command, none run
scripts/deploy.sh --project "$PROJECT"                  # replay + scripted runs, no model
scripts/deploy.sh --project "$PROJECT" --with-key       # also the live model option (needs the key secret)
scripts/deploy.sh --project "$PROJECT" --min-instances 1 --version 2026-10-24-a
```

In order, it: builds and pushes `…/ziro/ziro:VERSION` (the tag is `--version`, or the UTC time; never git) →
creates or updates the job `ziro-prepare` and **runs it to completion** (migrations, grants for `ziro_app`, the
featured runs) → deploys the service → runs `scripts/smoke.mjs` against the new URL. If the job fails, the
service is **not** deployed and the old revision keeps serving. Migrations must therefore stay compatible with
the revision still running.

The service is deployed with: `--allow-unauthenticated` (no login), `--max-instances 1`, `--concurrency 80`,
`--no-cpu-throttling`, `--cpu-boost`, a startup probe on `/health` (up to 4 minutes for the database to wake)
and a liveness probe on `/health/live`, which looks at nothing but the process, so a database outage never
gets the container killed. Secrets are **pinned to the version that was current at deploy time**: Cloud Run
reads them once, when an instance starts ([docs](https://docs.cloud.google.com/run/docs/configuring/services/secrets)).

If `--allow-unauthenticated` is refused, your organisation's policy forbids public services
(domain-restricted sharing). That has to be changed by an organisation administrator; a public demo cannot work
without it.

## 7. Check it as a stranger

Open the URL printed at the end in a **private window**. You should be able to, with no login:

1. see the home page, and click **Replay eval run (500 orders, free, no key needed)**: a precomputed,
   read-only run (a banner says so; Approve and Reject are absent);
2. click **Run demo batch (50 orders)**, watch it work, then review: the totals add up, two planted proposals are
   refused by the checker, and a match can be approved;
3. click **Reset demo**: your run is archived (still readable, no longer reviewable) and a fresh one starts;
4. (DEMO_MODE) tick **Break two investigations on purpose** and see a timeout retried and handed to a person.

The replay, runs, review and reset all work with `ANTHROPIC_API_KEY` unset. With no key the live checkbox is not
even offered. The same checks, scripted:

```bash
node scripts/smoke.mjs "$(gcloud run services describe ziro --region "$REGION" --format='value(status.url)')" --no-key
```

## 8. What a stranger can and cannot do (`DEMO_MODE=true`)

| Guardrail                                 | How                                                                                                                                                                                      | Where                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| No login                                  | `--allow-unauthenticated`; there is nothing to sign in to                                                                                                                                | `deploy.sh`                            |
| Only three things can be changed          | A default-deny allowlist: start a run, reset **your** run, approve or reject a proposal in a run of your own. Imports, creating runs, matching, verifying and **investigate** answer 403 | `demo/demo-mode.guard.ts`              |
| Live runs: 5 an hour per visitor          | In-process limiter, 30 an hour overall; scripted runs 20 per visitor and 200 overall. All in `deploy/demo.env`; a refusal by one limit does not use up another's allowance               | `demo/demo.module.ts`, `rate-limit.ts` |
| A global daily model budget               | `DAILY_LLM_BUDGET_USD` (2), summed from `llm_calls` for the UTC day before every model request; at the cap the agent pauses, the rules and the replay keep working, and a banner says so | `agent/agent.service.ts`               |
| A kill switch                             | `AGENT_KILL_SWITCH=true` stops all model calls                                                                                                                                           | below                                  |
| The replay costs nothing and needs no key | It is a stored run: opening it only reads the database. Featured runs are read-only for everyone                                                                                         | `review/review.service.ts`             |
| Reset demo                                | Archives the run you name (never anyone else's) and starts a fresh scripted one; nothing is deleted                                                                                      | `demo/demo.service.ts`                 |
| Test keys only                            | The app refuses an `rzp_live_` key at boot; `deploy.sh` refuses to ship one; the public demo uses generated data and deploys no Razorpay keys at all                                     | `config/env.ts`, `deploy.sh`           |
| The audit trail cannot be edited          | The service's role has no `UPDATE` on it and does not own the table, so it cannot disable the trigger                                                                                    | `scripts/migrate.ts`                   |

Set a **spend limit on the Anthropic side** for the key you deploy (in the Console's limits settings): it is the
backstop if everything above failed. Use a key made for this demo and nothing else.

## 9. Operating it

```bash
# Logs (structured JSON: severity, message, trace). In Logs Explorer:
#   resource.type="cloud_run_revision" resource.labels.service_name="ziro" severity>=WARNING
gcloud run services logs read ziro --region "$REGION" --limit 50

# Stop all model calls now (the next deploy puts it back to what deploy/demo.env says)
gcloud run services update ziro --region "$REGION" --update-env-vars AGENT_KILL_SWITCH=true

# Remove the live option entirely: deploy without --with-key
scripts/deploy.sh --project "$PROJECT" --skip-build --skip-prepare --version SAME_TAG_AS_NOW

# Roll back to the previous revision
gcloud run revisions list --service ziro --region "$REGION"
gcloud run services update-traffic ziro --region "$REGION" --to-revisions=REVISION_NAME=100

# Rotate a secret: add a version, then redeploy the service so it picks the new pinned version
printf '%s' "$NEW_VALUE" | gcloud secrets versions add ziro-redis-url --data-file=-
scripts/deploy.sh --project "$PROJECT" --skip-build --skip-prepare --version SAME_TAG_AS_NOW
```

Run the job alone (for example after a change to the featured runs) with
`gcloud run jobs execute ziro-prepare --region "$REGION" --wait`.

**Taking it down:** `gcloud run services delete ziro`, `gcloud run jobs delete ziro-prepare`, delete the
secrets (`ziro-*`), the Artifact Registry repository `ziro`, the two service accounts; then delete the Neon
project and the Upstash database in their consoles.

## 10. Troubleshooting

| Symptom                                                  | Likely cause                                                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| The job fails: `database role ziro_app does not exist`   | Create the role in Neon (part 3) or deploy with `--no-app-role`.                                                                |
| The job fails on migrations with a lock or session error | The direct URL contains `-pooler`. Use the non-pooled string for `ziro-database-url-direct`.                                    |
| The revision never becomes ready                         | Read its log. Usually `DATABASE_URL`/`REDIS_URL` is wrong, or Neon is slow to wake (the startup probe allows 4 minutes).        |
| The page loads but runs never finish                     | CPU is throttled: confirm `gcloud run services describe ziro --format=yaml` shows `run.googleapis.com/cpu-throttling: 'false'`. |
| `permission denied for table …` in the service log       | The job has not granted `ziro_app` since a table was added. Run the job (`gcloud run jobs execute ziro-prepare --wait`).        |
| 429 from `/demo/runs`                                    | A rate limit. The body says which. The limits reset as the hour rolls; they are held in the process, so a restart forgets them. |
| Replay says it is still being prepared                   | The job has not finished or failed; read its log: `gcloud run jobs executions list --job ziro-prepare --region "$REGION"`.      |

## 11. What this does not do

- It is not a multi-user product: no accounts, no tenancy. A reviewer's name is whatever is typed.
- Limits and the circuit breaker live in one process; with more than one instance they would count separately.
- The deploy has been rehearsed locally against the compose Postgres and Redis (including the restricted
  role), and the scripts' commands were checked against `gcloud --help`. **It has not been run against a real
  Google Cloud, Neon or Upstash account.** Expect to fix something small the first time; the smoke test says what.
- No Cloud Monitoring alerts, uptime checks, or billing budgets are created. Add a billing budget alert in the
  console before you share the link.
