# Prompt blocks for the provider-agnostic LLM layer

> `docs/ZIRO_PROMPTS.md` is not in this repository, so these blocks could not be edited in place. Each one is
> the **replacement text** for the named prompt, written in the same imperative style, to be merged into the
> prompt list you keep outside the repo. Everything below describes what was built (ADR-018), so a prompt
> re-run from these blocks reproduces the current system. Where a block says "the author", it means you: the
> numbers and ids are yours to supply and are never invented in code.

## P1 (scaffold): the environment list

Replace the model-related variables with this set. **None is required to boot.** With no usable model the agent
is off; the rules, the review console and the replay still work.

| Variable               | Default                | Meaning                                                                                                            |
| ---------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `GEMINI_API_KEY`       | unset                  | Google AI Studio key. Free-tier prompts may be used by Google: synthetic data only.                                |
| `GEMINI_TIER`          | `free`                 | `free` or `paid`. On `free` the actual cost is $0; on `paid` every Gemini model needs a price.                     |
| `ANTHROPIC_API_KEY`    | unset                  | Optional. A key with no credit just leaves Claude out of the chain.                                                |
| `LLM_CHAIN`            | empty (agent off)      | `provider:model,provider:model,...` in the order tried. **Model ids live only here and in `.env.example`.**        |
| `GEMINI_LIMITS`        | empty                  | JSON `{"<model>": {"rpm": N, "rpd": N}}`, copied by the author from aistudio.google.com/rate-limit. Never guessed. |
| `LLM_PRICES`           | empty                  | JSON `{"<provider>:<model>": {"input": "<usd>", "output": "<usd>"}}` per million tokens, from the price pages.     |
| `LLM_CACHE`            | `off`                  | `off`, `record` or `replay` (replay answers from the record only and fails on a miss).                             |
| `LLM_CACHE_FILE`       | `data/llm-cache.jsonl` | Where the evals keep the record (each eval run uses a fresh in-memory database).                                   |
| `AGENT_HARNESS`        | `single-shot`          | `single-shot` or `loop`. (`agent-sdk` is gone.)                                                                    |
| `LLM_MAX_TOOL_CALLS`   | `4`                    | Tool calls one investigation may make in the `loop` harness (was 8).                                               |
| `LLM_MAX_WAIT_SECONDS` | `30`                   | Longest a rate limit is waited out before the next model is tried.                                                 |
| `AGENT_ESCALATION`     | `false`                | A second look from the NEXT model in the chain when the first is unsure. Not fallback.                             |

Remove `AGENT_MODEL_SMALL` and `AGENT_MODEL_LARGE`. The zod config validates all of the above, never prints a
value in an error, and boots with only the Postgres and Redis URLs.

## P7 (the agent): provider-agnostic

Build the LLM layer so that **nothing outside `apps/api/src/llm` names a vendor.**

1. `@ziro/core/llm` holds only neutral types: `LlmMessage`, `LlmToolDef` (name, description, a zod schema),
   `LlmToolCall`, `LlmResult` (text, tool calls, usage, finish reason) and `LlmError` with the kinds
   `RATE_LIMITED` (with `retryAfterMs`), `QUOTA_EXHAUSTED`, `BILLING`, `AUTH`, `TIMEOUT`, `SERVER`,
   `BAD_REQUEST`, `SAFETY_BLOCKED`, `MALFORMED`.
2. A port, `LlmProvider.complete`, that makes **exactly one attempt**: no waiting, no retrying, SDK retries off.
   Adapters: Gemini (`@google/genai`, Interactions API, stateless `store:false`, thought signatures echoed back
   untouched), Anthropic (`@anthropic-ai/sdk`) and a scripted fake for tests. Each maps every SDK error to one
   `LlmError` kind. Tools are written once as zod and converted per provider.
3. Two harnesses over the same tools, verifier, `<untrusted>` tagging and injection tests: `single-shot` (the
   harness gathers a fixed bundle of read-only lookups and makes ONE structured call; the default) and `loop`
   (the model drives the tools, at most `LLM_MAX_TOOL_CALLS`).
4. A router that runs an investigation on the first model of `LLM_CHAIN` that will take it and **never mixes
   models inside one investigation** (a failure mid-way restarts it on the next model with a fresh history).
   Fall back on `QUOTA_EXHAUSTED`, `BILLING`, `AUTH`, `TIMEOUT`, `SERVER`, and `RATE_LIMITED` past the maximum
   wait; do not fall back on `BAD_REQUEST`, `MALFORMED` (one repair) or `SAFETY_BLOCKED`. Record the provider and
   model of every final proposal.
5. Drop a chain entry with a warning (never fail the boot) when it has no key, or costs money and has no price.

## P11 (evals): the configurations

Replace "Harness B: the Claude Agent SDK" and the small/large models with:

- Configurations: `rules`, `lite-loop`, `lite-single`, `flash-single` (use a small `--sample`), and `claude-loop`,
  `claude-single` **only when named and a funded key exists.** "Lite", "flash" and "claude" are the first Gemini,
  second Gemini and first Anthropic entries of `LLM_CHAIN`. Each runs a router of one model: no fallback.
- Flags: `--sample N` (the first N investigations; labelled as a sample), `--max-requests N` (free-tier ceiling),
  `--max-cost-usd N` (money ceiling, Claude), `--cache off|record|replay`, and **`--repeats` defaults to 1**.
  A run that sends requests does nothing without `--confirm` and a ceiling; `--cache replay` needs neither.
- New metrics beside match rate, false matches and reason-code accuracy: requests (and per 1,000 orders), tokens,
  fallback count, the share of a free-tier day used, and the estimated cost at paid prices (from `LLM_PRICES`).
  Thinking tokens are priced as output.
- A replayed run is labelled REPLAYED in the result file, `EVALS.md` and the README: its accuracy is real, its
  cost, requests and latency are not a measurement.

## P12 (failures): the quota-exhausted and fallback paths

Add to the failure handling, each with a test:

- A model out of quota, out of money, with a bad key, timing out or erroring is **replaced by the next model**;
  the proposal says which models failed and which answered; the failed attempt is a `llm_calls` row marked
  `fell_back`.
- When **every model is spent**, the exception goes to a person as NEEDS_HUMAN with the reason **"AI quota
  exhausted"** (`degraded = quota_exhausted`), the run carries on, the rules keep running, and the next exception
  is answered at once with no request and no wait. A banner on every page names each model's state and when the
  first returns (Pacific midnight for the daily quota).
- `BILLING` and `AUTH` switch a provider off for the process; a Gemini model's daily quota skips it until the
  Pacific date changes; five timeouts or server errors in a row cool a model down, then one probe.
- A replay that finds no recorded answer **fails loudly**.

## P13 (demo and deploy)

- The demo **leads with the free replay.** A live run is offered only while a model is working and the free tier
  has the requests for it left today (about 20 for a 50-order run); otherwise the page says why.
- The chaos toggle injects three failures through the real router: every model timing out, every model out of
  quota, and a cut-off reply.
- Deploy: `--with-key` passes the Gemini key, `--with-claude` the Anthropic key; `deploy/demo.env` carries the
  `LLM_CHAIN`, and the author adds `GEMINI_LIMITS` there after copying it from AI Studio.
- Say, in the README limitations and the ADR, that **free-tier prompts may be used by Google**: synthetic data only.
