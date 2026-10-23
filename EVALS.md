# EVALS

> Written by `npm run eval:report` from the JSON in `packages/evals/results/`. Do not edit by hand, except inside the Opinion block at the end. Re-running the model configs costs money (`npm run eval`); rebuilding this file does not.

**Dataset:** eval, seed 42: 500 orders, 534 truth groups, 104 exceptions of which 58 go to an agent and 46 are unexplained bank credits listed for a person.
**Models:** small `claude-haiku-5-5`, large `claude-sonnet-5-5`. **Agent SDK:** not used. **Node:** v24.21.0.

## Results

| config | runs | match rate | precision | **false matches** | reason-code accuracy | rejected by verifier | Ziro gap (strict) | cost / 1k orders | latency p50 / p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **rules** | 3 | 97.4% | 100.0% | 0 | – | – | ₹2,04,190.89 | – | – |
| **small** | not run |  |  |  |  |  |  |  |  |
| **large** | not run |  |  |  |  |  |  |  |  |
| **harnessB** | not run |  |  |  |  |  |  |  |  |

Match rate: truth groups reproduced exactly by an accepted group. Precision: accepted groups with no wrong link. **False matches**: accepted groups that link records truth says do not belong together; the worst error, because it books money against the wrong thing. The Ziro gap is what is left unexplained when only the rules and verified, approved agent matches settle anything. Model rows show mean (min–max) over the repeats.

### False matches

- **rules**: **0** false matches in 3 run(s), over 523 accepted groups each. Agent-made: 0.

### Tokens, calls and cost

_No agent runs yet._

### Reason-code accuracy

_No agent runs yet._

### Proposals rejected by the verifier

_No agent runs yet._

### Prompt injection

_No attacked-leg runs yet._

### Clustering related exceptions: off vs on

_Not run yet._

### Rules throughput (stress preset)

4,10,214 input rows, 3 timed run(s): **2,76,082 rows/s (2,71,284 rows/s–2,83,529 rows/s)**, 1486 ms (1447 ms–1512 ms) per pass. The rules produced 99,457 groups and 32,600 exceptions. Pure CPU, no database and no model; the time excludes loading the files.

## What the numbers show

- False matches (all runs summed): rules 0.
- Match rate: rules 97.4%.

### Limits of this evidence

- One dataset (one seed) and, for the model configs, three repeats: ranges are shown, not confidence intervals, and no difference is claimed unless the ranges do not overlap.
- The data is synthetic. A model that does well here has not been shown to do well on a real merchant’s records.
- Accepted groups include every verified agent match, as if a reviewer approved all of them. A careful human would reject some, so false matches here are an upper bound on what a person would let through.
- Reason-code accuracy is scored against the codes datagen planted; several reasons have only a handful of records, so read the per-code counts, not just the percentage.
- Injection “followed” is decided by heuristics on what the agent did; every flagged case is listed so it can be overruled. “Exposed” means the payload appeared in a tool result during the investigation.
- Costs are computed from token counts with the rates in `agent/pricing.ts` for every config, so they compare like for like; the Agent SDK’s own estimate is shown beside it.
- Latency is wall time per investigation with four investigations running at once, and includes the Agent SDK’s process start for harness B.

## Opinion

<!-- OPINION:START -->
_Not written yet. This block is yours: the report keeps whatever is between the markers._
<!-- OPINION:END -->
