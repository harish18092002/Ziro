import { formatRupees, paise } from '@ziro/core/money';
import type { AgentStatus, Overview } from './api';

/** Integer paise (a digit string from the API) as rupees with Indian grouping: "₹1,23,456.50". */
export function inr(paiseText: string | null | undefined): string {
  if (paiseText === null || paiseText === undefined || !/^-?\d+$/.test(paiseText)) return '–';
  return formatRupees(paise(BigInt(paiseText)), { symbol: true });
}

export const percent = (share: number | null | undefined): string =>
  share === null || share === undefined ? '–' : `${(share * 100).toFixed(1)}%`;

export const dollars = (usd: string): string => `$${Number(usd).toFixed(4)}`;

export const words = (code: string): string => code.toLowerCase().replaceAll('_', ' ');

export type Route =
  { page: 'home' } | { page: 'run'; runId: string; tab: Tab; itemId: string | null };
export type Tab = 'summary' | 'exceptions' | 'audit' | 'downloads';
const TABS: readonly Tab[] = ['summary', 'exceptions', 'audit', 'downloads'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `#/runs/<uuid>/<tab>[/<exception uuid>]`; anything else is the home page. */
export function parseHash(hash: string): Route {
  const [, root, runId, tab, itemId] = hash.replace(/^#/, '').split('/');
  if (root !== 'runs' || runId === undefined || !UUID.test(runId)) return { page: 'home' };
  const chosen = TABS.find((t) => t === tab) ?? 'summary';
  return {
    page: 'run',
    runId,
    tab: chosen,
    itemId: itemId !== undefined && UUID.test(itemId) ? itemId : null,
  };
}

export const linkTo = (runId: string, tab: Tab = 'summary', itemId?: string): string =>
  `#/runs/${runId}/${tab}${itemId ? `/${itemId}` : ''}`;

/**
 * The banner shown on every page while the agent is paused, or null. The rules keep running and nothing
 * is lost: the exceptions stay open until the agent can take them.
 */
export function agentBanner(status: AgentStatus | null): string | null {
  if (status === null || status.paused === null) return null;
  const { message, until } = status.paused;
  const retry = until === null ? '' : ` It will try again after ${until.slice(11, 16)} UTC.`;
  return `The agent is paused: ${message}. Matching still runs and every exception stays open; nothing is lost.${retry}`;
}

/** "2 investigations were handed to a person (1 × the model API did not answer, 1 × ...)", or null for none. */
export function failureSentence(f: Overview['failures']): string | null {
  if (f.handedToAPerson === 0) return null;
  const n = f.handedToAPerson;
  const parts = f.byReason.map((r) => `${r.count} × ${r.label}`).join(', ');
  return `${n} investigation${n === 1 ? ' was' : 's were'} handed to a person without a conclusion (${parts}).`;
}
