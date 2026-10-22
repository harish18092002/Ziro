import type { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  agentProposalContentSchema,
  agentProposalSchema,
  draftJournalEntrySchema,
  explanationSchema,
  reviewSchema,
} from './index.js';
import {
  agentProposalContentFixture,
  agentProposalFixture,
  reviewFixture,
  uuid,
} from './domain.fixtures.js';

function failures(schema: z.ZodType, input: unknown): string[] {
  const result = schema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((i) =>
    i.code === 'unrecognized_keys' ? '(unknown key)' : i.path.join('.'),
  );
}

const content = agentProposalContentFixture;

describe('AgentProposal content', () => {
  it('parses a well-formed proposed match', () => {
    const proposal = agentProposalContentSchema.parse(content());
    expect(proposal).toMatchObject({
      verdict: 'MATCH_PROPOSED',
      suggestedAction: 'ACCEPT_MATCH',
      confidence: 0.9,
    });
    expect(proposal.links).toHaveLength(2);
  });

  it('rejects extra keys instead of ignoring them (no smuggled approvals)', () => {
    for (const extra of [
      { approve: true },
      { status: 'accepted' },
      { verifierStatus: 'passed' },
      { claimedResidual: '0' },
    ]) {
      expect(failures(agentProposalContentSchema, { ...content(), ...extra })).toEqual([
        '(unknown key)',
      ]);
    }
  });

  it('caps text and list sizes', () => {
    const base = content();
    expect(failures(agentProposalContentSchema, { ...base, explanation: 'x'.repeat(601) })).toEqual(
      ['explanation'],
    );
    expect(failures(agentProposalContentSchema, { ...base, explanation: '' })).toEqual([
      'explanation',
    ]);
    const links = Array.from({ length: 51 }, (_, i) => ({
      recordType: 'rzp_payment',
      recordId: uuid(200 + i),
    }));
    expect(failures(agentProposalContentSchema, { ...base, links })).toEqual(['links']);
    const evidence = Array.from({ length: 21 }, () => base.evidence[0]);
    expect(failures(agentProposalContentSchema, { ...base, evidence })).toEqual(['evidence']);
    expect(
      failures(agentProposalContentSchema, {
        ...base,
        evidence: [{ ...base.evidence[0], keyFinding: 'k'.repeat(301) }],
      }),
    ).toEqual(['evidence.0.keyFinding']);
  });

  it('only accepts known verdicts, reason codes, actions and tools', () => {
    const base = content();
    expect(failures(agentProposalContentSchema, { ...base, verdict: 'MATCHED' })).toEqual([
      'verdict',
    ]);
    expect(failures(agentProposalContentSchema, { ...base, reasonCode: 'I_THINK_FEES' })).toEqual([
      'reasonCode',
    ]);
    expect(failures(agentProposalContentSchema, { ...base, suggestedAction: 'PAY_OUT' })).toEqual([
      'suggestedAction',
    ]);
    expect(
      failures(agentProposalContentSchema, {
        ...base,
        evidence: [{ ...base.evidence[0], tool: 'run_sql' }],
      }),
    ).toEqual(['evidence.0.tool']);
  });

  it('keeps confidence between 0 and 1', () => {
    for (const confidence of [-0.1, 1.01, Number.NaN, '0.9']) {
      // More than one rule can object to a bad confidence; what matters is that the field is flagged.
      expect(
        failures(agentProposalContentSchema, { ...content(), confidence }),
        String(confidence),
      ).toContain('confidence');
    }
  });
});

describe('AgentProposal: a proposal that contradicts itself cannot be represented', () => {
  it('a proposed match must name the records it links', () => {
    expect(failures(agentProposalContentSchema, { ...content(), links: [] })).toEqual(['links']);
  });

  it('a conclusion needs evidence, but "needs a human" may have none', () => {
    const base = content();
    expect(failures(agentProposalContentSchema, { ...base, evidence: [] })).toEqual(['evidence']);
    expect(
      failures(agentProposalContentSchema, {
        ...base,
        verdict: 'NEEDS_HUMAN',
        links: [],
        evidence: [],
        suggestedAction: 'NONE',
        confidence: 0,
      }),
    ).toEqual([]);
  });

  it('only a proposed match can be accepted, and not at low confidence', () => {
    const base = content();
    expect(
      failures(agentProposalContentSchema, {
        ...base,
        verdict: 'EXPLAINED_NO_MATCH',
        suggestedAction: 'ACCEPT_MATCH',
      }),
    ).toEqual(['suggestedAction']);
    expect(failures(agentProposalContentSchema, { ...base, confidence: 0.49 })).toEqual([
      'confidence',
    ]);
    expect(failures(agentProposalContentSchema, { ...base, confidence: 0.5 })).toEqual([]);
  });
});

describe('explanation: at most three sentences', () => {
  it.each([
    ['one sentence', 'Payment pay_A is a duplicate of pay_B.', true],
    ['three sentences', 'It is a duplicate. The first payment settled. Refund the second.', true],
    ['four sentences', 'One. Two. Three. Four.', false],
    [
      'an amount is not a sentence end',
      'The fee is 1,234.50 rupees and the ledger says 99.99.',
      true,
    ],
    ['an id is not a sentence end', 'Compare pay_AbC.1 with rfnd_2 and setl_3 today.', true],
    ['question and exclamation marks end sentences', 'Why? Because! It is late? Yes.', false],
  ])('%s', (_name, text, ok) => {
    expect(explanationSchema.safeParse(text).success).toBe(ok);
  });
});

describe('draft journal entry', () => {
  const entry = () => ({
    memo: 'Duplicate payment refunded to customer',
    lines: [
      { account: 'REFUNDS', debit: '250000', credit: '0' },
      { account: 'RAZORPAY_CLEARING', debit: '0', credit: '250000' },
    ],
  });

  it('parses a balanced entry, with paise as integer strings', () => {
    const parsed = draftJournalEntrySchema.parse(entry());
    expect(parsed.lines[0]).toMatchObject({ debit: 250_000n, credit: 0n });
  });

  it('refuses one that does not balance by even a paisa', () => {
    const lines = entry().lines.map((l, i) => (i === 1 ? { ...l, credit: '249999' } : l));
    expect(failures(draftJournalEntrySchema, { ...entry(), lines })).toEqual(['lines']);
  });

  it('refuses a line with both sides or neither, an unknown account, and a float amount', () => {
    const base = entry();
    const both = { ...base, lines: [{ account: 'BANK', debit: '5', credit: '5' }, base.lines[1]] };
    expect(failures(draftJournalEntrySchema, both)).toContain('lines.0');
    const neither = {
      ...base,
      lines: [{ account: 'BANK', debit: '0', credit: '0' }, base.lines[1]],
    };
    expect(failures(draftJournalEntrySchema, neither)).toContain('lines.0');
    const odd = {
      ...base,
      lines: [{ account: 'MY_POCKET', debit: '250000', credit: '0' }, base.lines[1]],
    };
    expect(failures(draftJournalEntrySchema, odd)).toContain('lines.0.account');
    const float = {
      ...base,
      lines: [{ account: 'BANK', debit: 2500.5, credit: 0 }, base.lines[1]],
    };
    expect(failures(draftJournalEntrySchema, float)).toContain('lines.0.debit');
  });

  it('needs at least two lines', () => {
    const one = { memo: 'x', lines: [{ account: 'BANK', debit: '1', credit: '0' }] };
    // One line is both too short and (being a lone debit) unbalanced.
    expect(failures(draftJournalEntrySchema, one)).toContain('lines');
    const balancedButShort = { memo: 'x', lines: [{ account: 'BANK', debit: '0', credit: '0' }] };
    expect(failures(draftJournalEntrySchema, balancedButShort)).toContain('lines');
  });
});

describe('AgentProposal (stored)', () => {
  it('parses a stored proposal with its provenance and the verifier verdict', () => {
    expect(agentProposalSchema.parse(agentProposalFixture())).toMatchObject({
      verifierStatus: 'pending',
      attempt: 1,
      clusterId: null,
      model: 'claude-haiku-5-5',
      harnessFindings: [],
    });
  });

  it('applies the same coherence rules as the content', () => {
    expect(failures(agentProposalSchema, { ...agentProposalFixture(), links: [] })).toEqual([
      'links',
    ]);
  });

  it('needs a positive attempt number', () => {
    for (const attempt of [0, -1, 1.5]) {
      expect(failures(agentProposalSchema, { ...agentProposalFixture(), attempt })).toEqual([
        'attempt',
      ]);
    }
  });

  it('rejects an unknown verifier status and an over-long finding', () => {
    expect(
      failures(agentProposalSchema, { ...agentProposalFixture(), verifierStatus: 'approved' }),
    ).toEqual(['verifierStatus']);
    expect(
      failures(agentProposalSchema, {
        ...agentProposalFixture(),
        verifierFindings: ['x'.repeat(501)],
      }),
    ).toEqual(['verifierFindings.0']);
    expect(
      failures(agentProposalSchema, {
        ...agentProposalFixture(),
        harnessFindings: ['x'.repeat(301)],
      }),
    ).toEqual(['harnessFindings.0']);
  });
});

describe('Review', () => {
  it('parses a human approval and an auto-accept', () => {
    expect(reviewSchema.parse(reviewFixture())).toMatchObject({
      decision: 'approved',
      reviewerKind: 'human',
    });
    expect(
      failures(reviewSchema, {
        ...reviewFixture(),
        reviewerKind: 'auto_accept',
        reviewer: 'policy:v1',
      }),
    ).toEqual([]);
  });

  it('rejects unknown decisions or reviewer kinds', () => {
    expect(failures(reviewSchema, { ...reviewFixture(), decision: 'maybe' })).toEqual(['decision']);
    expect(failures(reviewSchema, { ...reviewFixture(), reviewerKind: 'llm' })).toEqual([
      'reviewerKind',
    ]);
  });
});
