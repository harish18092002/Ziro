# Architecture Decision Records

Notable decisions, newest last. Each: context, decision, alternatives, consequences.

---

## ADR-001: Monorepo with a framework-free core package

**Status:** accepted

**Context.** Ziro's value is the matching and verification logic: money arithmetic, normalization,
the T1–T4 waterfall, the verifier that can reject the agent. That logic must be provably correct,
property-testable, and reusable by the API, the data generator and the eval runner. Frameworks
(NestJS, Drizzle, BullMQ) change on their own schedule and must not leak into it.

**Decision.** One npm-workspaces monorepo (`apps/*`, `packages/*`, one root `package-lock.json`).
`@ziro/core` is pure TypeScript: no framework, no database, no HTTP, no filesystem. It is enforced,
not just intended: `eslint.config.js` forbids those imports under `packages/core/src`. Apps and the
other packages depend on core with `"*"` (npm has no `workspace:` protocol).

**Alternatives.**

- _A single Nest app with a `matcher/` folder._ Simpler, but nothing stops IO or framework code
  creeping into the matcher, and datagen/evals would have to import the whole API.
- _Polyrepo._ Cross-repo versioning overhead for one person; the git history is the evidence of
  fresh work and is easier to read in one place.
- _Nx / Turborepo._ More power than needed; plain workspaces plus TypeScript project references
  cover build ordering.

**Consequences.**

- Libraries build to `dist/` via `tsc -b` (project references). Anything that type-checks, lints or
  tests against `@ziro/*` runs `npm run build:libs` first; the root scripts do this.
- Core stays unit-testable with no mocks, and fast-check property tests run in milliseconds.
- One lockfile, one install, one `npm ci` in CI and Docker.

---

## ADR-002: ESM everywhere, Vitest everywhere

**Status:** accepted (amends CLAUDE.md §5, which listed Jest for `apps/api`)

**Context.** NestJS 12 ships ESM-only packages. Its generator now produces ESM projects with Vitest
by default and CommonJS projects with Jest. Jest can load the ESM-only packages only on Node 24.9+
and needs extra ESM configuration.

**Decision.** Every package is `"type": "module"` with `module`/`moduleResolution: nodenext`,
ES2023 and `.js` suffixes on relative imports. Vitest is the single test runner (the apps/web Vite
build already depends on Vite 8). Decorator metadata is emitted by the same Vite 8 pipeline from
`experimentalDecorators` / `emitDecoratorMetadata` in `apps/api/tsconfig.json`; a health-controller
test that relies on constructor injection guards this.

**Alternatives.**

- _CommonJS API + Jest._ Works through `require(esm)` on Node 24, but mixes two module systems
  across the workspaces and two test runners across the repo.
- _ESM API + Jest._ Possible, but needs `--experimental-vm-modules` style configuration for no gain.

**Consequences.** One runner and one config style for core property tests, API tests and evals. The
price is the `.js`-suffix import convention and relying on Vite's decorator-metadata handling; if it
ever regresses, `@swc/core` with `unplugin-swc` is the fallback.

---

## ADR-003: TypeScript pinned to 6.0.x

**Status:** accepted

**Context.** The `latest` tag of `typescript` is 7.x. `typescript-eslint` 8.72 supports
`>=4.8.4 <6.1.0`, and Nest CLI 12 bundles `typescript ~6.0.2`.

**Decision.** Pin `typescript` to `~6.0.3` at the repo root. Revisit when `typescript-eslint` and
the Nest CLI both declare TypeScript 7 support.

**Alternatives.** Use 7.x and lose type-aware linting or accept unsupported-peer warnings.

**Consequences.** All packages compile with one compiler version. TypeScript 6 defaults `types` to
`[]`, so each tsconfig lists its ambient types explicitly (`node`, `vite/client`).

---

## ADR-004: Razorpay `fee` is GST-inclusive

**Status:** accepted (corrects the settlement formula in CLAUDE.md §7)

**Context.** CLAUDE.md §7 wrote a settlement as `Σpayments − Σfees − Σtax − Σrefunds ± adjustments`.
Razorpay's payment docs define `fee` as "Fee (including GST) charged by Razorpay" and `tax` as "GST
charged for the payment". The doc samples agree: amount 2100, fee 50, tax 8 is a base fee of 42
(2% of 2100) plus 18% GST (7.56, rounded to 8). The settlement recon samples show
`credit = amount − fee` with no separate tax term. Subtracting tax again would double-count it.

**Decision.** Model `fee` as GST-inclusive and `tax` as the GST portion of it, in the domain schemas
and the database (`rzp_payments.fee_paise`, `tax_paise`, `CHECK tax <= fee`). The base fee is
`fee − tax`, and the verifier's fee check is `tax == gstOnFee(fee − tax)`. `gstOnFee` takes the
pre-GST base fee. Tax is not forced to equal 18% of anything: some documented samples show a fee
with tax 0, so judging that is the verifier's job (`FEE_OVERCHARGE`), not a schema constraint.
Settlement-level `fees` and `tax` are stored but informational (both 0 for a normal settlement per
the docs); the real accounting is in `settlement_items`.

**Alternatives.** Keep §7 as written and treat `fee` as GST-exclusive. Rejected: it contradicts the
documented entity and would make every payment look like a fee overcharge.

**Consequences.** Rounding is half-up to the paise, which is our explicit convention. Razorpay's
behaviour on exact .5 ties is undocumented, so tie cases should be confirmed against test-mode data
when the Razorpay integration lands.

---

## ADR-005: Database invariants — match groups and the append-only audit log

**Status:** accepted

**Context.** "Every paisa accounted for" needs the database, not only the code, to refuse bad
states: a record matched twice, an "accepted" match that does not reconcile, a rewritten audit trail.

**Decision.**

- **Two kinds of match group.** `order` groups tie ledger entries to the payments and refunds that
  settle them; `payout` groups tie a settlement to the bank line it landed as. Which payments a
  settlement contains comes from `settlement_items` (Razorpay's own recon data), not from a match.
  So a payment can be in an accepted `order` group while its settlement is in an accepted `payout`
  group, and the rule "a record sits in at most one accepted group" still holds.
- **How that rule is enforced.** `match_links` has one nullable foreign key per record type (real
  referential integrity), a `CHECK` that exactly one is set, and `group_status` mirrored from the
  group through a composite foreign key `(group_id, group_status) → match_groups(id, status)` with
  `ON UPDATE CASCADE`. One partial unique index per record type, `WHERE group_status = 'accepted'`,
  then says "at most one accepted group". No trigger is needed, and it keeps holding when a group
  is promoted or reversed.
- **Accepted means reconciled.** `CHECK (status <> 'accepted' OR residual_paise = 0)`: the verifier
  must have computed a zero residual before a group can be accepted.
- **Audit log.** `audit_events` has a `BEFORE UPDATE OR DELETE` row trigger and a `BEFORE TRUNCATE`
  statement trigger that raise `restrict_violation`. Runs are never hard-deleted: every `run_id`
  foreign key is `ON DELETE RESTRICT`, with no cascades anywhere.

**Alternatives.** A polymorphic `(record_type, record_id)` link (simpler, no foreign keys, so no
referential integrity); one group spanning the whole ledger-to-bank chain (a payment could then never
also take part in a settlement-level match); a trigger to enforce uniqueness (more moving parts).

**Consequences.** The audit trigger stops the application, not a table owner or superuser, who can
still drop it. In production the app must connect as a role that does not own the tables; granting
it only `INSERT, SELECT` on `audit_events` is a second layer to add with the deploy work. Writing
the audit rows is the application's job and is not part of this schema task.

---

## ADR-006: Database tests run on in-process Postgres (PGlite)

**Status:** accepted

**Context.** Migration and constraint tests need a real Postgres. Requiring Docker for every
`npm test` (and a service container in CI) makes the fast inner loop fragile.

**Decision.** `apps/api` tests use `@electric-sql/pglite` (Postgres compiled to WASM, currently
18.x) and apply the project's real migrations through Drizzle's own migrator, so a fresh database is
built exactly as in production. Production targets Postgres 16 (docker compose), so each schema
change is also applied once with `npm run db:migrate` against the compose database.

**Alternatives.** Testcontainers or a CI service container (real 16, but needs Docker everywhere);
mocking the database (would prove nothing about constraints).

**Consequences.** The suite needs no infrastructure. Differences between PGlite and 16 do not matter
for what is used here (triggers, partial unique indexes, composite foreign keys, check constraints),
and the first version of this schema was verified on both. Each DB test file boots its own database
(a few seconds); keep the DB suite focused.

---

## ADR-007: Ground-truth semantics for synthetic data

**Status:** accepted

**Context.** Every published number is measured against `truth.json`, so what it asserts must be
unambiguous, and the data it describes must be able to embarrass a matcher. Several of those
choices are not obvious from the Razorpay docs or from the brief.

**Decision.**

- **Reason codes label causes, not structure.** `reasonCodes` on a record hold only _injected_
  anomalies. Batching and fee deduction happen in every settlement and are handled by rules, so they
  sit on payout groups as `structural`; counting them per record would dilute exception-classification
  accuracy. An anomaly lists the records whose normal 1:1 matching it impedes (its "cluster"), each
  with a role.
- **`groupId: null` is an answer.** A cash order, a payment-link payment, an unrefunded duplicate, a
  failed attempt, a non-Razorpay bank line and a decoy credit have no true group. Groups follow
  ADR-005 (`order` and `payout`), and each carries its exact-paise composition so the verifier's
  residual definition can be checked against ground truth.
- **Duplicates are checkout retries.** The Orders docs say an order stops accepting payments once
  paid and that a receipt must be unique, so a duplicate is a second order (receipt `<ref>-R1`) that
  was also paid. This needs `razorpay_orders.json`, which also carries the `receipt` the Payment
  entity lacks.
- **`TIMEZONE_DATE_SHIFT` crosses IST midnight.** A plain UTC-to-IST conversion only changes the date
  for 00:00–05:29 IST, not 23:30–23:59. The anomaly is an order placed 23:30–23:59 and paid after
  midnight, so the ledger says D and Razorpay and the bank imply D+1.
- **Ambiguity comes from decoys.** A same-amount credit from another sender is planted near a
  settlement with a damaged UTR, which is simpler and more controllable than forcing two settlements
  to net identically.
- **Counts are exact, and independently re-counted.** Anomalies are allocated by shuffled selection
  with `⌊bps × pool / 10 000 + ½⌋` records each, never per-record coin flips. Tests re-count them
  from the raw output files with separate logic.
- **The generator owns its own time maths.** IST and calendar arithmetic is integer-only and
  deliberately not shared with the future `@ziro/core` normalizer, so a bug in either shows up in the
  eval instead of cancelling out.
- **Bank debits are bounded by income** (`debitShareBps`, 65%). Drawing debits from fixed size tiers
  made them 1.7 to 2.3 times the credits in every preset and drained the account at stress volume.

**Alternatives.** Labelling structural reasons on every record (simpler, but it makes ~every record
"have a reason"); a per-record probability for each anomaly (the counts then vary run to run, and so
does every metric); sharing the normalizer's date code with the generator (one bug would produce wrong
data and a matching wrong parser).

**Consequences.** Truth is more elaborate than a flat label per record, and the eval must read
`groups`, `anomalies` and `records` together. In return, a metric such as "exception classification
accuracy" or "false auto-accept rate" is defined by the file, not by interpretation.

---

## ADR-008: Synthetic settlements + bank statements; test-mode payments where available

**Status:** accepted

**Context.** Ziro reconciles ledger ↔ Razorpay ↔ bank. We need a real Razorpay integration to show,
but must stay on test keys only (CLAUDE.md §4.6). What test mode can supply is not spelled out
anywhere, so this is what the documentation does and does not say (read 2026-10-22):

- _Documented:_ "Both modes provide the same functionalities, except that real payments cannot be
  accepted in Test mode"; test and live entities are separate; "No real money is used in the test
  mode". So payments, orders and refunds listings work with test keys, but only return what was
  created with those keys: a fresh account is empty.
- _Silent:_ settlements and the recon report. Settlement is described only for live money (T+2, for
  captured payments). Nothing documents a test payment ever being settled, so expect an empty list
  (HTTP 200), not an error. **This is unverified**: `npm run razorpay:probe -w @ziro/api -- --confirm`
  is the read-only check, and its result should be recorded here.
- _The SDK_ (`razorpay` 2.9.8) hard-codes its host, has no timeout, and crashes with a `TypeError` on
  any failure that has no HTTP response (its error handler reads `err.response.status`), discarding
  headers such as `Retry-After`. It does not paginate or retry.

**Decision.**

- **One door.** `RazorpaySource` (`fetchPayments`, `fetchRefunds`, `fetchSettlements`,
  `fetchSettlementRecon`) returns `@ziro/core` domain records. `SyntheticSource` reads datagen output;
  `TestModeSource` uses the official SDK. Both pass raw JSON through the **same mappers**, so shapes
  are identical by construction, and a contract test serves the same data both ways and requires
  deep equality except for the `source` label.
- **Per-entity fallback, labelled.** Every record and every result carries `source`
  (`synthetic` | `razorpay_testmode`) and a provenance reason. Fallback happens **only when test mode
  answers with no data**, never on an error: bad credentials, an exhausted rate limit or a bug of ours
  must surface, not hide behind plausible synthetic numbers. Settlements fall back when test mode
  has none. **Refunds follow payments** (real refunds would point at payments not in the run). **Recon
  follows settlements, month by month** (a quiet day is a true empty only if test mode settles at all).
- **Mixed runs are honest but incoherent.** Synthetic settlements are composed of synthetic payments,
  so real test payments never appear in them and a mixed run will not reconcile. It is labelled
  `mixed` for the UI and is **never used for a published number**: the eval is all-synthetic.
- **Test mode only, three times.** The boot guard rejects `rzp_live_`; the env schema demands
  `rzp_test_` for `testmode`; `createSdkClient` refuses anything but `rzp_test_` where the key is
  first used.
- **Resilience.** One file (`sdk-client.ts`) touches the SDK's internals (`api.rq`, an untyped axios
  instance): it sets a timeout, turns network failures into the error shape the SDK expects, carries
  `Retry-After`, and adds retries (429, 408, 5xx and no-response; exponential backoff with full
  jitter, capped attempts and total deadline). The version is pinned exactly and a canary test fails if
  the internals change. `count`/`skip` pagination uses the documented maximums (100; 1000 for recon),
  a fixed window, de-duplication by id and a hard page cap.
- **Time.** Unix seconds become IST business dates in `@ziro/core/time`, implemented by walking years
  and months, deliberately unlike datagen's closed-form maths, and cross-checked against it and
  against `Intl`.
- **Receipts live on the Order.** Both adapters resolve each payment's order (one listing over a
  7-day lookback, single lookups beyond it) to fill `receipt`.
- **Identity.** Record ids are deterministic (run + type + source reference), so re-importing is
  idempotent; `importHash` is the sha-256 of the payload as received, extras included.

**Alternatives.** Falling back on any error (hides credential and rate-limit failures); synthesising
settlements and a bank statement _around_ the real test payments (coherent, but a separate
generator capability, a follow-up if wanted); dropping the SDK for plain axios (simpler, but not what
was asked for, and the seam makes its sharp edges safe).

**Consequences.** The fixtures behind the contract tests are transcribed from Razorpay's
documentation, not recorded from a live account; real recordings need a one-off session with test
keys. Failed and authorized payments are mapped with fee and tax 0 (nothing was charged), while a
_captured_ payment with a null fee is an error. Upgrading `razorpay` is a deliberate act guarded by
the canary test.

## ADR-009: Ingestion — strict parsing, immutable rows, one transaction per import

**Status:** accepted

**Context.** Three sources enter Ziro as untrusted files or API data, and every later claim (a match,
a metric) rests on the rows being exactly what was sent. Real exports are messy: one bad row, a
re-upload, a re-ordered export, a statement with a garbled reference. The importer must neither
crash on that nor quietly accept it.

**Decision.**

- **Pure transforms live in `@ziro/core/normalize`**: a strict RFC 4180 reader, header binding,
  dates (`DD-MM-YYYY`, `DD/MM/YYYY`, `YYYY-MM-DD`, ISO time _with_ an offset → IST date; never
  month-first, two-digit years or offset-less times), strict rupees (no symbols, Indian grouping
  only), reference cleaning, a free-text safety check, and UTR extraction. The API adds only the
  database, the HTTP shell and the audit trail.
- **A bad row never fails a file.** Every problem is collected as `{row, line, field, code, reason}`;
  valid rows are imported and the report says what was not. Only a file with no usable header (empty,
  not UTF-8, missing a required column) is refused whole, and even that returns the same report shape
  (HTTP 422) and is audited.
- **Identity and idempotency.** `(run_id, source_ref)` is the identity: the normalized `order_ref` for
  the ledger, `row-<n>` for the bank. Existing rows are **immutable**: same hash → `unchanged`,
  different hash → `conflict` (reported, not applied). A corrected file needs a new run. A repeated
  `order_ref` inside one file keeps the first and rejects the rest, because two ledger lines for one
  order is an ambiguity a human must resolve, not something to guess.
- **One transaction per import**, taking the run's row lock: the rows and the `audit_events` row
  commit or fail together, so the trail cannot disagree with the data. Network and file IO happen
  outside the transaction. `POST /runs/demo` is a single transaction too.
- **UTR quality is stored**, in a new `bank_lines.utr_quality` column (migration `0002`) with a CHECK
  that it is set exactly when `utr` is. The extractor repairs only look-alike confusions, only when
  one reading needs strictly fewer edits, and says it did; it returns nothing rather than choose
  between equal candidates.
- **The server, not the caller, picks the Razorpay source.** `POST /runs` has no source field (the
  schema is strict), and the demo preset is always synthetic, even when the server is in test mode.
- **Payment lines are linked through `entity_id`.** In Razorpay's recon report a payment line carries
  the payment's id in `entity_id` and leaves `payment_id` null (it is set only on refund lines).

**Alternatives.** Rejecting a file on its first bad row (hides the other 9,999 good ones, and a
finance team would just retry blindly); overwriting a row whose content changed (silently rewrites
what a past match was based on); keying bank lines by content hash plus occurrence (survives
re-ordering, but breaks the `row-<n>` keys of the ground truth for no real gain, as statements are
chronological); `csv-parse` instead of a hand-written reader (battle-tested, but cannot give the
row/line recovery model above without wrapping it); deriving UTR quality at match time (one less
column, but the audit trail could no longer say why a line matched at its tier).

**Consequences.**

- A re-upload with edits is a conflict, by design. The cost is that fixing a typo means a new run.
- Bank `row-<n>` keys mean a second, different statement in the same run conflicts row by row: one
  statement per run for now.
- `@types/multer` is a dev dependency (types for `Express.Multer.File`); multer itself ships inside
  `@nestjs/platform-express`. Uploads are held in memory, so `IMPORT_MAX_BYTES` (default 25 MiB) is
  also the memory bound.
- The endpoints take no authentication yet (the demo has no login). Before a public deploy they need a
  rate limit and a cap on runs, or anyone can fill the database.
- UTR layouts inside the 16/22-character references are documented only by third-party articles that
  disagree, and the shapes assumed beyond length (3–5 letters, then digits) are verified only against
  datagen and one real statement. Real narrations from the merchant's bank should extend the table of
  formats in `utr.test.ts`.
