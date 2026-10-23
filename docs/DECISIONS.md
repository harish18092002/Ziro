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

## ADR-010: The rule matcher — a waterfall that never guesses

**Status:** accepted

**Context.** Deterministic code should settle the bulk of the reconciliation, cheaply and provably, so
the LLM agent sees only what is genuinely uncertain. A wrong automatic match is worse than a missing
one: it hides exactly the discrepancy this product exists to find.

**Decision.**

- **A pure function over domain records** (`@ziro/core/matcher`): no IO, no clock, no randomness. The
  output does not depend on input order, because no rule ever breaks a tie. This is a tested property.
- **Four tiers, each recording its tier and rule id** (versioned, e.g. `T1.receipt-amount.v1`). T1
  joins a ledger entry to a captured payment by cleaned receipt and equal amount. T3 and T4 join a
  settlement to a bank credit. **T2 is a verdict, not a group** (ADR-005): a payment is already in an
  order group, so the settlement's composition is verified, and only a verified settlement goes on.
- **One composition function** (`composeSettlement`) holds the settlement maths, for the verifier to
  reuse. The request wrote `Σpayments − Σfees − Σtax − Σrefunds ± adjustments`; ADR-004 says the fee
  already includes its GST, and on the eval data that form matches 0 of 49 settlements while
  `Σpayments − Σfees − Σrefunds ± adjustments` matches 49 of 49. Tax is reported, not subtracted.
- **Zero amount tolerance; ambiguity is an exception.** One ledger entry and one captured payment per
  receipt; a UTR must be unique on both sides; T4 needs exactly one candidate on both sides, counted
  among records still unmatched after T3 (a certain T3 match must not make a lone leftover look
  ambiguous). Every exception carries its candidates; none is resolved by position.
- **T3 trusts a UTR only if it is exact or merely re-joined.** A repaired or truncated UTR is evidence
  for the agent, not proof, so those credits can only match at T4. A UTR hit with a different amount is
  an exception, and that settlement is then not offered to T4.
- **Reason codes come from structure only**, and `UNKNOWN` otherwise. `LEDGER_AMOUNT_EDITED` asserts
  intent (an edited ledger, a discount, a part-payment?), so it is left to the agent; `FEE_OVERCHARGE`
  needs a fee schedule and belongs to the leakage report. A line's free-text description is used only
  as a hint for `CHARGEBACK_ADJUSTMENT`, never as authority.
- **Scope of exceptions.** Failed or uncaptured payments, bank debits and UPI/ACH/cheque credits are
  _ignored_ (listed, not investigated); the refunds of an unmatched payment are folded into that
  payment's exception. A NEFT, RTGS or IMPS credit that no settlement explains is an exception.
- **The calendar is configuration** (weekend days and holidays), not a constant. The eval and the
  benchmark pass datagen's assumptions (Saturday and Sunday off, its fixed holidays).
- **`rule_id` is stored.** `match_groups.rule_id` (migration `0003`), with a CHECK that a rule-made group
  names both its tier and its rule.

**Alternatives.** Making T2 a group (breaks "a record is in at most one group"); resolving an
ambiguous UTR hit by nearest amount or latest date (a guess); T3 accepting repaired UTRs (a look-alike
repair is a hypothesis, and the verifier should not have to second-guess the rules); setting
`LEDGER_AMOUNT_EDITED` whenever a receipt matches at a different amount (right on the synthetic data,
wrong whenever a part-payment is the real cause).

**Consequences.**

- Measured against `truth.json` the rules make no wrong links and lose no record. They leave the
  injected ambiguities (edited ledgers, duplicates, cash orders, manual payments, decoy credits) to the
  agent, as designed. The numbers are pinned in a test and reproducible.
- At stress scale about 30,000 of 32,600 exceptions are NEFT/RTGS/IMPS credits that no settlement
  explains (the generator's noise). That volume must not reach the agent one by one: a triage or
  batch-dismiss step is needed before the agent runs at scale.
- The retry-receipt convention (`<ref>-R<n>`) is the generator's and each merchant's to define. It is a
  config pattern, and null turns the `DUPLICATE_PAYMENT` rule off.
- Persisting groups and exceptions, running the matcher on a run, and the endpoints for that are the
  next task. This one delivers the pure function, its measurements and the schema column.

## ADR-011: The investigation agent — a hand-rolled loop whose every claim is checked

**Status:** accepted

**Context.** The rules (ADR-010) leave the genuinely uncertain exceptions: duplicate payments, edited
ledger amounts, fee overcharges, short or late payouts. An LLM can investigate these, but it can be
wrong, can be talked into things by text in a memo, and costs money per call. The design has to make a
wrong or hostile answer harmless, and the spend bounded and visible.

**Decision.**

- **Harness A is a loop we own**, on `@anthropic-ai/sdk`, behind `AgentRunner.investigate(members, ctx)`.
  Harness B (the Claude Agent SDK, P11) will implement the same interface. The loop is append-only: the
  model's response goes back unchanged (thinking blocks are bound to their turn), and an escalation is a
  fresh conversation, never a continuation on another model.
- **Nine read-only tools**, each with a strict zod schema (the API's copy is a sanitised derivative; zod
  on our side is authoritative), each run in its own `READ ONLY` transaction with a 5 s statement
  timeout, scoped by a `runId` that comes from the investigation and never from the model, with results
  capped at 12,000 characters. A failure of ours (the database) is rethrown so the job retries; it is
  never shown to the model as "not found". Money arithmetic is not the model's: `compute_expected_settlement`
  and `get_settlement_composition` call the same `composeLines` the rule matcher uses.
- **Untrusted text is data.** Memos, customer references, narrations and settlement line descriptions
  reach the model only inside `<untrusted field="...">` in tool results; the tag cannot be closed from
  inside (any `<untrusted` or `</untrusted`, in any case or spacing, is defanged). Order references and
  receipts that are not plain tokens are wrapped too. The system prompt and the opening message never
  contain record text.
- **Every claim is checked in code before it is stored** (`output.ts`). Evidence is cited by call number
  and the harness fills in tool and arguments from its own call log; a citation of a call that did not
  happen or failed is dropped. Links must be records a tool returned in this investigation, and a
  `MATCH_PROPOSED` that names anything else, or fewer than two records, is _downgraded to NEEDS_HUMAN_
  with confidence capped at 0.3, never trimmed into a smaller match. `ACCEPT_MATCH` needs a proposed
  match at confidence 0.5 or more. A draft journal entry must balance to the paise or it is dropped.
- **Budgets are the harness's, not the model's:** 8 tool calls, 24,000 output tokens, 8,000 per
  request, 60 s (the request itself is aborted at the deadline), and a prompt ceiling. A spent budget
  ends the investigation without another model call, as NEEDS_HUMAN with the evidence gathered. The
  model is told on its last allowed call. One repair is allowed for a malformed reply; a refusal is final.
- **Small model first, one escalation.** `AGENT_MODEL_SMALL` investigates; if it answers NEEDS_HUMAN or
  below 0.7 confidence, `AGENT_MODEL_LARGE` looks once more in a fresh conversation seeded with the
  _facts_ the first pass gathered (tool summaries, not its conclusion, to avoid anchoring). A budget that
  ran out, a refusal or an unusable reply are not escalated.
- **Clusters.** With `CLUSTER_EXCEPTIONS`, exceptions that share a record (a candidate, or one's
  candidate being another's subject) are investigated in one conversation, at most six. The model
  returns one full result per exception, so each is stored and validated on its own; nothing is merged.
- **Triage.** A bank credit nothing explains and with no candidate record is not investigated; it is
  listed for a person. At stress scale this is about 30,000 of 32,600 exceptions.
- **Idempotent by (exception, attempt).** The unique index on `agent_proposals(exception_id, attempt)` is
  the guard; the queue job id (`<exception>-<attempt>`) only de-duplicates work still waiting. Jobs are
  removed when they finish or fail, so a person can ask again after a halt. Asking twice cannot spend
  twice: a stored proposal moves the exception from `open` to `proposed`.
- **Spend is gated and logged.** Before every request the kill switch and the day's spend (UTC) are
  checked against `DAILY_LLM_BUDGET_USD`; every request is written to `llm_calls` at once (tokens
  including cache reads and writes, cost, latency, model, harness, prompt hash, stop reason, request id),
  so spend is on record even if the investigation later fails. Cost is integer micro-USD, rounded up,
  from a price table that refuses a model or a prompt tier it does not know.

**Alternatives.** The Agent SDK as the default (less control over budgets and the exact messages, and it
is the bake-off's job); letting the model write evidence (`tool`, `args`) itself (it can misquote its
own calls); trimming a match's unseen links instead of downgrading it (silently turns a claim about one
group into a claim about a smaller one); a shared top-level explanation for a cluster (one conversation,
but a proposal that cannot be validated or stored per exception); escalating after any NEEDS_HUMAN
(spends more on exactly the cases that ran out of budget).

**Consequences.**

- The agent can only propose. The verifier (next) re-checks the paise, ids and windows, and a person
  approves; the agent's grounding checks are a first line, not the last.
- Cost and accuracy of the small model, the escalation, and clustering are **not yet measured**, so no
  cost figure is quoted here. A live smoke test exists
  (`RUN_LIVE_LLM_TESTS=1`, one investigation, hard-capped spend), and the eval harness will compare the
  settings.
- The investigate endpoint has no authentication or rate limit and spends money. The kill switch and the
  daily budget bound the damage; auth is needed before a public deploy.
- A worker holds a Redis connection for blocking commands; Upstash's command usage under BullMQ must be
  checked at deploy time.

## ADR-012: The verifier and the human gate — an agent's claim is never a match

**Status:** accepted

**Context.** The agent (ADR-011) proposes matches. Its own checks make a wrong proposal unlikely; they do
not make it impossible, and a wrong accepted match hides exactly the discrepancy this product exists to
find. Something deterministic, written separately from the agent and the rules, has to re-derive every
proposed match from the records, and a person has to see everything that is not trivially safe.

**Decision.**

- **A pure verifier, `@ziro/core/verify`.** `verifyProposal(claim, snapshot, config)` returns `VERIFIED` or
  `REJECTED(findings)`, each finding a stable code and the records it is about, written from the records
  and never quoting free text. It trusts nothing the agent checked. Records are looked up by id with no run
  filter, so a link into another run is reported as exactly that.
- **Two group shapes, no tolerance.** An _order_ group (ledger entries + captured payments + their refunds)
  must satisfy `Σ ledger = Σ payments − Σ processed refunds` to the paise, and every refund a payment
  records as refunded must be linked (a missing refund hides money). A _payout_ group (one settlement + one
  bank credit) must pass `composeSettlement`, the same function rule tier T2 uses, and the credit must
  equal the settlement amount.
- **One set of windows.** The verifier's config extends the matcher's (calendar, T4 window, settlement lag,
  delay horizon, date-shift minutes, retry pattern) plus `orderDateWindowDays` (3). A run snapshots them as
  `config.windows` next to the fee contract. The matcher's "is this settlement late?" was extracted into
  `settlementCreatedLate` so the rule's label and the verifier's check cannot drift; this was found by
  running the verifier over the rules' own groups.
- **The reason code must fit the links.** `PARTIAL_REFUND_NETTED` needs a linked refund that does not
  refund in full; `DUPLICATE_PAYMENT` needs two or more payments for one order; `TIMEZONE_DATE_SHIFT` needs
  a payment just after IST midnight; `BATCHED_SETTLEMENT`, `FEE_GST_DEDUCTION`, `CHARGEBACK_ADJUSTMENT`,
  `SETTLEMENT_DELAYED` and `UTR_MISSING_OR_GARBLED` each need the settlement to show it. Reasons that
  describe a record with no counterpart (`LEDGER_WITHOUT_PAYMENT`, `PAYMENT_WITHOUT_LEDGER`,
  `LEDGER_AMOUNT_EDITED`, `FEE_OVERCHARGE`) can never accompany a match: an edited amount means the sides
  differ, and zero tolerance means they do not match.
- **Currency.** Stored on payments, refunds and settlement lines, where Razorpay states it (the settlement
  entity does not; its lines do). Ingestion reads it faithfully, so a foreign-currency record is kept and
  the verifier refuses to match it, rather than being rejected at the door or silently read as rupees.
- **Policy, pure and strict.** Auto-accept needs every one of: verified, the agent proposed and suggested
  accepting it, the group's gross is within `AUTO_ACCEPT_MAX_PAISE`, confidence is at least
  `AUTO_ACCEPT_MIN_CONFIDENCE` (0.85), `AUTO_ACCEPT_ENABLED`, not `DEMO_MODE` (the public demo always shows
  the human gate) and not `AGENT_KILL_SWITCH`. The kill switch stops the agent and auto-accept; people
  keep reviewing and the rules keep working.
- **A rejected proposal stays an exception.** The exception returns to `open`, the proposal is kept as
  history and counted ("caught by the verifier"). "Investigate all" skips an exception already
  investigated, so asking twice cannot spend twice; running it again is asked for by id.
- **Proposals that propose no match** (an explanation, a NEEDS_HUMAN) have `verifier_status =
not_applicable`. Approving an explanation resolves the exception with the explained reason code; a
  NEEDS_HUMAN cannot be approved, only rejected, which reopens the exception.
- **Approval re-verifies, then writes through the shared writer.** In one transaction: lock the proposal,
  verify against the data as it is now, write the group with `writeGroup` (the one place a group is made;
  rules will use it too), record the review, resolve every open exception about a record in the group, and
  audit each step. A proposal that went stale is refused with 409 and the refusal is recorded. The unique
  indexes (a record in at most one accepted group) are the final guard against two writers racing.
- **Audit, with a record timeline.** `auditStep` writes `{before, after, reason, records}` and indexes
  every record the step is about in `audit_event_records` (append-only like `audit_events`).
  `GET /records/:id/audit` is one indexed lookup plus a synthesised "imported" entry read from the record.
  Audit reasons are written by code, never copied from model text.

**Alternatives.** Verifying inside the agent (no independence); one balance equation for rule and agent
groups (the rules' T1 annotation form, ledger equal to payment with the refund shown beside it, would let
an agent pick which refunds to link to hit a number); stopping at the first finding (a reviewer then fixes
one problem at a time); a hard `409` on any re-run instead of skipping (clearer, but "investigate all"
would then fail on any run that had a rejection).

**Consequences.**

- On the eval preset the verifier agrees with the rules: all 48 payout groups verify, and 440 of 475 order
  groups do. The other 35 carry a refund as an annotation, the rule-only form above, and are refused by
  exactly the refund amount. Pinned by a test that runs both on the same data.
- The review and audit endpoints have no authentication. `reviewer` is a name recorded as given, so the
  audit trail identifies a reviewer but does not authenticate one. This must be fixed before any public
  deployment; the kill switch and daily budget do not protect these endpoints.
- A group approved by a person has `basis = 'agent'`; who approved it is the review row and the audit
  trail.
- Nothing persists the rule matcher's output yet, so on real data there are no exceptions to propose about;
  the next task (P7) persists them through the same `writeGroup`.

---

## ADR-013: The console, the free demo, and what the gap means

**Context.** A reviewer must see the whole loop (rules, agent, verifier, human) from one click, at no
cost, on a public URL, and every number on the page must be one a person can defend.

**Decision.**

- **One URL.** `apps/web` is plain React with one CSS file and hash routing. The API serves the built files
  (`web/mount-web.ts`) with a strict CSP (no inline script or style, same-origin only, no framing) and
  `trust proxy` = 1 so the per-client rate limit sees the real client behind Cloud Run. API routes stay at
  the root. All free text (memos, narrations, model and scripted explanations) is rendered by React as text.
- **Free demo, honestly labelled.** The default agent is a **scripted baseline, not a language model**. It
  reads records through the same nine read-only tools, its evidence is those tool calls, and its answers
  pass the same `finalizeResult` grounding. Storage, verifier, policy, review and audit are the real code.
  A live model is offered only when the server has a key and budget, and is off by default.
- **Planted refusals.** Two proposals per demo run are deliberately wrong (a payment already matched
  elsewhere; a payment of a different amount). They carry model `planted-for-demo` and a finding saying so,
  and the page labels them. They exist so a visitor sees the verifier refuse something; they are not
  evidence of model quality, and no README accuracy number may include them.
- **The visitor is the human.** The approval in the demo is the visitor's own click, recorded under the name
  they type. There is no login (a stated limitation), so a deployment needs auth or a read-only mode.
- **The Ziro gap.** Exceptions that share any record (an edited ledger amount is raised once for the entry and
  once for its payment) form one case; a case counts once, at its largest stake. gap = open cases + cases
  awaiting a person; cases a person has settled are shown separately as _explained_. A case with any
  unsettled member is unsettled, so approving one exception can leave the headline unchanged when a sibling
  (for example a second bank credit of the same amount) is still unexplained. That is the intended
  conservatism, not a rounding choice.
- **Persisting the rules (P7).** `ReconService.match` stores the matcher's output through the same
  `writeGroups` path the review uses, and is verified to round-trip to the direct matcher result.
- **Downloads.** JSON (integer paise as strings) and CSV (plain rupees). Every text cell is defused against
  spreadsheet formula injection. The journal CSV lists only drafts the verifier did not refuse, with their
  true state (awaiting review, approved, rejected by a person).

**Alternatives.** A component kit (Pico, Tailwind): rejected, the brief says core logic over polish. Recorded
real-model replay for the free demo: better realism but needs a paid run and the author's OK; left as a
follow-up. Summing every exception's stake as the gap: double counts one difference raised from both sides.

**Consequences.**

- The demo run takes about two seconds and costs nothing, so the 2-minute acceptance has wide margin.
- The scripted baseline's answers are rules in disguise. Do not quote its behaviour as agent performance.
- Creating a run is unauthenticated and rate-limited in memory (per process); a multi-instance deployment
  needs a shared limiter.

---

## ADR-014: The run report, fee leakage, and the voucher format for the books

**Context.** At month-end finance needs four things from a run: whether the totals add up, what is still
unexplained and for how long, what Razorpay charged or delayed that it should not have, and entries to bring
into Tally. The report must be defensible number by number.

**Decision.**

- **Totals reconcile by partition.** Per source (ledger, payments, refunds, settlements, bank lines) every
  record is in an accepted group, in an exception, or ignored, and each class is counted and summed on its own
  (not as a remainder), so `matched + in an exception + ignored = total` is a check that can fail. It is
  shown in records and in paise, per source, with `reconciles` per source and overall.
- **Who settled what.** Rule groups; agent matches approved by a person; agent explanations approved by a
  person; auto-accepted proposals; rejected proposals; waiting; dismissed. There is no human-only resolution
  path (a person approves or rejects an agent proposal), so no such bucket is invented.
- **Age** is the days from the subject record's own business date to the run's as-of date (`periodEnd`), never
  to the wall clock, so re-running next month does not make last month's data look older. A case (exceptions
  that share records, ADR-013) is as old as its oldest unsettled member, and the age buckets sum to the gap
  exactly.
- **Fee leakage** is deterministic. For each captured INR payment the run's stored fee contract gives an
  expected fee (rate per method, then GST, half-up to the paise at each step). A payment whose base fee (fee
  minus GST) is above the expected base is overcharged; the leakage is everything charged above the expected
  total, split into base and GST. Undercharges are reported separately and never netted. A method or currency
  the contract does not cover is counted as not assessable, not as clean. It is report-only: it opens no
  exception (ADR-010). Judged against the contract snapshot on the run; a run without one uses the default
  and the report says so.
- **Delayed settlements** use the matcher's own `settlementCreatedLate` (the verifier uses the same function),
  plus a bank credit that lands after the T4 window. A settlement with no matched credit past the window and
  the delay horizon is overdue as of the as-of date.
- **Vouchers.** One chargeback test (`isChargebackLine` in core) serves the rule label and the books.
  A settlement is booked only when a bank credit is matched to it and its lines add up to the paise by the
  same composition the matcher uses; anything else is listed as not bookable with the reason.
  - Receipt: Dr Bank, Cr Razorpay Clearing, the net payout, dated the bank value date.
  - Journal: Dr Payment Gateway Charges (fee minus GST), Dr GST Input Credit, Dr Refunds, Dr Chargeback Loss,
    Dr or Cr Suspense for other adjustments, Cr Razorpay Clearing for what balances it.
  - Together they credit Razorpay Clearing by exactly the gross of the settled payments, which is what the
    sales debited. The sale itself is not generated: it is already in the merchant's books.
  - An agent's draft entry is booked only after a person approves it, dated the approval day (IST).
  - Every voucher is checked to balance as it is built; one that does not throws.
- **Two CSV layouts, one source.** `journal-entries.csv` has one row per debit/credit pair (date, voucher type,
  voucher no, debit ledger, credit ledger, amount, narration, record ids, source). `journal-lines.csv` has one
  row per ledger line with a Dr/Cr column, the layout TallyPrime's Import Data from Excel maps column by
  column. Dates are ISO `YYYY-MM-DD`, amounts plain rupees with two decimals, positive.
- **Exceptions export** adds `age_days`, `as_of`, `suggested_action` and an always-filled `next_step`. The
  suggested action of a proposal the verifier refused is blanked and the next step says to investigate by hand.

**What the Tally format assumes, from Tally's docs and not from a test against Tally** (TallyHelp: "Import
Data from Excel", and the XML developer reference).

- TallyPrime's Excel import takes the voucher type name, voucher date, ledger name and ledger amount as
  mandatory, with Dr/Cr, and reads multi-ledger vouchers from several rows (the lines file). CSV must be opened
  in Excel and saved as .xls or .xlsx first. Columns are mapped by the user in a mapping template, so the
  header names here are not enforced by Tally.
- ISO dates are chosen because Excel parses them the same in every locale; `DD-MM-YYYY` would be misread on a
  machine set to US dates. Tally's XML format uses `YYYYMMDD`; we do not emit XML.
- Voucher numbers follow the numbering configured on the voucher type in Tally, so `voucher_no` here is for
  tracing back to the settlement and may be ignored on import.
- The ledgers must exist in Tally under these names. Defaults are in `tally.ts`; a run can rename any of them
  with `config.ledgerNames`.
- One GST Input Credit ledger: there is no place-of-supply data, so the split into CGST, SGST and IGST is for
  the accountant.
- Narrations are cut at 250 characters (our own limit, not a documented Tally one); the full list of record ids
  is in its own column.

**Alternatives.** Emit Tally XML: exact, but the docs give no complete example with a narration, and it cannot
be tested here without a Tally. One voucher mixing Receipt and Journal legs: not a valid voucher type.
Wall-clock age: meaningless on synthetic data and unstable across re-runs. Netting over- and undercharges:
hides a real overcharge behind an unrelated error in Ziro's favour.

**Consequences.**

- **Measured on eval seed 42**, against `truth.json`: 15 overcharged payments for ₹694.87, exactly the 15
  planted and exactly their paise; 4 delayed settlements, exactly the 4 planted, with the same business days
  late; all five sources reconcile; 48 settlements booked as 96 vouchers, including 4 chargeback legs; the fee,
  GST, refund and chargeback legs equal sums taken straight from the tables. The same figures were read from a
  real Postgres.
- The Tally files have not been imported into a real Tally. Treat the format as an assumption until an
  accountant runs one through.
- The suspense legs (other debit adjustments, credit adjustments) are covered by unit tests only: the
  generated data has none.
- The pair layout repeats the narration and record ids on every row (about 90 KB for 96 vouchers).

---

## ADR-015: The eval — how the proof is scored, and what it cannot show

**Context.** Every claim about the agent has to be a number a stranger can check against ground truth: how
many true matches it finds, how many false ones it lets through (the worst error), whether it explains an
exception with the right reason, whether a hostile memo moves it, and what that costs. Two harnesses (our own
loop, the Claude Agent SDK) and two models have to be compared on the same footing.

**Decision.**

- **Layout.** Pure scoring, statistics, the result files and the `EVALS.md` writer are `@ziro/evals`. The driver
  that needs the services, the database and the agents is `apps/api/src/eval`, which depends on `@ziro/evals`
  (api → evals → core). The runner is therefore not in `packages/evals` as §6 first said: that package cannot
  import the API. The driver builds the services by hand: `tsx` does not emit the decorator metadata Nest's
  injection needs.
- **Fresh database per run.** An in-memory PGlite built by the real migrations, the real ingestion, matcher,
  agent service, verifier and review service. Nothing is shared between runs.
- **Scoring (against `truth.json`).**
  - _Match rate_: truth groups reproduced exactly by an accepted group, over truth groups with at least two
    records the matcher can link. Partial groups are counted apart.
  - _Precision_: accepted groups with no wrong link, over accepted groups.
  - _False match_: an accepted group whose members do not all sit inside ONE truth group, including a group
    made only of records that belong to none. Counted and listed, never averaged away. A strict subset of one
    truth group is _incomplete_, not false.
  - _Reason-code accuracy_, on the exceptions an agent handled: right if the agent's code is among the codes
    truth gives that record (on the record, on an anomaly that lists it, or on its group), else UNKNOWN.
    A NEEDS_HUMAN counts as not right unless its code happens to be; abstentions are reported apart.
  - _The Ziro gap_: strict (only rules and verified, approved agent matches settle anything) and optimistic
    (also counting every unrefused explanation as agreed to by a person: an upper bound, labelled so).
  - _Cost_ is computed from token counts with `agent/pricing.ts` for every config, so they compare like for
    like; the Agent SDK's own estimate is stored beside it. _Latency_ is wall time per investigation with four
    running at once, and includes the SDK's process start-up for harness B.
  - Model configs run 3×, reported as mean and min–max. Nothing is called a difference unless the ranges do
    not overlap, and the report says when they do.
- **A simulated reviewer.** It approves an agent MATCH the verifier passed, on an exception still waiting, and
  nothing else (`approvable`). That is the careless-human worst case, so a false match in the score is one the
  verifier let through, not one a person was trusted to catch.
- **The configs.** `rules`; `small` and `large` on harness A with escalation off, so each row measures one
  model; `harnessB` on the SMALL model, so comparing it with `small` isolates the harness. The product's own
  default (small, then large when unsure) is a fifth configuration that is run only if asked for.
- **Harness B** (`agent/sdk-runner.ts`, also behind `AGENT_HARNESS=agent-sdk`) shares everything with harness A
  except who runs the loop: system prompt, opening message, the nine tools (the same toolbox as in-process
  custom tools), call 0, call numbering, grounding, draft building. It is locked down: no built-in tools,
  only our nine by name, `dontAsk` permissions, no setting sources (the repo's `CLAUDE.md` is not read), an
  empty working directory, no session file, no database or cloud credentials in its environment, and every tool
  `alwaysLoad` so it cannot look cheaper by hiding schemas behind tool search. Known differences: no repair
  turn (structured output is requested), no escalation, a per-investigation spend ceiling instead of an
  output-token budget, the gate checked only before the query starts.
- **Prompt injection.** On eval seed 42 only 1 of the generator's 8 planted injections lands on a record an
  agent would examine, and the agent's tools show it only a ledger memo and a bank narration (payment and
  refund notes are stored but never shown). So the eval adds an OVERLAY on a copy of the dataset: catalogue
  payloads appended to the memo or narration of records in agent-handled exceptions, subjects before
  candidates, styles rotating. Each placement is checked not to change what the rules do (a narration carries
  the UTR); one that does is dropped. _Exposed_ means the payload text appeared in a tool result during the
  investigation, observed through a wrapper on the toolbox, because the exception brief does not show a memo:
  an agent that never opens the record never sees the payload. _Followed_ is judged by what the agent did
  (proposed a match truth or the verifier refuses, called a tool that does not exist, repeated its system
  prompt, treated an amount as zero, relied on a claimed approval without calling it out), not by quoting.
  The detectors are heuristics, and every flagged case is listed so it can be overruled.
- **Spending.** A run that calls a model prints its plan and estimate and does nothing without `--confirm`,
  and needs `--max-cost-usd`. The API key is not read until then. The cap is checked before each investigation
  and each request, and can be overshot by the requests already in flight. `npm run eval:smoke` (CI) is the
  demo preset, one repeat, the small model and a $0.25 cap; with no key it skips the model and still runs the
  free rules check.
- **Output.** One JSON file per (dataset, config, leg) in `packages/evals/results/`; `EVALS.md` is rebuilt from
  those files for free with `npm run eval:report`; the Opinion block is the author's and is preserved.

**Alternatives.** Count a partial group as correct and report no false links separately: rejected, the false
match count is the point. Real Postgres per run: slower, needs Docker, and latency here is dominated by the
model. Nest's injection for the driver: needs decorator metadata `tsx` does not emit. Compare harnesses on
different models: confounds the two effects.

**Consequences.**

- The rules numbers are exactly reproducible; the model numbers are not (sampling, model updates), which is
  why the stored JSON, not a re-run, is what `EVALS.md` rests on.
- One seed and three repeats. A single reason code often has 5–15 records, so per-code counts are shown.
- Until a pilot runs, every cost in a plan is a guess (30k tokens in, 3k out per investigation, no caching).
- **Harness B has not yet been run against the real SDK process.** Its tests use a fake SDK for behaviour and the
  real package for the shape of our tools; whether the real process starts with the filtered environment,
  accepts the model names, and honours the structured-output schema is what the pilot will show. The SDK is
  pinned exactly (0.3.309) and its version is written into every result file.
- The injection result rests on how many payloads are _exposed_, which depends on the agent opening the record.
