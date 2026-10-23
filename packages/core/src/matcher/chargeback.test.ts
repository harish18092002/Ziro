import { describe, expect, it } from 'vitest';
import { paise } from '../money/index.js';
import { isChargebackLine } from './payouts.js';

const line = (over: {
  itemType?: 'adjustment' | 'transfer' | 'payment' | 'refund';
  debit?: bigint;
  description?: string | null;
}) => ({
  itemType: over.itemType ?? 'adjustment',
  debit: paise(over.debit ?? 100_000n),
  description: over.description === undefined ? 'Chargeback for payment pay_X' : over.description,
});

describe('isChargebackLine', () => {
  it.each([
    'Chargeback for payment pay_X',
    'CHARGE BACK raised',
    'chargeback',
    'Dispute disp_123 debit',
    'payment dispute',
  ])('recognises a debit adjustment described as %j', (description) => {
    expect(isChargebackLine(line({ description }))).toBe(true);
    expect(isChargebackLine(line({ description, itemType: 'transfer' }))).toBe(true);
  });

  it('does not take an adjustment for a chargeback on its description alone', () => {
    expect(isChargebackLine(line({ description: 'Settlement hold' }))).toBe(false);
    expect(isChargebackLine(line({ description: null }))).toBe(false);
    expect(isChargebackLine(line({ description: '' }))).toBe(false);
  });

  it('needs a debit: a credit named chargeback reversal is not a loss', () => {
    expect(isChargebackLine(line({ debit: 0n, description: 'Chargeback reversal' }))).toBe(false);
  });

  it('only adjustments and transfers count, never a payment or a refund line', () => {
    expect(isChargebackLine(line({ itemType: 'payment' }))).toBe(false);
    expect(isChargebackLine(line({ itemType: 'refund' }))).toBe(false);
  });
});
