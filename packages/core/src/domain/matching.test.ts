import type { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  matchGroupSchema,
  matchLinkSchema,
  reconExceptionSchema,
  recordRefSchema,
} from './index.js';
import {
  matchGroupFixture,
  matchLinkFixture,
  reconExceptionFixture,
  uuid,
} from './domain.fixtures.js';

function failures(schema: z.ZodType, input: unknown): string[] {
  const result = schema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((i) =>
    i.code === 'unrecognized_keys' ? '(unknown key)' : i.path.join('.'),
  );
}

describe('RecordRef', () => {
  it('accepts the five record types and rejects anything else', () => {
    for (const recordType of [
      'ledger_entry',
      'rzp_payment',
      'rzp_refund',
      'rzp_settlement',
      'bank_line',
    ]) {
      expect(failures(recordRefSchema, { recordType, recordId: uuid(1) }), recordType).toEqual([]);
    }
    expect(failures(recordRefSchema, { recordType: 'settlement_item', recordId: uuid(1) })).toEqual(
      ['recordType'],
    );
    expect(failures(recordRefSchema, { recordType: 'bank_line', recordId: 'abc' })).toEqual([
      'recordId',
    ]);
  });
});

describe('MatchGroup', () => {
  it('parses an accepted group with zero residual', () => {
    expect(matchGroupSchema.parse(matchGroupFixture())).toMatchObject({
      status: 'accepted',
      residual: 0n,
    });
  });

  it('refuses an accepted group that does not reconcile to the paise', () => {
    for (const residual of ['1', '-1', 1, '100']) {
      expect(
        failures(matchGroupSchema, { ...matchGroupFixture(), residual }),
        String(residual),
      ).toEqual(['residual']);
    }
  });

  it('allows a non-zero residual while the group is only proposed, rejected or reversed', () => {
    for (const status of ['proposed', 'rejected', 'reversed']) {
      expect(
        failures(matchGroupSchema, { ...matchGroupFixture(), status, residual: '-6800' }),
        status,
      ).toEqual([]);
    }
  });

  it('allows a group without a tier or reason code (e.g. a human match)', () => {
    expect(
      failures(matchGroupSchema, {
        ...matchGroupFixture(),
        basis: 'human',
        tier: null,
        reasonCode: null,
      }),
    ).toEqual([]);
  });

  it('rejects unknown kinds, tiers and reason codes', () => {
    expect(failures(matchGroupSchema, { ...matchGroupFixture(), kind: 'chain' })).toEqual(['kind']);
    expect(failures(matchGroupSchema, { ...matchGroupFixture(), tier: 'T5' })).toEqual(['tier']);
    expect(failures(matchGroupSchema, { ...matchGroupFixture(), reasonCode: 'BECAUSE' })).toEqual([
      'reasonCode',
    ]);
  });
});

describe('MatchLink', () => {
  it('parses a link to a bank line', () => {
    expect(matchLinkSchema.parse(matchLinkFixture())).toMatchObject({ recordType: 'bank_line' });
  });

  it('rejects an unknown record type or an unknown group status', () => {
    expect(failures(matchLinkSchema, { ...matchLinkFixture(), recordType: 'payout' })).toEqual([
      'recordType',
    ]);
    expect(failures(matchLinkSchema, { ...matchLinkFixture(), groupStatus: 'maybe' })).toEqual([
      'groupStatus',
    ]);
  });
});

describe('ReconException', () => {
  it('parses an exception with a signed amount at stake', () => {
    expect(reconExceptionSchema.parse(reconExceptionFixture())).toMatchObject({
      reasonCode: 'FEE_GST_DEDUCTION',
      amountAtStake: -6800n,
    });
  });

  it('requires a valid reason code and caps the candidate list', () => {
    expect(
      failures(reconExceptionSchema, { ...reconExceptionFixture(), reasonCode: 'MYSTERY' }),
    ).toEqual(['reasonCode']);
    const many = Array.from({ length: 51 }, (_, i) => ({
      recordType: 'rzp_payment',
      recordId: uuid(100 + i),
    }));
    expect(
      failures(reconExceptionSchema, { ...reconExceptionFixture(), candidates: many }),
    ).toEqual(['candidates']);
  });

  it('rejects float money', () => {
    expect(
      failures(reconExceptionSchema, { ...reconExceptionFixture(), amountAtStake: -68.5 }),
    ).toEqual(['amountAtStake']);
  });
});
