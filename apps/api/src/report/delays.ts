// Delayed settlements, judged with the matcher's own rule so the report, the rule labels and the verifier
// cannot disagree. A settlement is DELAYED when Razorpay created it later than the normal lag after its
// payments were captured (`settlementCreatedLate`), or when its bank credit landed after the T4 window.
// A settlement with no bank credit past the window and the delay horizon is OVERDUE: money that has not
// arrived by the report's as-of date.
import {
  addBusinessDays,
  addDaysToBusinessDate,
  type BusinessCalendar,
  isBusinessDay,
} from '@ziro/core/time';
import { settlementCreatedLate } from '@ziro/core/matcher';

export interface DelayConfig {
  readonly calendar: BusinessCalendar;
  readonly settlementLagBusinessDays: number;
  readonly windowBusinessDays: number;
  readonly delayHorizonBusinessDays: number;
}

export interface SettlementFacts {
  readonly id: string;
  readonly rzpId: string;
  readonly businessDate: string;
  readonly amountPaise: bigint;
  /** Business dates of the payments the settlement pays out. */
  readonly paymentDates: readonly string[];
  /** Value date of its matched bank credit, if one has been matched. */
  readonly creditDate: string | null;
}

export interface DelayedSettlement {
  readonly id: string;
  readonly rzpId: string;
  readonly amountPaise: bigint;
  /** When it should have been created: the latest payment date plus the normal lag. */
  readonly dueDate: string | null;
  readonly settlementDate: string;
  readonly creditDate: string | null;
  readonly createdLate: boolean;
  readonly creditLate: boolean;
  /** Business days between when it was due and when it was created (0 when created on time). */
  readonly businessDaysLate: number;
}

export interface OverdueSettlement {
  readonly id: string;
  readonly rzpId: string;
  readonly amountPaise: bigint;
  readonly settlementDate: string;
  /** The last day a credit could still have counted as on time, plus the horizon. */
  readonly expectedBy: string;
  readonly daysOverdue: number;
}

export interface DelayReport {
  readonly delayed: readonly DelayedSettlement[];
  readonly overdue: readonly OverdueSettlement[];
}

const MS_PER_DAY = 86_400_000;
export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY);

/** Business days in the half-open interval (from, to]. */
function businessDaysBetween(from: string, to: string, calendar: BusinessCalendar): number {
  let count = 0;
  for (let day = addDaysToBusinessDate(from, 1); day <= to; day = addDaysToBusinessDate(day, 1)) {
    if (isBusinessDay(day, calendar)) count += 1;
  }
  return count;
}

export function findDelays(
  settlements: readonly SettlementFacts[],
  config: DelayConfig,
  asOf: string,
): DelayReport {
  const delayed: DelayedSettlement[] = [];
  const overdue: OverdueSettlement[] = [];

  for (const s of settlements) {
    const latestPayment = [...s.paymentDates].sort().at(-1) ?? null;
    const dueDate =
      latestPayment === null
        ? null
        : addBusinessDays(latestPayment, config.settlementLagBusinessDays, config.calendar);
    const createdLate = settlementCreatedLate(s.businessDate, s.paymentDates, config);
    const windowEnd = addBusinessDays(s.businessDate, config.windowBusinessDays, config.calendar);
    const creditLate = s.creditDate !== null && s.creditDate > windowEnd;

    if (createdLate || creditLate) {
      delayed.push({
        id: s.id,
        rzpId: s.rzpId,
        amountPaise: s.amountPaise,
        dueDate,
        settlementDate: s.businessDate,
        creditDate: s.creditDate,
        createdLate,
        creditLate,
        businessDaysLate:
          createdLate && dueDate !== null
            ? businessDaysBetween(dueDate, s.businessDate, config.calendar)
            : 0,
      });
    }

    if (s.creditDate === null) {
      const expectedBy = addBusinessDays(
        s.businessDate,
        config.windowBusinessDays + config.delayHorizonBusinessDays,
        config.calendar,
      );
      if (asOf > expectedBy) {
        overdue.push({
          id: s.id,
          rzpId: s.rzpId,
          amountPaise: s.amountPaise,
          settlementDate: s.businessDate,
          expectedBy,
          daysOverdue: daysBetween(expectedBy, asOf),
        });
      }
    }
  }

  const byId = <T extends { rzpId: string }>(a: T, b: T) => a.rzpId.localeCompare(b.rzpId);
  return { delayed: delayed.sort(byId), overdue: overdue.sort(byId) };
}
