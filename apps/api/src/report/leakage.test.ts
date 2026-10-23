import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FEE_CONTRACT } from '../common/fee-contract.js';
import { auditFees, type FeePayment } from './leakage.js';

// The default contract: card 200 bps, upi 100 bps, netbanking 190 bps, GST 18% of the base fee.
// A card payment of ₹1,000.00 (100000 paise): base 2000, GST 360, total 2360.
const pay = (over: Partial<FeePayment> & Pick<FeePayment, 'fee' | 'tax'>): FeePayment => ({
  rzpId: 'pay_1',
  method: 'card',
  currency: 'INR',
  amount: 100_000n,
  ...over,
});

describe('auditFees', () => {
  it('finds nothing when the fee is exactly the contracted one', () => {
    const audit = auditFees([pay({ fee: 2_360n, tax: 360n })], DEFAULT_FEE_CONTRACT);
    expect(audit.assessed).toBe(1);
    expect(audit.overcharged.count).toBe(0);
    expect(audit.undercharged.count).toBe(0);
    expect(audit.overcharged.excessPaise).toBe(0n);
  });

  it('measures an overcharge to the paise, GST included, split into base and GST', () => {
    // Charged 294 bps: base 2940, GST 18% of 2940 = 529.2 -> 529, fee 3469. Expected total 2360.
    const audit = auditFees([pay({ fee: 3_469n, tax: 529n })], DEFAULT_FEE_CONTRACT);
    expect(audit.overcharged).toEqual({
      count: 1,
      excessPaise: 1_109n,
      basePaise: 940n,
      gstPaise: 169n,
    });
    expect(audit.overcharged.basePaise + audit.overcharged.gstPaise).toBe(1_109n);
    expect(audit.worst[0]).toMatchObject({
      rzpId: 'pay_1',
      expectedFeePaise: 2_360n,
      actualFeePaise: 3_469n,
      excessPaise: 1_109n,
    });
  });

  it('reports an undercharge on its own and never nets it against an overcharge', () => {
    const audit = auditFees(
      [
        pay({ rzpId: 'pay_over', fee: 3_469n, tax: 529n }),
        // Base 1500, GST 270, fee 1770: 590 below the contract.
        pay({ rzpId: 'pay_under', fee: 1_770n, tax: 270n }),
      ],
      DEFAULT_FEE_CONTRACT,
    );
    expect(audit.overcharged.excessPaise).toBe(1_109n);
    expect(audit.undercharged).toEqual({ count: 1, shortfallPaise: 590n });
  });

  it('flags a GST-only difference without calling it a rate overcharge', () => {
    const audit = auditFees([pay({ fee: 2_400n, tax: 400n })], DEFAULT_FEE_CONTRACT);
    expect(audit.gstOnlyDifferences).toBe(1);
    expect(audit.overcharged.count).toBe(0);
  });

  it('says what it could not judge instead of treating it as clean', () => {
    const audit = auditFees(
      [
        pay({ rzpId: 'pay_wallet', method: 'wallet', fee: 9_999n, tax: 1_000n }),
        pay({ rzpId: 'pay_usd', currency: 'USD', fee: 9_999n, tax: 1_000n }),
        pay({ rzpId: 'pay_ok', fee: 2_360n, tax: 360n }),
      ],
      DEFAULT_FEE_CONTRACT,
    );
    expect(audit.notAssessable).toBe(2);
    expect(audit.assessed).toBe(1);
  });

  it('breaks the leakage down by method, and ranks the worst first with a stable tie-break', () => {
    const audit = auditFees(
      [
        pay({ rzpId: 'pay_b', fee: 3_469n, tax: 529n }),
        pay({ rzpId: 'pay_a', fee: 3_469n, tax: 529n }),
        // UPI 100 bps of 100000 = base 1000, GST 180, total 1180; charged base 1500: fee 1770.
        pay({ rzpId: 'pay_u', method: 'UPI', fee: 1_770n, tax: 270n }),
      ],
      DEFAULT_FEE_CONTRACT,
    );
    expect(audit.byMethod).toEqual([
      { method: 'card', assessed: 2, overchargedCount: 2, excessPaise: 2_218n },
      { method: 'upi', assessed: 1, overchargedCount: 1, excessPaise: 590n },
    ]);
    expect(audit.worst.map((w) => w.rzpId)).toEqual(['pay_a', 'pay_b', 'pay_u']);
  });

  it('adds up: every payment is assessed or not, and the excess is the sum of the parts', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            method: fc.constantFrom('card', 'upi', 'netbanking', 'wallet'),
            amount: fc.bigInt({ min: 100n, max: 5_000_000n }),
            extraBps: fc.integer({ min: -50, max: 150 }),
          }),
          { maxLength: 30 },
        ),
        (rows) => {
          const payments = rows.map((r, i): FeePayment => {
            const bps = (DEFAULT_FEE_CONTRACT.methods[r.method]?.feeBps ?? 200) + r.extraBps;
            const base = (r.amount * BigInt(Math.max(bps, 0)) + 5_000n) / 10_000n;
            const tax = (base * 1_800n + 5_000n) / 10_000n;
            return {
              rzpId: `pay_${i}`,
              method: r.method,
              currency: 'INR',
              amount: r.amount,
              fee: base + tax,
              tax,
            };
          });
          const audit = auditFees(payments, DEFAULT_FEE_CONTRACT);
          expect(audit.assessed + audit.notAssessable).toBe(payments.length);
          expect(audit.overcharged.excessPaise).toBe(
            audit.byMethod.reduce((n, m) => n + m.excessPaise, 0n),
          );
          expect(audit.overcharged.count).toBe(
            audit.byMethod.reduce((n, m) => n + m.overchargedCount, 0),
          );
          expect(audit.overcharged.excessPaise).toBeGreaterThanOrEqual(0n);
        },
      ),
      { numRuns: 200 },
    );
  });
});
