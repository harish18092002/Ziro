#!/usr/bin/env node
// The stranger's path, over HTTP, against a running Ziro: open the page, replay the eval run, start a run,
// watch it finish, review a proposal, try the things a public demo must refuse, reset. Used locally
// (scripts/docker-local.sh) and by scripts/deploy.sh after a deploy. No dependencies, no cookies, no login.
//
//   node scripts/smoke.mjs http://127.0.0.1:8080
//   node scripts/smoke.mjs https://ziro-xxxxx.a.run.app --no-key
//
// --no-key  also asserts the server has NO model key, i.e. everything above worked without one.
// It starts one scripted run and one reset, so it counts against the demo's per-visitor limits.
// Exit status 0 only if every check passed.

const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith('--')) ?? '').replace(/\/+$/, '');
const noKey = args.includes('--no-key');
if (!/^https?:\/\//.test(base)) {
  console.error('usage: node scripts/smoke.mjs <base url> [--no-key]');
  process.exit(2);
}

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === '' ? '' : `  (${detail})`}`);
  if (!ok) failed += 1;
};

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    // not JSON (the page itself)
  }
  return { status: res.status, json, text };
}

async function untilReady(runId, label, ms = 120_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const { json } = await call('GET', `/runs/${runId}/progress`);
    if (json?.stage === 'ready') return json;
    if (json?.stage === 'failed' || Date.now() > deadline) {
      check(`${label} reaches ready`, false, `stage ${json?.stage}`);
      return null;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

const first = (list, pick) => list.find(pick);

// 1. the page and the probes
const page = await call('GET', '/');
check('the console loads at /', page.status === 200 && page.text.includes('id="root"'));
check('/health/live answers', (await call('GET', '/health/live')).status === 200);
const health = await call('GET', '/health');
check('/health is ok (database and redis)', health.status === 200 && health.json?.status === 'ok');

// 2. what the home page offers
const offer = (await call('GET', '/demo')).json;
check('the replay (featured eval run) is ready', typeof offer?.featured?.eval === 'string');
check('the featured demo run is ready', typeof offer?.featured?.demo === 'string');
if (noKey) check('no live model is offered without a key', offer?.live?.available === false);

// 3. the replay: free, read-only
if (typeof offer?.featured?.eval === 'string') {
  const replay = (await call('GET', `/runs/${offer.featured.eval}/overview`)).json;
  check(
    'the replay is the 500-order run',
    (replay?.sources?.ledger?.records ?? 0) >= 400,
    String(replay?.sources?.ledger?.records),
  );
  check('the replay says it is featured (read-only)', replay?.run?.featured === 'eval');
  check('the replay adds up to the paise', replay?.reconciles === true);
  const queue = (await call('GET', `/runs/${offer.featured.eval}/review/queue?limit=5`)).json;
  const waiting = queue?.items?.[0]?.proposalId;
  if (waiting) {
    const denied = await call('POST', `/proposals/${waiting}/approve`, { reviewer: 'smoke' });
    check(
      'approving in the replay is refused',
      denied.status === 403 && denied.json?.error === 'read_only',
      String(denied.status),
    );
  }
}

// 4. a visitor's own run
const started = await call('POST', '/demo/runs', {});
check(
  'POST /demo/runs is accepted',
  started.status === 202 && typeof started.json?.runId === 'string',
  String(started.status),
);
const runId = started.json?.runId;
if (runId) {
  const progress = await untilReady(runId, 'the visitor’s run');
  check('the run reaches ready', progress !== null);
  const overview = (await call('GET', `/runs/${runId}/overview`)).json;
  check(
    'the run has groups, exceptions and proposals',
    (progress?.counts?.groups ?? 0) > 0 &&
      (progress?.counts?.exceptions ?? 0) > 0 &&
      (progress?.counts?.proposals ?? 0) > 0,
  );
  check(
    'the checker refused the planted proposals',
    (progress?.counts?.refused ?? 0) >= 1,
    String(progress?.counts?.refused),
  );
  check('the totals add up', overview?.reconciles === true);

  const queue = (await call('GET', `/runs/${runId}/review/queue?limit=100`)).json;
  const match = first(queue?.items ?? [], (i) => i.verdict === 'MATCH_PROPOSED');
  if (match) {
    const approved = await call('POST', `/proposals/${match.proposalId}/approve`, {
      reviewer: 'smoke test',
    });
    check(
      'a visitor can approve a verified match',
      approved.status === 200,
      String(approved.status),
    );
  } else {
    check('a proposed match is waiting for review', false);
  }

  // 5. what the public demo must refuse
  for (const [what, method, path, body] of [
    [
      'creating a run by hand',
      'POST',
      '/runs',
      { periodStart: '2026-09-01', periodEnd: '2026-09-30' },
    ],
    ['importing a CSV', 'POST', `/runs/${runId}/import/ledger`, {}],
    [
      'importing from Razorpay',
      'POST',
      `/runs/${runId}/import/razorpay`,
      { from: '2026-09-01', to: '2026-09-02' },
    ],
    ['investigating with a model', 'POST', `/runs/${runId}/investigate`, {}],
    ['matching by hand', 'POST', `/runs/${runId}/match`, {}],
  ]) {
    const res = await call(method, path, body);
    check(
      `${what} is switched off`,
      res.status === 403 && res.json?.error === 'disabled_in_demo',
      String(res.status),
    );
  }

  // 6. Reset demo
  const reset = await call('POST', '/demo/reset', { runId });
  check(
    'Reset demo is accepted',
    reset.status === 202 && reset.json?.archived === runId,
    String(reset.status),
  );
  const archived = (await call('GET', `/runs/${runId}/overview`)).json;
  check('the old run is archived', archived?.run?.archived === true);
  if (typeof reset.json?.runId === 'string') {
    check(
      'the fresh run reaches ready',
      (await untilReady(reset.json.runId, 'the fresh run')) !== null,
    );
  }
}

// 7. the agent's state, for the banner
const agent = await call('GET', '/agent/status');
check('/agent/status answers', agent.status === 200 && 'paused' in (agent.json ?? {}));
if (noKey)
  check(
    'the server has no model key (so nothing above used one)',
    agent.json?.configured === false,
  );

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
