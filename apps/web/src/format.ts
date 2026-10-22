import { formatRupees, paise } from '@ziro/core/money';

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
