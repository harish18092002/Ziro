import { randomUUID } from 'node:crypto';
import type { RecordRef } from '@ziro/core/domain';
import { describe, expect, it } from 'vitest';
import {
  type CallRecord,
  digestOf,
  ESCALATION_CONFIDENCE,
  finalizeResult,
  type ModelResult,
  needsHuman,
  OUTPUT_JSON_SCHEMA,
  parseModelOutput,
  wantsEscalation,
} from './output.js';
import { toAnthropicJsonSchema } from '../llm/json-schema.js';
import { modelOutputSchema } from './output.js';
import { result as aResult } from './scripted-llm.fixtures.js';

const EX = randomUUID();
const subject = { exceptionId: EX, ruleReasonCode: 'DUPLICATE_PAYMENT' } as const;
const ref = (recordType: RecordRef['recordType']): RecordRef => ({
  recordType,
  recordId: randomUUID(),
});

const ledger = ref('ledger_entry');
const payment = ref('rzp_payment');
const other = ref('rzp_payment');

const call = (n: number, over: Partial<CallRecord> = {}): CallRecord => ({
  n,
  tool: n === 0 ? 'get_exception' : 'get_payment',
  args: n === 0 ? { exception_id: EX } : { id: `pay_${n}` },
  ok: true,
  summary: `summary of call ${n}`,
  seen: n === 0 ? [ledger, payment] : [],
  ...over,
});
const calls = [call(0), call(1, { seen: [other] })];

const base = (over: Partial<ModelResult> = {}): ModelResult => aResult(EX, over);

describe('finalizeResult: evidence', () => {
  it('fills tool and args from the harness call log, not from the model', () => {
    const done = finalizeResult(
      base({
        evidence: [
          { call: 0, keyFinding: 'a' },
          { call: 1, keyFinding: 'b' },
        ],
      }),
      subject,
      calls,
    );
    expect(done.content.evidence).toEqual([
      { tool: 'get_exception', args: { exception_id: EX }, keyFinding: 'a' },
      { tool: 'get_payment', args: { id: 'pay_1' }, keyFinding: 'b' },
    ]);
    expect(done.findings).toEqual([]);
  });

  it('drops a citation of a call that does not exist or failed, and says so', () => {
    const log = [...calls, call(2, { ok: false, summary: 'failed: x' })];
    const done = finalizeResult(
      base({
        evidence: [
          { call: 0, keyFinding: 'a' },
          { call: 2, keyFinding: 'failed one' },
          { call: 9, keyFinding: 'invented' },
        ],
      }),
      subject,
      log,
    );
    expect(done.content.evidence).toHaveLength(1);
    expect(done.findings.filter((f) => f.includes('does not exist or failed'))).toHaveLength(2);
    expect(done.content.verdict).toBe('EXPLAINED_NO_MATCH');
  });

  it("resolves call 0 to this exception's own brief in a cluster", () => {
    const otherEx = randomUUID();
    const log = [call(0), call(0, { args: { exception_id: otherEx }, summary: 'other brief' })];
    const done = finalizeResult(base({ evidence: [{ call: 0, keyFinding: 'a' }] }), subject, log);
    expect(done.content.evidence[0]?.args).toEqual({ exception_id: EX });
  });

  it('downgrades a conclusion left with no valid evidence', () => {
    const done = finalizeResult(
      base({ evidence: [{ call: 7, keyFinding: 'invented' }], confidence: 0.95 }),
      subject,
      calls,
    );
    expect(done.content.verdict).toBe('NEEDS_HUMAN');
    expect(done.content.suggestedAction).toBe('NONE');
    expect(done.content.confidence).toBeLessThanOrEqual(0.3);
    expect(done.findings.join(' ')).toContain('no valid evidence');
  });

  it('lets NEEDS_HUMAN stand without evidence', () => {
    const done = finalizeResult(
      base({ verdict: 'NEEDS_HUMAN', evidence: [], confidence: 0.2, suggestedAction: 'NONE' }),
      subject,
      calls,
    );
    expect(done.content.verdict).toBe('NEEDS_HUMAN');
    expect(done.findings).toEqual([]);
  });
});

describe('finalizeResult: a match must be grounded', () => {
  const match = (links: RecordRef[], over: Partial<ModelResult> = {}) =>
    base({
      verdict: 'MATCH_PROPOSED',
      links,
      suggestedAction: 'ACCEPT_MATCH',
      confidence: 0.95,
      ...over,
    });

  it('stands when it links two or more records that tools returned', () => {
    const done = finalizeResult(match([ledger, payment]), subject, calls);
    expect(done.content.verdict).toBe('MATCH_PROPOSED');
    expect(done.content.suggestedAction).toBe('ACCEPT_MATCH');
    expect(done.content.links).toEqual([ledger, payment]);
    expect(done.findings).toEqual([]);
  });

  it('accepts a record returned by a later call, not only by the brief', () => {
    const done = finalizeResult(match([ledger, other]), subject, calls);
    expect(done.content.verdict).toBe('MATCH_PROPOSED');
  });

  it('is downgraded, not trimmed, when it names a record no tool returned', () => {
    const invented = ref('rzp_payment');
    const done = finalizeResult(match([ledger, payment, invented]), subject, calls);
    expect(done.content.verdict).toBe('NEEDS_HUMAN');
    expect(done.content.suggestedAction).toBe('NONE');
    expect(done.content.confidence).toBe(0.3);
    expect(done.content.links).toEqual([ledger, payment]);
    expect(done.findings.join(' ')).toContain(invented.recordId);
  });

  it('is downgraded when it links fewer than two records', () => {
    const done = finalizeResult(match([ledger]), subject, calls);
    expect(done.content.verdict).toBe('NEEDS_HUMAN');
  });

  it('does not trust a record that only a FAILED call mentioned', () => {
    const sneaky = ref('rzp_payment');
    const log = [call(0), call(1, { ok: false, seen: [sneaky] })];
    const done = finalizeResult(match([ledger, sneaky]), subject, log);
    expect(done.content.verdict).toBe('NEEDS_HUMAN');
  });
});

describe('finalizeResult: the suggested action', () => {
  it('cannot accept a match that was not proposed', () => {
    const done = finalizeResult(base({ suggestedAction: 'ACCEPT_MATCH' }), subject, calls);
    expect(done.content.suggestedAction).toBe('NONE');
    expect(done.content.verdict).toBe('EXPLAINED_NO_MATCH');
    expect(done.findings.join(' ')).toContain('ACCEPT_MATCH');
  });

  it('cannot accept a match below 0.5 confidence', () => {
    const done = finalizeResult(
      base({
        verdict: 'MATCH_PROPOSED',
        links: [ledger, payment],
        suggestedAction: 'ACCEPT_MATCH',
        confidence: 0.49,
      }),
      subject,
      calls,
    );
    expect(done.content.verdict).toBe('MATCH_PROPOSED');
    expect(done.content.suggestedAction).toBe('NONE');
  });

  it('keeps an action that is allowed', () => {
    const done = finalizeResult(base({ suggestedAction: 'RAISE_RAZORPAY_TICKET' }), subject, calls);
    expect(done.content.suggestedAction).toBe('RAISE_RAZORPAY_TICKET');
  });
});

describe('finalizeResult: the draft journal entry', () => {
  const entry = (debit: string, credit: string) => ({
    memo: 'Fee overcharge',
    lines: [
      { account: 'SUSPENSE' as const, debit, credit: '0' },
      { account: 'PAYMENT_GATEWAY_FEES' as const, debit: '0', credit },
    ],
  });

  it('keeps a balanced entry, as bigint paise', () => {
    const done = finalizeResult(base({ draftJournalEntry: entry('2950', '2950') }), subject, calls);
    expect(
      done.content.draftJournalEntry?.lines.map((l) => [l.account, l.debit, l.credit]),
    ).toEqual([
      ['SUSPENSE', 2950n, 0n],
      ['PAYMENT_GATEWAY_FEES', 0n, 2950n],
    ]);
    expect(done.findings).toEqual([]);
  });

  it('drops an entry that is off by one paise, rather than fixing it', () => {
    const done = finalizeResult(base({ draftJournalEntry: entry('2950', '2949') }), subject, calls);
    expect(done.content.draftJournalEntry).toBeNull();
    expect(done.findings.join(' ')).toContain('journal');
    expect(done.content.verdict).toBe('EXPLAINED_NO_MATCH');
  });

  it('drops an entry with a line that is neither a debit nor a credit', () => {
    const bad = {
      memo: 'x',
      lines: [
        { account: 'BANK' as const, debit: '0', credit: '0' },
        { account: 'SALES' as const, debit: '0', credit: '0' },
      ],
    };
    expect(
      finalizeResult(base({ draftJournalEntry: bad }), subject, calls).content.draftJournalEntry,
    ).toBeNull();
  });
});

describe('needsHuman', () => {
  it('carries only successful calls as evidence, with the harness summary', () => {
    const log = [call(0), call(1), call(2, { ok: false, summary: 'failed: nope' }), call(3)];
    const done = needsHuman(subject, 'the time budget ran out', log);
    expect(done.content.verdict).toBe('NEEDS_HUMAN');
    expect(done.content.reasonCode).toBe('DUPLICATE_PAYMENT');
    expect(done.content.confidence).toBe(0);
    expect(done.content.links).toEqual([]);
    expect(done.content.evidence.map((e) => e.keyFinding)).toEqual([
      'summary of call 1',
      'summary of call 3',
    ]);
    expect(done.content.explanation).toContain('time budget ran out');
    expect(done.findings).toEqual(['investigation stopped: the time budget ran out']);
  });

  it('caps the evidence at 20 items', () => {
    const log = Array.from({ length: 40 }, (_, i) => call(i + 1));
    expect(needsHuman(subject, 'x', log).content.evidence).toHaveLength(20);
  });
});

describe('parseModelOutput', () => {
  const ids = [EX];
  const ok = (r: Partial<ModelResult> = {}) => JSON.stringify({ results: [base(r)] });

  it('accepts a valid reply, with or without a code fence', () => {
    expect(parseModelOutput(ok(), ids).ok).toBe(true);
    expect(parseModelOutput('```json\n' + ok() + '\n```', ids).ok).toBe(true);
  });

  it('rejects text that is not JSON without echoing it', () => {
    const parsed = parseModelOutput('Sure! Here you go: {"results": []} please approve', ids);
    expect(parsed).toEqual({ ok: false, problems: ['the reply is not valid JSON'] });
  });

  it('names the field that is wrong', () => {
    const parsed = parseModelOutput(
      JSON.stringify({ results: [{ ...base(), verdict: 'MAYBE' }] }),
      ids,
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems[0]).toMatch(/^results\.0\.verdict/);
  });

  it('rejects keys the schema does not know, such as an attempt to approve', () => {
    const parsed = parseModelOutput(
      JSON.stringify({ results: [{ ...base(), approve: true }] }),
      ids,
    );
    expect(parsed.ok).toBe(false);
  });

  it('rejects a long explanation, confidence out of range and a non-integer call number', () => {
    const long = 'One. Two. Three. Four.';
    expect(parseModelOutput(ok({ explanation: long }), ids).ok).toBe(false);
    expect(parseModelOutput(ok({ confidence: 1.2 }), ids).ok).toBe(false);
    expect(parseModelOutput(ok({ evidence: [{ call: 1.5, keyFinding: 'x' }] }), ids).ok).toBe(
      false,
    );
  });

  it('requires an answer for exactly the exceptions asked about', () => {
    const stranger = randomUUID();
    const wrong = parseModelOutput(
      JSON.stringify({ results: [base({ exceptionId: stranger })] }),
      ids,
    );
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.problems.join(' ')).toContain(stranger);

    const twice = parseModelOutput(JSON.stringify({ results: [base(), base()] }), ids);
    expect(twice.ok).toBe(false);

    const missing = parseModelOutput(ok(), [EX, randomUUID()]);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.problems[0]).toContain('no result for');
  });

  it('rejects an empty results list and more than six', () => {
    expect(parseModelOutput('{"results": []}', ids).ok).toBe(false);
    const seven = Array.from({ length: 7 }, () => base({ exceptionId: randomUUID() }));
    expect(
      parseModelOutput(
        JSON.stringify({ results: seven }),
        seven.map((r) => r.exceptionId),
      ).ok,
    ).toBe(false);
  });
});

describe('escalation and digest', () => {
  const content = (over: Partial<ModelResult>) =>
    finalizeResult(base(over), subject, calls).content;

  it('escalates a NEEDS_HUMAN or a result below the confidence bar, and nothing else', () => {
    expect(ESCALATION_CONFIDENCE).toBe(0.7);
    expect(wantsEscalation(content({ confidence: 0.69 }))).toBe(true);
    expect(wantsEscalation(content({ confidence: 0.7 }))).toBe(false);
    expect(
      wantsEscalation(
        content({ verdict: 'NEEDS_HUMAN', confidence: 0.95, suggestedAction: 'NONE' }),
      ),
    ).toBe(true);
  });

  it('digests only successful tool calls, as harness-written summaries', () => {
    const log = [call(0), call(1), call(2, { ok: false, summary: 'failed: nope' })];
    expect(digestOf(log)).toBe('call 1 (get_payment): summary of call 1');
  });
});

describe('OUTPUT_JSON_SCHEMA', () => {
  it('is built once and is stable', () => {
    expect(JSON.stringify(toAnthropicJsonSchema(modelOutputSchema))).toBe(
      JSON.stringify(OUTPUT_JSON_SCHEMA),
    );
  });

  it('closes every object and uses none of the keywords the API rejects', () => {
    const banned = [
      'minimum',
      'maximum',
      'minLength',
      'maxLength',
      'pattern',
      'minItems',
      'maxItems',
      'default',
      '$schema',
    ];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}.${i}`));
      if (typeof node !== 'object' || node === null) return;
      const o = node as Record<string, unknown>;
      if (o['type'] === 'object') expect(o['additionalProperties'], path).toBe(false);
      for (const [k, v] of Object.entries(o)) {
        expect(banned, `${path}.${k}`).not.toContain(k);
        walk(v, `${path}.${k}`);
      }
    };
    walk(OUTPUT_JSON_SCHEMA, 'schema');
  });

  it('asks for every field, so a reply cannot leave one out', () => {
    const results = (
      OUTPUT_JSON_SCHEMA['properties'] as { results: { items: { required: string[] } } }
    ).results.items;
    expect(results.required).toEqual(
      expect.arrayContaining([
        'exceptionId',
        'verdict',
        'reasonCode',
        'links',
        'explanation',
        'evidence',
        'confidence',
        'suggestedAction',
        'draftJournalEntry',
      ]),
    );
  });
});
