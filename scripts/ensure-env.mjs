// Runs before `npm run dev`: a fresh clone has no .env, and the API (rightly) refuses to boot
// without one. .env.example holds local-only defaults and no secrets; .env itself is git-ignored.
import { copyFileSync, existsSync } from 'node:fs';

if (!existsSync('.env')) {
  copyFileSync('.env.example', '.env');
  console.log('[predev] created .env from .env.example (local defaults, no secrets)');
}
