// Runs the gated full-size stress test: ~100k ledger rows and ~100k bank lines, every invariant
// checked on the written files. Slow and memory-hungry, so it is opt-in (`npm run test:stress`).
// The env var is set here because `STRESS=1 vitest ...` does not work in Windows cmd.exe.
import { spawnSync } from 'node:child_process';

const result = spawnSync(
  'npx',
  ['vitest', 'run', 'src/invariants.test.ts', '-t', 'full stress preset'],
  {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, STRESS: '1', NODE_OPTIONS: '--max-old-space-size=8192' },
  },
);
process.exit(result.status ?? 1);
