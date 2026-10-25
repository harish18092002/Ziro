# Priorities

What was built, in what order, what was cut, and why. The Razorpay AI Builders bar asks for fresh work, core
logic over surface polish, visible prioritization, and a live demo. Every row below is a choice between two
things that could not both be done well.

**The rule used to decide:** build first whatever makes a number _more correct_ or a claim _more checkable_.
Cut whatever only makes the product look finished. A reconciliation tool that is wrong by a rupee, or cannot
show how it knows, is worth nothing; a plain interface is not.

## The order things were built in

1. **Money as integer paise.** Every other module adds money up, so a float anywhere would make "accounted for
   to the paise" meaningless. Floats are banned by the linter inside the money code, and rounding is explicit.
2. **Synthetic data with an answer key.** Real merchant data is off limits, and a match rate means nothing
   without knowing the right answer. The key was built before the thing it grades.
3. **The Razorpay source layer and strict ingestion.** Real inputs are messy (garbled UTRs, day-first dates,
   half-written rows). Parsing reports what it could not read instead of guessing.
4. **The rule matcher.** Code settles what it can prove, for free, in milliseconds, and refuses to guess when
   two candidates fit. It leaves the agent only the hard cases.
5. **The agent.** Read-only tools, a budget, and a rule that anything it claims must be backed by something a
   tool actually returned.
6. **The verifier, the review queue and the audit trail.** The agent's output is a claim; code re-derives it
   and a person approves it. Nothing the agent says becomes a match without both.
7. **The console and the free demo.** A reviewer should see the whole loop from one click, at no cost.
8. **The run report.** The unexplained amount, fee leakage and delayed settlements: the reasons a finance team
   would want this at all.
9. **The evals.** Scoring against the answer key, with the number of false matches stated outright.
10. **Failure handling, then deployment.** A demo that falls over on one slow API response proves nothing, and
    a public URL needs limits before it needs anything else.

## MoSCoW

**Must have: without these the product is wrong or cannot be believed.**

| Item                                               | Status | Why                                                                                         |
| -------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------- |
| Money as integer paise, half-up rounding           | built  | One float error makes every total suspect.                                                  |
| Rule matcher that never guesses                    | built  | Cheap and provable; ambiguity becomes an exception, not a coin flip.                        |
| Verifier that can refuse the agent                 | built  | The model must never write a match; code re-checks the paise, the ids and the date windows. |
| Append-only audit log                              | built  | Finance has to see who or what changed anything; a trigger and a database role enforce it.  |
| Synthetic data with ground truth                   | built  | The only honest way to measure a match rate without real customer data.                     |
| Eval against the answer key, false matches counted | built  | A wrong match books money against the wrong thing; a match rate alone would hide it.        |
| Razorpay test mode only                            | built  | Boot fails on a live key; the public demo deploys no Razorpay keys at all.                  |

**Should have: the product is much weaker without them.**

| Item                                                      | Status | Why                                                                                      |
| --------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------- |
| Strict ingestion with row-level errors, UTR repair        | built  | Garbled references are the everyday failure; each repair records its quality.            |
| Agent with read-only, run-scoped tools and budgets        | built  | Keeps it useful and bounded; free text from records is wrapped as untrusted.             |
| Human review that re-verifies on approve                  | built  | A proposal can go stale; approval checks the data as it is now.                          |
| Run report: the gap, fee leakage, delays                  | built  | Shows value beyond matching, and every figure traces to rows.                            |
| Live demo, one-click run, free replay of 500 orders       | built  | The application's bar; the replay needs no API key.                                      |
| Failure handling: retries, pause, partial runs            | built  | Outages are normal; the run must say what was lost and carry on.                         |
| Deployment scripts, limits, least-privilege database role | built  | A public URL with no login needs spend caps and a role that cannot edit the audit trail. |

**Could have: useful, built small or not proven.**

| Item                                                    | Status              | Why                                                                                                        |
| ------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------- |
| Tally voucher export (CSV)                              | built, not verified | Accountants need entries; the format follows Tally's documentation but has never been imported.            |
| Single-shot harness and the tool loop                   | built, never run    | Two ways to spend a free-tier request budget; the eval compares them on the same model, once a key exists. |
| Model chain: Gemini free tier, Claude optional          | built, never called | A spent daily quota falls back to the next model instead of ending the demo; no live call has been made.   |
| Record/replay of model answers                          | built, tested       | An eval or a demo can be re-run for free from recorded answers, and says that it was.                      |
| Second look by the next model, clustering of exceptions | built, not measured | May cut cost or raise accuracy; no model has been run, so no claim is made.                                |
| Prompt-injection test overlay in the eval               | built, heuristic    | Measures whether planted instructions move the agent; the verdict is a heuristic and cases are listed.     |
| Chaos switch in the demo                                | built               | Lets a visitor watch a model timeout and a bad reply being handled.                                        |

**Won't have: cut on purpose.**

| Item                                            | Why                                                                                           |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Accounts, tenants, single sign-on               | This is a core-logic exercise with a public demo; the reviewer's name is typed text.          |
| Live Razorpay settlements and bank feeds        | Test mode appears to have no settlements; one bank statement layout is all that was verified. |
| Other currencies                                | The verifier refuses anything but INR.                                                        |
| CGST, SGST and IGST split                       | It needs place-of-supply data the inputs do not carry; fees and GST are one ledger.           |
| Auto-accepting agent matches in the public demo | The limits exist and are tested, but a demo should show a person deciding.                    |
| Posting into Tally or a bank                    | Export only. Writing to a books system is a separate, riskier product.                        |
| Fine-tuning, embeddings, retrieval              | Rules plus tools already explain the cases here; there is no real data to train on.           |
| Month-end close workflow, scheduling, alerts    | Out of scope for showing that the matching and checking are right.                            |
| Interface polish, charts, mobile layout         | Core logic over polish: the console is plain on purpose.                                      |

## What this ordering cost

- The language model has not yet been measured. The agent and its checks were built and tested before a
  paid run was approved, so the evals show the rules' numbers and leave the model columns empty rather than
  filling them with estimates.
- Settlements and bank lines are synthetic, so the matcher's accuracy on a real merchant's files is unknown.
- The deployment has been rehearsed locally against the same database and Redis, not on real cloud accounts.
