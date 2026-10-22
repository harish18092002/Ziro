import type { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { agentProposalContentSchema, agentProposalSchema, reviewSchema } from './index.js';
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

describe('AgentProposal content (untrusted LLM output)', () => {
  it('parses a well-formed proposal; the claimed residual is a bigint claim, not a verdict', () => {
    const proposal = agentProposalContentSchema.parse(agentProposalContentFixture());
    expect(proposal.claimedResidual).toBe(0n);
    expect(proposal.links).toHaveLength(2);
  });

  it('rejects extra keys instead of ignoring them (no smuggled approvals)', () => {
    for (const extra of [{ approve: true }, { status: 'accepted' }, { verifierStatus: 'passed' }]) {
      expect(
        failures(agentProposalContentSchema, { ...agentProposalContentFixture(), ...extra }),
      ).toEqual(['(unknown key)']);
    }
  });

  it('rejects a float or malformed residual claim', () => {
    for (const claimedResidual of [0.5, '0.5', 'zero', '1e2', null]) {
      expect(
        failures(agentProposalContentSchema, { ...agentProposalContentFixture(), claimedResidual }),
        String(claimedResidual),
      ).toEqual(['claimedResidual']);
    }
  });

  it('caps text and list sizes', () => {
    const base = agentProposalContentFixture();
    expect(
      failures(agentProposalContentSchema, { ...base, explanation: 'x'.repeat(2001) }),
    ).toEqual(['explanation']);
    expect(failures(agentProposalContentSchema, { ...base, explanation: '' })).toEqual([
      'explanation',
    ]);
    const links = Array.from({ length: 51 }, (_, i) => ({
      recordType: 'rzp_payment',
      recordId: uuid(200 + i),
    }));
    expect(failures(agentProposalContentSchema, { ...base, links })).toEqual(['links']);
    expect(failures(agentProposalContentSchema, { ...base, evidence: [] })).toEqual(['evidence']);
    const evidence = Array.from({ length: 21 }, () => base.evidence[0]);
    expect(failures(agentProposalContentSchema, { ...base, evidence })).toEqual(['evidence']);
    expect(
      failures(agentProposalContentSchema, {
        ...base,
        evidence: [{ ...base.evidence[0], value: 'v'.repeat(201) }],
      }),
    ).toEqual(['evidence.0.value']);
  });

  it('requires a real reason code and record refs', () => {
    const base = agentProposalContentFixture();
    expect(failures(agentProposalContentSchema, { ...base, reasonCode: 'I_THINK_FEES' })).toEqual([
      'reasonCode',
    ]);
    expect(
      failures(agentProposalContentSchema, { ...base, links: [{ recordType: 'rzp_payment' }] }),
    ).toEqual(['links.0.recordId']);
  });
});

describe('AgentProposal (stored)', () => {
  it('parses a stored proposal with its verifier verdict', () => {
    expect(agentProposalSchema.parse(agentProposalFixture())).toMatchObject({
      verifierStatus: 'pending',
      claimedResidual: 0n,
    });
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
