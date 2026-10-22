import type { GenConfig } from '../config.js';
import { validateConfig } from '../config.js';
import { IdFactory } from '../ids.js';
import { Rng } from '../rng.js';
import { BusinessCalendar, parseIsoDay } from '../time.js';
import { buildBank } from './bank.js';
import { applyInjections } from './injections.js';
import { buildOrders, type WorldContext } from './orders.js';
import { buildSettlements } from './settle.js';
import { finalizeTruth } from './truth.js';
import type { Dataset } from './types.js';

/**
 * Generates a complete synthetic world — ledger, Razorpay entities, bank statement and the ground
 * truth that explains them — from a config. Pure and deterministic: no IO, no clock, no ambient
 * randomness, so the same config always yields the same dataset.
 */
export function generate(config: GenConfig): Dataset {
  validateConfig(config);
  const rng = Rng.fromSeed(config.seed);
  const startDay = parseIsoDay(config.startDate);
  const ctx: WorldContext = {
    config,
    rng,
    ids: new IdFactory(rng.fork('ids')),
    cal: new BusinessCalendar(config.fixedHolidays),
    startDay,
    lastDay: startDay + config.days - 1,
    anomalies: [],
  };

  const world = buildOrders(ctx);
  const settle = buildSettlements(ctx, world);
  const bank = buildBank(ctx, settle);

  const data: Dataset = {
    config,
    ledger: world.ledger,
    orders: world.orders,
    payments: world.payments,
    refunds: settle.refunds,
    settlements: settle.settlements,
    items: settle.items,
    bank,
    groups: [],
    anomalies: ctx.anomalies,
  };
  applyInjections(ctx, data);
  finalizeTruth(data);
  return data;
}
