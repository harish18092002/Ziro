// The configurations as AgentRunners. `rules` has none: the rules run alone.
//
//   lite-loop      the lite Gemini model, the model drives the read-only tools (up to LLM_MAX_TOOL_CALLS)
//   lite-single    the lite Gemini model, the harness gathers the evidence and asks once
//   flash-single   the flash Gemini model, single-shot (a small --sample: it is the scarce one)
//   claude-loop    Claude, tool loop      \  only with a funded Anthropic key, so they are never
//   claude-single  Claude, single-shot    /  in the default list
//
// Which model a name means comes from LLM_CHAIN, so no model id is written here: the first Gemini entry is
// "lite", the second "flash", the first Anthropic entry is "claude". Each config runs a router of ONE model:
// no fallback and no escalation, so that every row measures one model and a failure shows up as a failure
// instead of being quietly answered by another model.
import type { ConfigName } from '@ziro/evals';
import { DEFAULT_LIMITS } from '../agent/budget.js';
import { LoopRunner } from '../agent/loop-runner.js';
import { SingleShotRunner } from '../agent/single-shot.js';
import type { AgentRunner, HarnessName } from '../agent/types.js';
import type { Env } from '../config/env.js';
import type { LlmCacheStore } from '../llm/cache.js';
import { buildRouter } from '../llm/factory.js';
import type { ChainEntry } from '../llm/config.js';
import type { RequestLimiter } from '../llm/limiter.js';
import type { LlmRouter } from '../llm/router.js';

export interface Roles {
  readonly lite: ChainEntry | null;
  readonly flash: ChainEntry | null;
  readonly claude: ChainEntry | null;
}

/** Who "lite", "flash" and "claude" are, read off the chain. */
export function rolesOf(chain: readonly ChainEntry[]): Roles {
  const gemini = chain.filter((e) => e.provider === 'gemini');
  return {
    lite: gemini[0] ?? null,
    flash: gemini[1] ?? null,
    claude: chain.find((e) => e.provider === 'anthropic') ?? null,
  };
}

/** The model a config calls, or null when it calls none (or the chain has no such model). */
export function entryFor(config: ConfigName, roles: Roles): ChainEntry | null {
  if (config === 'rules') return null;
  if (config.startsWith('lite')) return roles.lite;
  if (config.startsWith('flash')) return roles.flash;
  return roles.claude;
}

export function harnessOf(config: ConfigName): HarnessName | null {
  if (config === 'rules') return null;
  return config.endsWith('-loop') ? 'loop' : 'single-shot';
}

/** Does a config spend money (a provider that charges), as opposed to free-tier requests? */
export const spendsMoney = (config: ConfigName): boolean => config.startsWith('claude');
/** Does a config call a model at all? */
export const callsModel = (config: ConfigName): boolean => config !== 'rules';

export interface Built {
  readonly runner: AgentRunner | null;
  readonly router: LlmRouter | null;
  /** Why the config cannot run, when it cannot. */
  readonly unavailable: string | null;
}

export interface BuildDeps {
  readonly limiter: RequestLimiter;
  readonly cacheStore: LlmCacheStore;
}

export function buildRunner(config: ConfigName, env: Env, deps: BuildDeps): Built {
  const harness = harnessOf(config);
  if (harness === null) return { runner: null, router: null, unavailable: null };
  const entry = entryFor(config, rolesOf(env.LLM_CHAIN));
  if (entry === null) {
    return {
      runner: null,
      router: null,
      unavailable: `LLM_CHAIN has no model for ${config} (lite and flash are its first and second Gemini entries, claude its first Anthropic entry)`,
    };
  }
  const built = buildRouter({ ...env, LLM_CHAIN: [entry] }, deps);
  if (built.router === null) {
    return {
      runner: null,
      router: null,
      unavailable: built.dropped[0]?.why ?? built.warnings.join('; '),
    };
  }
  const options = {
    router: built.router,
    escalation: false,
    limits: { ...DEFAULT_LIMITS, maxToolCalls: env.LLM_MAX_TOOL_CALLS },
  };
  return {
    runner: harness === 'loop' ? new LoopRunner(options) : new SingleShotRunner(options),
    router: built.router,
    unavailable: null,
  };
}
