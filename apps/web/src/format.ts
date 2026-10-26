import { formatRupees, paise } from '@ziro/core/money';
import type { AgentStatus, ModelStatus, Overview, RazorpayStatus } from './api';

/** Integer paise (a digit string from the API) as rupees with Indian grouping: "₹1,23,456.50". */
export function inr(paiseText: string | null | undefined): string {
  if (paiseText === null || paiseText === undefined || !/^-?\d+$/.test(paiseText)) return '–';
  return formatRupees(paise(BigInt(paiseText)), { symbol: true });
}

export const percent = (share: number | null | undefined): string =>
  share === null || share === undefined ? '–' : `${(share * 100).toFixed(1)}%`;

export const dollars = (usd: string): string => `$${Number(usd).toFixed(4)}`;

export const words = (code: string): string => code.toLowerCase().replaceAll('_', ' ');

/** `LEDGER_WITHOUT_PAYMENT` as "Ledger without payment": a label, in sentence case. */
/** Short words that stay in capitals inside a label. */
const ACRONYMS = ['utr', 'gst', 'upi', 'neft', 'rtgs', 'imps', 'ist', 'utc', 'emi'];

/** `UTR_MISSING_OR_GARBLED` as "UTR missing or garbled": a label in sentence case, acronyms kept. */
export const sentence = (code: string): string => {
  const w = words(code)
    .split(' ')
    .map((word) => (ACRONYMS.includes(word) ? word.toUpperCase() : word))
    .join(' ');
  return w.charAt(0).toUpperCase() + w.slice(1);
};

/** An age bucket such as "8-30 days" with a proper en dash: "8–30 days". */
export const range = (text: string): string => text.replace(/(\d)\s*-\s*(\d)/g, '$1–$2');

export type Route =
  | { page: 'home' }
  | { page: 'test' }
  | { page: 'run'; runId: string; tab: Tab; itemId: string | null };
export type Tab = 'summary' | 'exceptions' | 'audit' | 'downloads';
const TABS: readonly Tab[] = ['summary', 'exceptions', 'audit', 'downloads'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `#/test` is the test-account workspace (`#/new` was its first name and still works);
 * `#/runs/<uuid>/<tab>[/<exception uuid>]` a run; anything else the home page.
 */
export function parseHash(hash: string): Route {
  const [, root, runId, tab, itemId] = hash.replace(/^#/, '').split('/');
  if ((root === 'test' || root === 'new') && (runId === undefined || runId === '')) {
    return { page: 'test' };
  }
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
 * A Razorpay key id with its middle hidden: "rzp_test_••••4Dfq". The key id is public (Checkout needs it),
 * but a screenshot does not need all of it, and the last four still tell two accounts apart.
 */
export function maskKeyId(keyId: string): string {
  const prefix = /^rzp_(test|live)_/.exec(keyId)?.[0] ?? '';
  const rest = keyId.slice(prefix.length);
  return `${prefix}••••${rest.length > 4 ? rest.slice(-4) : ''}`;
}

/** The header chip: where the data on screen comes from. Only the masked public key id is ever shown. */
export function dataChip(razorpay: RazorpayStatus | null): string {
  if (razorpay?.source === 'testmode' && razorpay.ready) {
    return `Razorpay test mode${razorpay.keyId ? ` · ${maskKeyId(razorpay.keyId)}` : ''}`;
  }
  return 'Razorpay test mode · synthetic data';
}

/** `07:00 UTC` from an ISO time. */
const utcClock = (iso: string): string => `${iso.slice(11, 16)} UTC`;

/** The earliest time any model that is out comes back, or null when none says. */
function nextReturn(status: AgentStatus): string | null {
  const times = status.models
    .filter((m) => m.state !== 'ok' && m.until !== null)
    .map((m) => m.until as string)
    .sort();
  return times[0] ?? null;
}

const STATE_WORDS: Record<ModelStatus['state'], string> = {
  ok: 'working',
  cooling: 'cooling down',
  quota_exhausted: 'out of quota for today',
  disabled: 'switched off',
};

/**
 * The banner shown on every page while the agent cannot work as configured, or null. In every case the rules
 * keep running and nothing is lost: an exception the agent could not take goes to a person with the reason.
 *   paused      an operator switch (the kill switch, the daily budget)
 *   exhausted   no model in the chain can answer: "AI quota exhausted"
 *   falling back  some models are out and another is answering
 */
export function agentBanner(status: AgentStatus | null): string | null {
  if (status === null) return null;
  if (status.paused !== null) {
    const { message, until } = status.paused;
    const retry = until === null ? '' : ` It will try again after ${utcClock(until)}.`;
    return `The agent is paused: ${message}. Matching still runs and every exception stays open; nothing is lost.${retry}`;
  }
  if (status.exhausted) {
    const back = nextReturn(status);
    const who = status.models.map((m) => `${m.id} ${STATE_WORDS[m.state]}`).join('; ');
    return `AI quota exhausted — rules still ran. No model can answer right now (${who}). Matching and review still work, and new exceptions go to a person with that reason.${back === null ? '' : ` The first model is back after ${utcClock(back)}.`}`;
  }
  const out = status.models.filter((m) => m.state !== 'ok');
  if (out.length > 0) {
    const who = out.map((m) => `${m.id} is ${STATE_WORDS[m.state]}`).join('; ');
    return `Running on a fallback model: ${who}.`;
  }
  return null;
}

/** A note for every page while model answers come from a record instead of a model, or null. */
export function replayNote(status: AgentStatus | null): string | null {
  return status?.cache === 'replay'
    ? 'Replay mode: model answers come from a recorded run. Nothing is being asked of a model, and runs made now are labelled as replays.'
    : null;
}

/** "2 investigations were handed to a person (1 × the model API did not answer, 1 × ...)", or null for none. */
export function failureSentence(f: Overview['failures']): string | null {
  if (f.handedToAPerson === 0) return null;
  const n = f.handedToAPerson;
  const parts = f.byReason.map((r) => `${r.count} × ${r.label}`).join(', ');
  return `${n} investigation${n === 1 ? ' was' : 's were'} handed to a person without a conclusion (${parts}).`;
}
