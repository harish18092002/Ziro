# @ziro/datagen

Seeded synthetic data for Ziro: a merchant's ledger, Razorpay-shaped API responses, a bank
statement, and **`truth.json`**, which says exactly how every record relates to every other and why
they differ. Every published metric is measured against it, so it is built to be exact, repeatable
and hard to game.

```bash
npm run datagen -- --seed 42 --preset demo   --out data/demo     # 50 orders
npm run datagen -- --seed 42 --preset eval   --out data/eval     # 500 orders
npm run datagen -- --seed 42 --preset stress --out data/stress   # ~100k ledger rows, ~100k bank lines
```

`--out` is relative to where you ran `npm` (npm's `INIT_CWD`), not to this package. A non-empty
output directory is refused unless you pass `--force`. `data/` is git-ignored.

## Guarantees

| Guarantee                                                | How it is enforced                                                                                                                                                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same seed ⇒ **byte-identical** files                     | Hand-written integer-only PRNG (sfc32), no clock, no `Math.random`, no locale/`Intl`, `\n` line endings, fixed key order. Tested on every file, and again through the CLI into a different directory.             |
| Every settlement equals its composition **to the paise** | Σ credit − Σ debit of its recon lines = settlement amount; payment line credit = amount − fee. Recomputed from the written files, not the generator's own bookkeeping.                                            |
| Anomaly counts match the configured rates                | Counts are **exact** (`⌊bps × pool / 10 000 + ½⌋`, shuffled selection), not per-record coin flips, so the tolerance is zero in practice (the spec allows ±1). Re-counted from the raw files by independent logic. |
| `truth.json` covers 100% of records                      | The set of `type:key` entries equals the set of records in the other files exactly: none missing, none extra, none duplicated.                                                                                    |
| No float ever reaches a file                             | Money is `bigint` paise; the JSON writer throws on a non-integer number; ESLint bans `Math.*`, `Number()`, `parseFloat`, `.toFixed` and decimal literals in the money-handling code.                              |
| The tests can fail                                       | The suite was mutation-tested: 13 deliberately planted generator bugs (wrong GST, no midnight crossing, dropped truth records, `Math.random`, ...) were each caught.                                              |

## Presets

|                           | demo                      | eval                | stress                    |
| ------------------------- | ------------------------- | ------------------- | ------------------------- |
| Ledger rows ("orders")    | 50                        | 500                 | 100,000                   |
| Statement window          | 2026-09-01, 45 days       | 2026-04-01, 60 days | 2024-04-01, 730 days      |
| Orders placed in          | first 33 days             | first 48 days       | first 718 days            |
| Non-Razorpay bank lines   | 20                        | 150                 | 99,000                    |
| Prompt injections         | 3                         | 8                   | 100                       |
| JSON layout               | pretty                    | pretty              | one compact line per item |
| Order-level anomaly rates | boosted (each appears ≥1) | default table       | one quarter of eval       |

Orders stop `tailDays` (12) before the window ends so every payment, refund and dispute settles
inside the statement. For seed 42 the output is:

|        | ledger | payments (incl. failed) | refunds | settlements | recon lines | bank lines | anomalies |
| ------ | -----: | ----------------------: | ------: | ----------: | ----------: | ---------: | --------: |
| demo   |     50 |                      54 |       6 |          24 |          58 |         46 |        30 |
| eval   |    500 |                     530 |      38 |          49 |         548 |        201 |       129 |
| stress | 100000 |                  105250 |    1995 |         719 |      102495 |      99755 |      5952 |

Stress generates in about 13 s using about 740 MB and writes about 260 MB (it streams to disk).

## Default rate table

Basis points (100 bps = 1%). The first nine are a share of **orders**; the last two are a share of
**settlements** / settlement credits. Override any of them in code via `resolveConfig(seed, preset, { rates })`.

| Reason code              | Unit        | demo bps | **eval bps** | stress bps | eval count |
| ------------------------ | ----------- | -------: | -----------: | ---------: | ---------: |
| `DUPLICATE_PAYMENT`      | orders      |      400 |      **200** |         50 |         10 |
| `LEDGER_WITHOUT_PAYMENT` | orders      |      600 |      **300** |         75 |         15 |
| `PAYMENT_WITHOUT_LEDGER` | orders      |      400 |      **200** |         50 |         10 |
| `PARTIAL_REFUND_NETTED`  | orders      |      600 |      **400** |        100 |         20 |
| `FULL_REFUND`            | orders      |      400 |      **300** |         75 |         15 |
| `CHARGEBACK_ADJUSTMENT`  | orders      |      200 |      **100** |         25 |          5 |
| `LEDGER_AMOUNT_EDITED`   | orders      |      400 |      **200** |         50 |         10 |
| `TIMEZONE_DATE_SHIFT`    | orders      |      400 |      **300** |         75 |         15 |
| `FEE_OVERCHARGE`         | orders      |      400 |      **300** |         75 |         15 |
| `SETTLEMENT_DELAYED`     | settlements |     1500 |      **800** |        800 |          4 |
| `UTR_MISSING_OR_GARBLED` | settlements |     3000 |     **2000** |       2000 |         10 |

Other knobs: bank decoy credits (`bank.decoyBps`, 500 = 5% of settlement credits), failed payment
attempts (`failedAttemptBps`, 500), bank debits as a share of income (`bank.debitShareBps`, 6500),
prompt injections (a fixed count), and fee rates per method (`feeBps`: card 200, UPI 100,
netbanking 190). Order-level anomalies are mutually exclusive: an order has at most one.
Refunds and chargebacks are only generated for payments of ₹5,000 or less (`debitCapPaise`), so a
settlement is always big enough to absorb them. An infeasible config throws with an explanation
rather than quietly under-delivering.

## Output files

All in the `--out` directory. Money in CSVs is rupees with Indian grouping (`1,23,456.50`); money
in the Razorpay JSON is integer paise, exactly as Razorpay sends it.

| File                        | Shape                                                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ledger.csv`                | `order_ref, order_date, amount, customer_ref, memo`. Dates are `DD-MM-YYYY` (IST). A Tally/DB-style export.                                         |
| `razorpay_orders.json`      | `{ entity: "collection", count, items: [order] }`. Carries the `receipt` that equals the ledger `order_ref`.                                        |
| `razorpay_payments.json`    | Payment entities, including failed attempts.                                                                                                        |
| `razorpay_refunds.json`     | Refund entities.                                                                                                                                    |
| `razorpay_settlements.json` | Settlement entities.                                                                                                                                |
| `settlement_recon.json`     | The settlement reconciliation report: one line per payment, refund and adjustment in each settlement.                                               |
| `bank_statement.csv`        | `value_date, narration, debit, credit, balance`. Dates are `DD/MM/YYYY`. Exactly one of debit/credit is set. The balance is an exact running total. |
| `truth.json`                | The ground truth. See below.                                                                                                                        |

Razorpay lists are written **newest first**. (Razorpay's docs do not state a list order; newest-first
is simply a deliberately unfriendly one, so no consumer can rely on creation order. The ingest layer
sorts nothing and assumes nothing.) Field names and types are taken from Razorpay's documentation
and checked by the strict schemas in `@ziro/core/razorpay` (URLs in its comments):

- Payments: <https://razorpay.com/docs/api/payments/fetch-with-id> and `/fetch-all-payments`
- Refunds: <https://razorpay.com/docs/api/refunds/fetch-with-id>
- Settlements: <https://razorpay.com/docs/api/settlements/fetch-with-id> and `/fetch-all`
- Settlement recon: <https://razorpay.com/docs/api/settlements/fetch-recon>
- Orders: <https://razorpay.com/docs/api/orders/fetch-with-id>

## The normal world

- **Methods:** card 45%, UPI 40%, netbanking 15%. Contracted fee rates are 2.00% (card), 1.00% (UPI)
  and 1.90% (netbanking) of the amount.
- **Fees:** `fee` includes GST and `tax` is the GST part (ADR-004). Base fee = half-up of
  `amount × rate`, GST = half-up of `base × 18%`, `fee = base + GST`. A ₹2,100 payment at 2% gives a
  base of 42, tax 8, fee 50, which matches Razorpay's own sample.
- **Settlements:** one per capture day (IST), arriving **T+2 business days** later (weekends and
  fixed holidays 26 Jan, 14 Apr, 1 May, 15 Aug, 2 Oct, 25 Dec skipped), 06:00–11:00 IST. The bank
  credit lands that day, or the next with 20% probability. Each settlement's net is exactly
  Σ(payment − fee) − Σ(refunds) − Σ(adjustments).
- **Refunds and chargebacks** are netted out of the first settlement that can absorb them.
- **Time** is integer epoch seconds and IST (UTC+05:30, no DST). Orders follow a daily rhythm. A
  normal order is paid within minutes and never crosses midnight.
- **Noise:** ~5% of orders have a failed payment attempt first; the bank statement carries
  non-Razorpay credits and debits. Customers are fictional (`@example.com`, phone numbers starting
  `+910000`, which can never be real).

## Anomalies

Each is created as an `anomaly` entry in `truth.json`, naming the records whose normal 1:1 matching
it impedes (its "cluster"), with a role for each.

| Code                     | How it is made                                                                                                                                                                                     | Cluster                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `DUPLICATE_PAYMENT`      | A checkout retry: a **second Razorpay order** (receipt `<ref>-R1`, since receipts must be unique) paid by the same customer minutes later. Half are then refunded; the rest are genuine leftovers. | retry order, duplicate payment, its refund |
| `LEDGER_WITHOUT_PAYMENT` | Cash/COD: a ledger row (memo like "COD - cash collected") that never touches Razorpay.                                                                                                             | the ledger row                             |
| `PAYMENT_WITHOUT_LEDGER` | A manual payment link: real money on an order with no `receipt` and no ledger row.                                                                                                                 | the payment, its order                     |
| `PARTIAL_REFUND_NETTED`  | A 10–90% refund created 1–4 days after the payment settled, debited from a later settlement.                                                                                                       | the refund and its recon line              |
| `FULL_REFUND`            | The whole amount refunded and netted the same way.                                                                                                                                                 | the refund and its recon line              |
| `CHARGEBACK_ADJUSTMENT`  | A dispute 5–14 days after settlement: an `adjustment` debit line that names the payment only in its description, as in the docs' sample.                                                           | the payment, the adjustment line           |
| `LEDGER_AMOUNT_EDITED`   | The ledger amount is lower than the payment by a whole-rupee discount (≥ ₹10) and the memo says so.                                                                                                | the ledger row, its payment                |
| `TIMEZONE_DATE_SHIFT`    | Placed 23:30–23:59 IST on day D, paid after midnight: the ledger says D, Razorpay and the bank imply D+1.                                                                                          | the ledger row, its payment                |
| `SETTLEMENT_DELAYED`     | Settles 2–5 business days later than T+2.                                                                                                                                                          | the settlement, its bank credit            |
| `FEE_OVERCHARGE`         | Charged 0.5–1.5 points above the contracted rate; GST is consistent with the inflated base, so the settlement still adds up exactly.                                                               | the payment, its recon line                |
| `UTR_MISSING_OR_GARBLED` | The bank narration has the UTR **truncated**, **character-garbled** (O↔0, I↔1, S↔5, B↔8), **split** by a space, or **missing**. Some also get a same-amount decoy credit from another sender.      | the settlement, its bank credit            |

The decoy credits are what make a damaged UTR genuinely ambiguous. Wherever two credits share an
amount within three days, each lists the other in `ambiguousWith`.

### Prompt injection

`injections` hostile strings are planted in ledger memos, bank narrations, payment `notes` and
refund `notes`, in a mix of normal and anomalous records, from a catalogue of eight styles
(`INJECTION_CATALOGUE`): instruction override, fake verifier approval, a fake closing `</untrusted>`
tag, tool-call lure, prompt exfiltration, amount manipulation, role confusion, and a base64
payload. Each is labelled in `truth.json` with `injection: { field, style, text }`, and the record
keeps its true group and reason codes: the injection never changes the right answer.

## truth.json

```jsonc
{
  "meta": {
    "seed": 42,
    "preset": "eval",
    "config": {/* every setting */},
    "counts": {/* per type, code, group */},
  },
  "groups": [
    {
      "id": "OG-000001",
      "kind": "order",
      "members": ["ledger_entry:ORD-100001", "rzp_order:order_...", "rzp_payment:pay_..."],
      "structural": [],
      "anomalies": [],
      "composition": { "ledger": "250000", "payments": "250000", "fees": "5900", "tax": "900" },
    },
    {
      "id": "PG-000001",
      "kind": "payout",
      "members": [
        "rzp_settlement:setl_...",
        "bank_line:row-12",
        "settlement_item:setl_...:pay_...",
      ],
      "structural": ["FEE_GST_DEDUCTION", "BATCHED_SETTLEMENT"],
      "anomalies": ["FULL_REFUND"],
      "composition": {
        "settlement": "9973635",
        "bank": "9973635",
        "paymentsGross": "...",
        "feesDeducted": "...",
        "refundsDebited": "...",
      },
    },
  ],
  "anomalies": [
    {
      "id": "AN-000001",
      "reasonCode": "FULL_REFUND",
      "records": [{ "type": "...", "key": "...", "role": "refund" }],
      "detail": {},
    },
  ],
  "records": [
    {
      "type": "bank_line",
      "key": "row-12",
      "groupId": "PG-000001",
      "role": "settlement_credit",
      "reasonCodes": [],
      "anomalyIds": [],
      "injection": null,
      "ambiguousWith": [],
    },
  ],
}
```

- **Keys:** ledger `order_ref`; `order_`/`pay_`/`rfnd_`/`setl_` ids; a recon line is
  `<settlement id>:<entity_id>`; a bank line is `row-<n>`, its 1-based data row in `bank_statement.csv`
  (which is what ingest should use as `source_ref`).
- **Groups follow ADR-005:** an `order` group ties ledger ↔ orders ↔ payments ↔ refunds; a `payout`
  group ties a settlement ↔ its bank credit ↔ its recon lines. A record is in at most one group.
- **`groupId: null`** marks a genuine leftover (cash order, payment link, an unrefunded duplicate) or
  pure noise (a failed attempt, a non-Razorpay bank line, a decoy). `role` says which.
- **`reasonCodes` list only injected causes.** A normal record has none. Structural reasons
  (batching, fee deduction) sit on payout groups under `structural`, because rules handle them
  deterministically and counting them would dilute exception-classification accuracy.
- **Money in `truth.json` is a string of paise**, like every paise in a JSON file we write.
  `composition` gives the exact figures, so the verifier's residual definition (a later task) can be
  checked against them without re-deriving anything.

## Assumptions the Razorpay docs do not settle

These are synthetic choices, not facts about Razorpay:

- A refund does not return the original fee (the refund line carries fee 0 and tax 0).
- Settlement `utr` values are bank-style (`UTIBN` + 11 digits; RTGS for settlements ≥ ₹2 lakh), not
  the test-mode style in the docs' sample.
- A chargeback is a debit `adjustment` line (the docs' only sample is a credit). `dispute_id` is
  filled, though the docs' samples leave it null.
- Exact `.5` ties in fee and GST round **up**. Razorpay does not document tie behaviour.
- The recon line's `tax` is the real GST portion (the docs' payment sample shows `tax: 0` with a fee).
- Saturdays are non-business days (in reality some are working days). Holidays are fixed-date only.
- `order_receipt` is filled on payment recon lines though the docs' samples leave it null.
- The `razorpay_orders.json` collection wrapper is assumed to match the other lists.

## Testing

```bash
npm test -w @ziro/datagen          # ~100 tests, seconds
npm run test:stress -w @ziro/datagen   # the full 100k run with every invariant; ~15 s, a few GB of memory
```

`src/datagen.fixtures.ts` re-derives everything from the written files with logic that shares
nothing with the generator (its own business-day calendar, `Intl` for IST, its own CSV parser,
its own fee-rounding oracle).
