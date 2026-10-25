import { AGENT_TOOL_NAMES } from '@ziro/core/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { insertLedger, insertPayment, pgErrorOf } from '../../db/migrated-db.fixtures.js';
import {
  buildWorld,
  createMigratedDb,
  INJECTION_MEMO,
  INJECTION_NARRATION,
  seedRun,
  setRunConfig,
  type TestDb,
  type World,
} from '../agent.fixtures.js';
import { AGENT_TOOLS } from './definitions.js';
import { MAX_RESULT_CHARS, STATEMENT_TIMEOUT_MS, Toolbox } from './toolbox.js';
import { type AgentTool, ToolError, type ToolRun } from './types.js';
import { z } from 'zod';

let db: TestDb;
let client: Awaited<ReturnType<typeof createMigratedDb>>['client'];
let world: World;
let box: Toolbox;

beforeAll(async () => {
  ({ db, client } = await createMigratedDb());
  world = await buildWorld(db);
  box = await Toolbox.create(db, world.runId);
}, 60_000);

afterAll(async () => {
  await client.close();
});

// --- helpers --------------------------------------------------------------------------------------

/** Reads `a.b.0.c` out of parsed JSON. */
function at(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => {
    if (node === null || typeof node !== 'object') return undefined;
    return (node as Record<string, unknown>)[key];
  }, value);
}

async function call(name: string, args: unknown) {
  const run = await box.run(name, args);
  if (!run.ok) throw new Error(`${name} failed: ${run.error}`);
  return { run, data: JSON.parse(run.content) as unknown };
}

async function fail(name: string, args: unknown): Promise<string> {
  const run = await box.run(name, args);
  if (run.ok) throw new Error(`${name} should have failed`);
  return run.error;
}

const seenIds = (run: ToolRun): string[] => (run.ok ? run.seen.map((r) => r.recordId) : []);

// --- the tool set --------------------------------------------------------------------------------

describe('the tool set', () => {
  it('is exactly the documented nine, in order', () => {
    expect(AGENT_TOOLS.map((t) => t.name)).toEqual([...AGENT_TOOL_NAMES]);
    expect(box.definitions.map((d) => d.name)).toEqual([...AGENT_TOOL_NAMES]);
  });

  it('sends strict, closed JSON Schemas within the API limits', () => {
    let optional = 0;
    const banned = [
      'minimum',
      'maximum',
      'minLength',
      'maxLength',
      'pattern',
      'minItems',
      'maxItems',
      'default',
    ];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node !== 'object' || node === null) return;
      for (const [key, value] of Object.entries(node)) {
        expect(banned, `keyword ${key}`).not.toContain(key);
        walk(value);
      }
    };
    for (const def of box.definitions) {
      expect(def.strict).toBe(true);
      expect(def.description.length).toBeGreaterThan(40);
      const schema = def.input_schema as {
        type: string;
        additionalProperties: unknown;
        properties: object;
        required?: string[];
      };
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      optional += Object.keys(schema.properties).length - (schema.required?.length ?? 0);
      walk(schema);
    }
    expect(box.definitions.length).toBeLessThanOrEqual(20);
    expect(optional).toBeLessThanOrEqual(24);
  });

  it('never exposes the run id as an argument', () => {
    for (const def of box.definitions) {
      expect(JSON.stringify(def.input_schema)).not.toMatch(/run_?id/i);
    }
  });
});

// --- calling a tool --------------------------------------------------------------------------------

describe('Toolbox.run', () => {
  it('rejects an unknown tool and lists the real ones', async () => {
    const error = await fail('delete_everything', {});
    expect(error).toContain('unknown tool');
    expect(error).toContain('get_exception');
  });

  it('rejects invalid arguments with a short, specific message', async () => {
    expect(await fail('get_exception', {})).toMatch(/invalid arguments: exception_id/);
    expect(await fail('get_exception', { exception_id: 'not-a-uuid' })).toMatch(/exception_id/);
  });

  it('rejects unknown arguments, so a tool cannot be pointed at another run', async () => {
    const error = await fail('get_exception', {
      exception_id: world.exceptions.duplicate,
      run_id: world.otherRunId,
    });
    expect(error).toMatch(/invalid arguments/);
  });

  it('runs inside a READ ONLY transaction: a write is refused by Postgres itself', async () => {
    const evil: AgentTool<Record<string, never>> = {
      name: 'get_exception',
      description: 'tries to write',
      args: z.strictObject({}),
      async execute(_args, ctx) {
        await ctx.tx.execute(
          sql`insert into recon_runs (razorpay_source, period_start, period_end) values ('synthetic', '2026-10-01', '2026-10-02')`,
        );
        return { data: {}, summary: 'wrote', seen: [] };
      },
    };
    const writer = await Toolbox.create(db, world.runId, [evil]);
    const failure = await pgErrorOf(writer.run('get_exception', {}));
    expect(failure.code).toBe('25006'); // read_only_sql_transaction
  });

  it('sets a statement timeout inside the transaction', async () => {
    let seen = '';
    const probe: AgentTool<Record<string, never>> = {
      name: 'get_exception',
      description: 'reads the timeout',
      args: z.strictObject({}),
      async execute(_args, ctx) {
        const result = await ctx.tx.execute(sql`select current_setting('statement_timeout') as v`);
        seen = String((result as { rows: { v: string }[] }).rows[0]?.v);
        return { data: {}, summary: 'ok', seen: [] };
      },
    };
    await (await Toolbox.create(db, world.runId, [probe])).run('get_exception', {});
    expect(seen).toBe(`${STATEMENT_TIMEOUT_MS / 1000}s`);
  });

  it('turns an oversized result into an error the model can act on', async () => {
    const big: AgentTool<Record<string, never>> = {
      name: 'get_exception',
      description: 'returns too much',
      args: z.strictObject({}),
      execute() {
        return Promise.resolve({
          data: { blob: 'x'.repeat(MAX_RESULT_CHARS) },
          summary: 'big',
          seen: [],
        });
      },
    };
    const run = await (await Toolbox.create(db, world.runId, [big])).run('get_exception', {});
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.error).toMatch(/too large.*narrow/);
  });

  it('reports a ToolError and a cancelled statement to the model, but rethrows our own failures', async () => {
    const throwing = (make: () => Error): AgentTool => ({
      name: 'get_exception',
      description: 'throws',
      args: z.strictObject({}),
      execute() {
        return Promise.reject(make());
      },
    });
    const run = (tool: AgentTool) =>
      Toolbox.create(db, world.runId, [tool]).then((b) => b.run('get_exception', {}));

    const asked = await run(throwing(() => new ToolError('nothing like that here')));
    expect(asked).toEqual({ ok: false, error: 'nothing like that here' });

    const timedOut = await run(
      throwing(() => Object.assign(new Error('wrapped'), { cause: { code: '57014' } })),
    );
    expect(timedOut.ok).toBe(false);
    if (!timedOut.ok) expect(timedOut.error).toMatch(/took too long/);

    await expect(run(throwing(() => new Error('connection lost')))).rejects.toThrow(
      'connection lost',
    );
  });

  it('never shows the run id, in any result', async () => {
    const calls: [string, unknown][] = [
      ['get_exception', { exception_id: world.exceptions.duplicate }],
      ['get_ledger_entry', { id: 'ORD-1001' }],
      ['get_payment', { id: 'pay_P1' }],
      ['get_settlement_composition', { settlement_id: 'setl_S1' }],
      ['search_bank_lines', { amount_min: 1 }],
    ];
    for (const [name, args] of calls) {
      const { run } = await call(name, args);
      expect(run.ok && run.content).not.toContain(world.runId);
    }
  });
});

// --- get_exception --------------------------------------------------------------------------------------

describe('get_exception', () => {
  it('shows what the rules concluded, the subject and its candidates', async () => {
    const { data, run } = await call('get_exception', { exception_id: world.exceptions.duplicate });
    expect(at(data, 'ruleReasonCode')).toBe('DUPLICATE_PAYMENT');
    expect(at(data, 'cause')).toBe('multiple_candidates');
    expect(at(data, 'note')).toContain('ORD-1002');
    expect(at(data, 'amountAtStakePaise')).toBe('250000');
    expect(at(data, 'subject.key')).toBe('ORD-1002');
    expect(at(data, 'subject.amountPaise')).toBe('250000');
    expect(at(data, 'candidateCount')).toBe(2);
    const keys = (at(data, 'candidates') as { key: string }[]).map((c) => c.key);
    expect(keys.sort()).toEqual(['pay_P2', 'pay_P3']);
    expect(seenIds(run).sort()).toEqual(
      [world.ledger.l2, world.payments.p2, world.payments.p3].sort(),
    );
  });

  it('lists candidates by type and business key, whatever order the rules stored them in', async () => {
    const original = await db.execute(
      sql`select candidates from recon_exceptions where id = ${world.exceptions.duplicate}`,
    );
    const stored = (original.rows[0] as { candidates: unknown[] }).candidates;
    try {
      for (const order of [stored, [...stored].reverse()]) {
        await db.execute(
          sql`update recon_exceptions set candidates = ${JSON.stringify(order)}::jsonb where id = ${world.exceptions.duplicate}`,
        );
        const { data } = await call('get_exception', { exception_id: world.exceptions.duplicate });
        expect((at(data, 'candidates') as { key: string }[]).map((c) => c.key)).toEqual([
          'pay_P2',
          'pay_P3',
        ]);
      }
    } finally {
      await db.execute(
        sql`update recon_exceptions set candidates = ${JSON.stringify(stored)}::jsonb where id = ${world.exceptions.duplicate}`,
      );
    }
  });

  it('handles an exception without candidates', async () => {
    const { data } = await call('get_exception', {
      exception_id: world.exceptions.unexplainedCredit,
    });
    expect(at(data, 'candidateCount')).toBe(0);
    expect(at(data, 'subject.key')).toBeDefined();
    expect(at(data, 'subject.amountPaise')).toBe('248050');
  });

  it("does not find another run's exception", async () => {
    const { rows } = await db.execute(
      sql`select id from recon_exceptions where run_id = ${world.otherRunId}`,
    );
    const foreignId = (rows[0] as { id: string }).id;
    expect(await fail('get_exception', { exception_id: foreignId })).toMatch(/no exception/);
  });

  it('shows at most 25 candidates but reports how many there are', async () => {
    const runId = await seedRun(db);
    const ids: string[] = [];
    for (let i = 0; i < 30; i += 1)
      ids.push(await insertLedger(db, runId, { orderRef: `CAND-${i}`, amountPaise: 100n }));
    const { rows } = await db.execute(sql`
      insert into recon_exceptions (run_id, reason_code, subject_type, subject_id, candidates)
      values (${runId}, 'UNKNOWN', 'ledger_entry', ${ids[0]}, ${JSON.stringify(ids.map((id) => ({ recordType: 'ledger_entry', recordId: id })))}::jsonb)
      returning id`);
    const many = await Toolbox.create(db, runId);
    const run = await many.run('get_exception', { exception_id: (rows[0] as { id: string }).id });
    expect(run.ok).toBe(true);
    if (run.ok) {
      const data = JSON.parse(run.content) as unknown;
      expect(at(data, 'candidateCount')).toBe(30);
      expect((at(data, 'candidates') as unknown[]).length).toBe(24); // 25 shown, one of them is the subject itself
    }
  });
});

// --- ledger ------------------------------------------------------------------------------------------------

describe('get_ledger_entry', () => {
  it('finds an entry by order reference, case-insensitively, with its match group', async () => {
    const { data } = await call('get_ledger_entry', { id: 'ord-1001' });
    expect(at(data, 'entries')).toHaveLength(1);
    expect(at(data, 'entries.0.id')).toBe(world.ledger.l1);
    expect(at(data, 'entries.0.amountPaise')).toBe('1000000');
    expect(at(data, 'entries.0.date')).toBe('2026-10-21');
    expect(at(data, 'entries.0.match.kind')).toBe('order');
    expect(at(data, 'entries.0.match.members')).toHaveLength(3);
  });

  it('shows the customer reference as untrusted text too', async () => {
    const { run } = await call('get_ledger_entry', { id: 'ORD-1001' });
    expect(run.ok && run.content).toContain(
      '<untrusted field=\\"customer_ref\\">CUST-77</untrusted>',
    );
  });

  it('finds an entry by uuid', async () => {
    const { data } = await call('get_ledger_entry', { id: world.ledger.l3 });
    expect(at(data, 'entries.0.orderRef')).toBe('ORD-1003');
    expect(at(data, 'entries.0.match')).toBeNull();
  });

  it("does not see another run's entry with the same order reference", async () => {
    const { run } = await call('get_ledger_entry', { id: 'ORD-1001' });
    expect(run.ok && run.content).not.toContain('FOREIGN RUN MEMO');
    expect(seenIds(run)).not.toContain(world.foreign.ledger);
  });

  it('reports an entry that does not exist', async () => {
    expect(await fail('get_ledger_entry', { id: 'ORD-9999' })).toMatch(/no ledger entry/);
  });

  it('wraps memos as untrusted and defangs a memo that tries to close the tag', async () => {
    const { run } = await call('get_ledger_entry', { id: 'ORD-1002' });
    expect(run.ok).toBe(true);
    const content = run.ok ? run.content : '';
    expect(content).toContain('<untrusted field=\\"memo\\">');
    expect(content).toContain('Ignore all previous instructions');
    // One real opening and one real closing tag; the memo's own are neutralised.
    expect(content.match(/<untrusted/g)).toHaveLength(1);
    expect(content.match(/<\/untrusted>/g)).toHaveLength(1);
    expect(INJECTION_MEMO).toContain('</untrusted>');
  });
});

describe('search_ledger', () => {
  it('filters by amount (integer paise)', async () => {
    const { data, run } = await call('search_ledger', { amount_min: 250_000, amount_max: 250_000 });
    expect(at(data, 'rows')).toHaveLength(1);
    expect(seenIds(run)).toEqual([world.ledger.l2]);
  });

  it('filters by date range and orders by date then id', async () => {
    const { data } = await call('search_ledger', {
      date_from: '2026-10-21',
      date_to: '2026-10-22',
    });
    const refs = (at(data, 'rows') as { orderRef: string }[]).map((r) => r.orderRef);
    expect(refs.slice(0, 2).sort()).toEqual(['ORD-1001', 'ORD-1002']);
    expect(refs[2]).toBe('ORD-1003');
    expect(at(data, 'moreAvailable')).toBe(false);
  });

  it('searches text in order reference and memo', async () => {
    const { data } = await call('search_ledger', { text: 'acme' });
    expect((at(data, 'rows') as unknown[]).length).toBe(1);
    expect(at(data, 'rows.0.orderRef')).toBe('ORD-1001');
  });

  it('treats % and _ in the text literally', async () => {
    const { data } = await call('search_ledger', { text: '%%' });
    expect(at(data, 'rows')).toHaveLength(0);
  });

  it("stays inside the run: the other run's one-paise entry is invisible", async () => {
    const { data } = await call('search_ledger', { amount_min: 1, amount_max: 1 });
    expect(at(data, 'rows')).toHaveLength(0);
  });

  it('says when it cut the answer short', async () => {
    const { data } = await call('search_ledger', {
      date_from: '2026-10-21',
      date_to: '2026-10-22',
      limit: 2,
    });
    expect(at(data, 'shown')).toBe(2);
    expect(at(data, 'moreAvailable')).toBe(true);
  });

  it('refuses an empty filter, inverted bounds, a huge date span and impossible dates', async () => {
    expect(await fail('search_ledger', {})).toMatch(/at least one filter/);
    expect(await fail('search_ledger', { amount_min: 10, amount_max: 5 })).toMatch(
      /amount_min is above/,
    );
    expect(await fail('search_ledger', { date_from: '2026-10-05', date_to: '2026-10-01' })).toMatch(
      /after/,
    );
    expect(await fail('search_ledger', { date_from: '2026-01-01', date_to: '2026-12-31' })).toMatch(
      /62 days/,
    );
    expect(await fail('search_ledger', { date_from: '2026-13-40' })).toMatch(/date_from/);
    expect(await fail('search_ledger', { amount_min: 1.5 })).toMatch(/amount_min/);
    expect(await fail('search_ledger', { amount_min: -1 })).toMatch(/amount_min/);
    expect(await fail('search_ledger', { text: 'a', amount_min: 1 })).toMatch(/text/);
    expect(await fail('search_ledger', { amount_min: 1, limit: 500 })).toMatch(/limit/);
  });
});

// --- payments and refunds ---------------------------------------------------------------------------------

describe('get_payment', () => {
  it('shows amounts in paise, the settlement that paid it out and its match group', async () => {
    const { data, run } = await call('get_payment', { id: 'pay_P1' });
    expect(at(data, 'payments')).toHaveLength(1);
    expect(at(data, 'payments.0.amountPaise')).toBe('1000000');
    expect(at(data, 'payments.0.feePaise')).toBe('23600');
    expect(at(data, 'payments.0.taxPaise')).toBe('3600');
    expect(at(data, 'payments.0.amountRefundedPaise')).toBe('300000');
    expect(at(data, 'payments.0.settlement.razorpayId')).toBe('setl_S1');
    expect(at(data, 'payments.0.settlement.amountPaise')).toBe('923450');
    expect(at(data, 'payments.0.match.kind')).toBe('order');
    expect(seenIds(run)).toContain(world.settlements.s1);
    expect(seenIds(run)).toContain(world.ledger.l1);
  });

  it('finds a payment by order receipt, exactly (a retry has its own receipt)', async () => {
    const original = await call('get_payment', { id: 'ORD-1002' });
    expect(at(original.data, 'payments')).toHaveLength(1);
    expect(at(original.data, 'payments.0.razorpayId')).toBe('pay_P2');
    const retry = await call('get_payment', { id: 'ord-1002-r1' });
    expect(at(retry.data, 'payments.0.razorpayId')).toBe('pay_P3');
  });

  it('reports a payment nobody settled', async () => {
    const { data } = await call('get_payment', { id: world.payments.p5 });
    expect(at(data, 'payments.0.settlement')).toBeNull();
    expect(at(data, 'payments.0.status')).toBe('authorized');
    expect(at(data, 'payments.0.captured')).toBe(false);
  });

  it("does not return the other run's pay_P1", async () => {
    const { run } = await call('get_payment', { id: 'pay_P1' });
    expect(seenIds(run)).not.toContain(world.foreign.payment);
    expect(await fail('get_payment', { id: world.foreign.payment })).toMatch(/no payment/);
  });
});

describe('list_refunds', () => {
  it('lists the refunds of a payment and totals them', async () => {
    const { data, run } = await call('list_refunds', { payment_id: 'pay_P1' });
    expect(at(data, 'refunds')).toHaveLength(1);
    expect(at(data, 'refunds.0.amountPaise')).toBe('300000');
    expect(at(data, 'totalRefundedPaise')).toBe('300000');
    expect(seenIds(run)).toEqual(expect.arrayContaining([world.payments.p1, world.refunds.r1]));
  });

  it('accepts a uuid and reports a payment with no refunds', async () => {
    const { data } = await call('list_refunds', { payment_id: world.payments.p2 });
    expect(at(data, 'refunds')).toEqual([]);
    expect(at(data, 'totalRefundedPaise')).toBe('0');
  });

  it('reports an unknown payment', async () => {
    expect(await fail('list_refunds', { payment_id: 'pay_NOPE' })).toMatch(/no payment/);
  });
});

// --- settlements ----------------------------------------------------------------------------------------

describe('get_settlement_composition', () => {
  it('adds up S1 to the paise and says it reconciles', async () => {
    const { data, run } = await call('get_settlement_composition', { settlement_id: 'setl_S1' });
    expect(at(data, 'composition.grossPaise')).toBe('1250000');
    expect(at(data, 'composition.feesPaiseIncludingGst')).toBe('26550');
    expect(at(data, 'composition.gstInsideFeesPaise')).toBe('4050');
    expect(at(data, 'composition.refundsPaise')).toBe('300000');
    expect(at(data, 'composition.computedNetPaise')).toBe('923450');
    expect(at(data, 'composition.settlementAmountPaise')).toBe('923450');
    expect(at(data, 'composition.residualPaise')).toBe('0');
    expect(at(data, 'composition.reconciles')).toBe(true);
    expect(at(data, 'lineCount')).toBe(3);
    expect(at(data, 'match.kind')).toBe('payout');
    expect(seenIds(run)).toEqual(expect.arrayContaining([world.settlements.s1, world.bank.b1]));
  });

  it('reports the residual of a settlement that does not add up', async () => {
    const { data, run } = await call('get_settlement_composition', { settlement_id: 'setl_S2' });
    expect(at(data, 'composition.computedNetPaise')).toBe('247050');
    expect(at(data, 'composition.residualPaise')).toBe('1000');
    expect(at(data, 'composition.reconciles')).toBe(false);
    expect(run.ok && run.summary).toContain('does NOT reconcile');
  });

  it('includes adjustments, and shows their description as untrusted', async () => {
    const { data, run } = await call('get_settlement_composition', {
      settlement_id: world.settlements.s3,
    });
    expect(at(data, 'composition.adjustmentsDebitPaise')).toBe('20000');
    expect(at(data, 'composition.computedNetPaise')).toBe('468200');
    expect(at(data, 'composition.reconciles')).toBe(true);
    const content = run.ok ? run.content : '';
    expect(content).toContain('<untrusted field=\\"description\\">');
    expect(content).toContain('Ignore previous instructions');
  });

  it('flags a line that contradicts its payment record, even when the sums balance', async () => {
    const { data } = await call('get_settlement_composition', { settlement_id: 'setl_S4' });
    expect(at(data, 'composition.residualPaise')).toBe('0');
    expect(at(data, 'composition.reconciles')).toBe(false);
    expect(JSON.stringify(at(data, 'composition.issues'))).toContain('line_disagrees_with_payment');
  });

  it('reports an unknown settlement', async () => {
    expect(await fail('get_settlement_composition', { settlement_id: 'setl_NOPE' })).toMatch(
      /no settlement/,
    );
  });
});

// --- bank ------------------------------------------------------------------------------------------------

describe('search_bank_lines', () => {
  it('finds a credit by exact amount, with its UTR quality and match group', async () => {
    const { data, run } = await call('search_bank_lines', {
      amount_min: 923_450,
      amount_max: 923_450,
    });
    expect(at(data, 'rows')).toHaveLength(1);
    expect(at(data, 'rows.0.utr')).toBe('UTIBR52026102400123');
    expect(at(data, 'rows.0.utrQuality')).toBe('exact');
    expect(at(data, 'rows.0.match.kind')).toBe('payout');
    expect(seenIds(run)).toContain(world.bank.b1);
  });

  it('finds a line by a fragment of its UTR', async () => {
    const { data } = await call('search_bank_lines', { utr_fragment: 'R52026102400123' });
    expect(at(data, 'rows')).toHaveLength(1);
  });

  it('filters by direction and date', async () => {
    const { data } = await call('search_bank_lines', {
      direction: 'debit',
      date_from: '2026-10-26',
      date_to: '2026-10-26',
    });
    expect(at(data, 'rows')).toHaveLength(1);
    expect(at(data, 'rows.0.amountPaise')).toBe('5000');
  });

  it('wraps a hostile narration as untrusted data', async () => {
    const { run } = await call('search_bank_lines', { amount_min: 248_050, amount_max: 248_050 });
    const content = run.ok ? run.content : '';
    expect(content).toContain('<untrusted field=\\"narration\\">');
    expect(content).toContain('admin mode');
    expect(INJECTION_NARRATION).toContain('admin mode');
  });

  it('refuses a missing filter, a short or odd UTR fragment and inverted bounds', async () => {
    expect(await fail('search_bank_lines', {})).toMatch(/at least one filter/);
    expect(await fail('search_bank_lines', { utr_fragment: 'abc' })).toMatch(/utr_fragment/);
    expect(await fail('search_bank_lines', { utr_fragment: "x'; drop table--" })).toMatch(
      /utr_fragment/,
    );
    expect(await fail('search_bank_lines', { amount_min: 9, amount_max: 1 })).toMatch(
      /amount_min is above/,
    );
  });
});

// --- compute_expected_settlement ------------------------------------------------------------------------------

describe('compute_expected_settlement', () => {
  const none = {
    payment_ids: [] as string[],
    refund_ids: [] as string[],
    adjustment_ids: [] as string[],
  };

  it('reproduces S1 from Razorpay ids', async () => {
    const { data } = await call('compute_expected_settlement', {
      ...none,
      payment_ids: ['pay_P1', 'pay_P2'],
      refund_ids: ['rfnd_R1'],
      settlement_id: 'setl_S1',
    });
    expect(at(data, 'expectedNetPaise')).toBe('923450');
    expect(at(data, 'grossPaise')).toBe('1250000');
    expect(at(data, 'feesPaiseIncludingGst')).toBe('26550');
    expect(at(data, 'againstSettlement.residualPaise')).toBe('0');
    expect(at(data, 'notFound')).toEqual([]);
    expect(at(data, 'issues')).toEqual([]);
  });

  it('accepts uuids and Razorpay ids mixed, and an adjustment', async () => {
    const { data } = await call('compute_expected_settlement', {
      ...none,
      payment_ids: [world.payments.p4],
      adjustment_ids: ['adj_A1'],
    });
    expect(at(data, 'expectedNetPaise')).toBe('468200');
    expect(at(data, 'adjustmentsDebitPaise')).toBe('20000');
    expect(at(data, 'issues')).toEqual([]);
  });

  it('gives the signed residual against a settlement that does not match', async () => {
    const { data } = await call('compute_expected_settlement', {
      ...none,
      payment_ids: ['pay_P1', 'pay_P2'],
      refund_ids: ['rfnd_R1'],
      settlement_id: 'setl_S2',
    });
    // S2 paid out 248,050; these records would pay 923,450.
    expect(at(data, 'againstSettlement.residualPaise')).toBe('-675400');
  });

  it('shows the duplicate-settlement case: a payment counted once does not explain S2', async () => {
    const { data } = await call('compute_expected_settlement', {
      ...none,
      payment_ids: ['pay_P3'],
      settlement_id: 'setl_S2',
    });
    expect(at(data, 'expectedNetPaise')).toBe('247050');
    expect(at(data, 'againstSettlement.residualPaise')).toBe('1000');
  });

  it('reports ids it cannot find instead of silently ignoring them', async () => {
    const { data } = await call('compute_expected_settlement', {
      ...none,
      payment_ids: ['pay_P1', 'pay_NOPE'],
    });
    expect(at(data, 'notFound')).toEqual(['pay_NOPE']);
    expect(at(data, 'expectedNetPaise')).toBe('976400');
  });

  it("cannot reach the other run's payment by uuid", async () => {
    const { data } = await call('compute_expected_settlement', {
      ...none,
      payment_ids: [world.foreign.payment],
    });
    expect(at(data, 'notFound')).toEqual([world.foreign.payment]);
    expect(at(data, 'expectedNetPaise')).toBe('0');
  });

  it('refuses no ids and too many ids', async () => {
    expect(await fail('compute_expected_settlement', none)).toMatch(/at least one/);
    const many = Array.from({ length: 61 }, (_, i) => `pay_${i}`);
    expect(await fail('compute_expected_settlement', { ...none, payment_ids: many })).toMatch(
      /payment_ids/,
    );
    expect(
      await fail('compute_expected_settlement', {
        ...none,
        payment_ids: many.slice(0, 40),
        refund_ids: many.slice(0, 30),
      }),
    ).toMatch(/at most 60/);
    expect(await fail('compute_expected_settlement', { payment_ids: ['pay_P1'] })).toMatch(
      /refund_ids/,
    );
  });

  it('agrees with get_settlement_composition for every settlement in the world', async () => {
    const pairs: [string, string[], string[], string[]][] = [
      ['setl_S1', ['pay_P1', 'pay_P2'], ['rfnd_R1'], []],
      ['setl_S2', ['pay_P3'], [], []],
      ['setl_S3', ['pay_P4'], [], ['adj_A1']],
    ];
    for (const [settlement, payments, refunds, adjustments] of pairs) {
      const composition = (await call('get_settlement_composition', { settlement_id: settlement }))
        .data;
      const expected = (
        await call('compute_expected_settlement', {
          payment_ids: payments,
          refund_ids: refunds,
          adjustment_ids: adjustments,
        })
      ).data;
      expect(at(expected, 'expectedNetPaise'), settlement).toBe(
        at(composition, 'composition.computedNetPaise'),
      );
    }
  });
});

// --- fee contract ----------------------------------------------------------------------------------------------

describe('get_fee_contract', () => {
  it('gives the default terms and says they are the default', async () => {
    const { data } = await call('get_fee_contract', { method: 'card' });
    expect(at(data, 'feeBps')).toBe(200);
    expect(at(data, 'gstBps')).toBe(1800);
    expect(at(data, 'contractSource')).toBe('default');
  });

  it('computes the expected fee for an amount, half-up at each step', async () => {
    const card = await call('get_fee_contract', { method: 'CARD', amount_paise: 1_000_000 });
    expect(at(card.data, 'expectedFor.baseFeePaise')).toBe('20000');
    expect(at(card.data, 'expectedFor.gstPaise')).toBe('3600');
    expect(at(card.data, 'expectedFor.totalFeePaise')).toBe('23600');
    // 12,345 x 1% = 123.45 -> 123; 123 x 18% = 22.14 -> 22; total 145.
    const odd = await call('get_fee_contract', { method: 'upi', amount_paise: 12_345 });
    expect(at(odd.data, 'expectedFor.totalFeePaise')).toBe('145');
    // 50 x 1% = 0.5 -> 1 (half-up); 1 x 18% = 0.18 -> 0; total 1.
    const tie = await call('get_fee_contract', { method: 'upi', amount_paise: 50 });
    expect(at(tie.data, 'expectedFor.baseFeePaise')).toBe('1');
    expect(at(tie.data, 'expectedFor.totalFeePaise')).toBe('1');
  });

  it("matches the fees recorded on this world's payments", async () => {
    const p1 = await call('get_fee_contract', { method: 'card', amount_paise: 1_000_000 });
    const p2 = await call('get_fee_contract', { method: 'upi', amount_paise: 250_000 });
    expect(at(p1.data, 'expectedFor.totalFeePaise')).toBe('23600');
    expect(at(p2.data, 'expectedFor.totalFeePaise')).toBe('2950');
  });

  it('says so for a method the contract does not cover', async () => {
    const { data } = await call('get_fee_contract', { method: 'wallet' });
    expect(at(data, 'known')).toBe(false);
    expect(at(data, 'knownMethods')).toEqual(['card', 'netbanking', 'upi']);
  });

  it("uses the run's own contract when the run carries one", async () => {
    const runId = await seedRun(db);
    await setRunConfig(db, runId, {
      feeContract: { gstBps: 1800, methods: { card: { feeBps: 250 } } },
    });
    const custom = await Toolbox.create(db, runId);
    const run = await custom.run('get_fee_contract', { method: 'card', amount_paise: 100_000 });
    expect(run.ok).toBe(true);
    if (run.ok) {
      const data = JSON.parse(run.content) as unknown;
      expect(at(data, 'contractSource')).toBe('run');
      expect(at(data, 'feeBps')).toBe(250);
      expect(at(data, 'expectedFor.baseFeePaise')).toBe('2500');
    }
  });
});

// A payment inserted late must still be found: the tools read, they do not cache.
describe('freshness', () => {
  it('sees rows inserted after the toolbox was created', async () => {
    await insertPayment(db, world.runId, {
      rzpId: 'pay_LATE',
      receipt: 'ORD-LATE',
      amountPaise: 42n,
      feePaise: 0n,
      taxPaise: 0n,
      businessDate: '2026-10-21',
    });
    const { data } = await call('get_payment', { id: 'pay_LATE' });
    expect(at(data, 'payments.0.amountPaise')).toBe('42');
  });
});
