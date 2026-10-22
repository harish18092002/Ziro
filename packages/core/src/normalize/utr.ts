// Pulls a bank reference (a UTR) out of a statement narration.
//
// What is and is not known. Lengths are widely documented: a NEFT UTR is 16 characters, an RTGS UTR
// 22, an IMPS reference (RRN) 12 digits. The layout inside a UTR is not documented by RBI or NPCI
// in anything we could find, only by third-party articles that disagree, and one real statement
// shows a 3-letter prefix (RBI2132268474962). So the shape rule is deliberately only this: a prefix
// of 3-5 letters followed by digits, at the documented total length.
//
// Nothing here is a guess dressed up as a fact. Every result says how much to trust it:
//   exact      a well-formed token (or an IMPS RRN)
//   rejoined   the token was split by a space; joining the pieces makes a well-formed one
//   repaired   every wrong character was a look-alike (O/0, I/1, S/5, B/8) in the wrong region, and
//              there is exactly one cheapest reading
//   truncated  a well-formed beginning (10+ characters) of a longer UTR: a fragment, never equal
//              to a full UTR, only usable as a prefix
// Ambiguity (two different candidates of the best kind) yields no UTR at all.
//
// A garble that keeps the token well-formed (two digits swapped) cannot be seen from the narration
// alone; it comes back `exact` and wrong, and surfaces downstream as a UTR mismatch.
//
// The narration is untrusted free text. It is only scanned for tokens made of A-Z and 0-9; nothing
// in it is ever interpreted, and the scan is linear in its length.

export const UTR_QUALITIES = ['exact', 'rejoined', 'repaired', 'truncated'] as const;
export type UtrQuality = (typeof UTR_QUALITIES)[number];

export const UTR_CHANNELS = ['neft', 'rtgs', 'imps', 'upi', 'ach', 'cheque'] as const;
export type UtrChannel = (typeof UTR_CHANNELS)[number];

export type UtrMiss = 'not_a_transfer' | 'no_candidate' | 'ambiguous';

export type UtrExtraction =
  | {
      readonly utr: string;
      readonly quality: UtrQuality;
      readonly channel: UtrChannel | null;
      /** The text as it appeared (uppercased), before any joining or repair. */
      readonly original: string;
    }
  | {
      readonly utr: null;
      readonly quality: null;
      readonly channel: UtrChannel | null;
      readonly reason: UtrMiss;
    };

const MAX_SCAN = 4000;
const NEFT_LENGTH = 16;
const RTGS_LENGTH = 22;
const IFSC_LENGTH = 11;
const MIN_FRAGMENT = 10;
const MAX_REPAIRS = 2;

const CHANNEL_WORD = /\b(NEFT|RTGS|IMPS|UPI|NACH|ACH|CHQ|CHEQUE|CLG)\b/;
const CHANNEL_OF: Readonly<Record<string, UtrChannel>> = {
  NEFT: 'neft',
  RTGS: 'rtgs',
  IMPS: 'imps',
  UPI: 'upi',
  NACH: 'ach',
  ACH: 'ach',
  CHQ: 'cheque',
  CHEQUE: 'cheque',
  CLG: 'cheque',
};
// A UPI payment, a direct debit or a cheque carries no Razorpay settlement reference.
const NOT_TRANSFERS = new Set<UtrChannel>(['upi', 'ach', 'cheque']);

const TOKEN = /[A-Z0-9]+/g;
const WELL_FORMED = /^[A-Z]{3,5}\d+$/;
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const RRN = /^\d{12}$/;
const SPACES = /^[ \t]+$/;

// The look-alikes a human or an OCR step confuses.
const LETTER_FOR_DIGIT: Readonly<Record<string, string>> = {
  '0': 'O',
  '1': 'I',
  '5': 'S',
  '8': 'B',
};
const DIGIT_FOR_LETTER: Readonly<Record<string, string>> = { O: '0', I: '1', S: '5', B: '8' };

interface Token {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

interface Candidate {
  readonly utr: string;
  readonly original: string;
}

const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';
const isLetter = (ch: string): boolean => ch >= 'A' && ch <= 'Z';

/** A complete UTR for this channel: right shape, right length. RTGS needs 22, so 16 there is a fragment. */
function isComplete(text: string, channel: UtrChannel | null): boolean {
  if (!WELL_FORMED.test(text)) return false;
  if (text.length === RTGS_LENGTH) return true;
  return text.length === NEFT_LENGTH && channel !== 'rtgs';
}

/** A well-formed beginning of a longer UTR. An IFSC (bank branch code) is not one, though it looks like it. */
function isFragment(text: string): boolean {
  return (
    WELL_FORMED.test(text) &&
    text.length >= MIN_FRAGMENT &&
    text.length < RTGS_LENGTH &&
    !(text.length === IFSC_LENGTH && IFSC.test(text))
  );
}

/**
 * Reads a token whose characters are in the wrong region (a digit among the letters or a letter
 * among the digits) as the cheapest well-formed token, if there is exactly one such reading.
 */
function repair(text: string): string | null {
  if (text.length !== NEFT_LENGTH && text.length !== RTGS_LENGTH) return null;
  let best: { edits: number; results: Set<string> } | null = null;
  for (const letters of [3, 4, 5]) {
    let out = '';
    let edits = 0;
    let possible = true;
    for (let i = 0; i < text.length && possible; i++) {
      const ch = text.charAt(i);
      if (i < letters) {
        if (isLetter(ch)) out += ch;
        else if (LETTER_FOR_DIGIT[ch] !== undefined) {
          out += LETTER_FOR_DIGIT[ch];
          edits += 1;
        } else possible = false;
      } else if (isDigit(ch)) out += ch;
      else if (DIGIT_FOR_LETTER[ch] !== undefined) {
        out += DIGIT_FOR_LETTER[ch];
        edits += 1;
      } else possible = false;
    }
    if (!possible || edits === 0 || edits > MAX_REPAIRS) continue;
    if (best === null || edits < best.edits) best = { edits, results: new Set([out]) };
    else if (edits === best.edits) best.results.add(out);
  }
  return best !== null && best.results.size === 1 ? ([...best.results][0] ?? null) : null;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(TOKEN)) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

type Kind = 'exact' | 'rejoined' | 'repaired' | 'truncated' | 'rrn';
const PRIORITY: readonly Kind[] = ['exact', 'rejoined', 'repaired', 'truncated', 'rrn'];

function collect(
  text: string,
  tokens: readonly Token[],
  channel: UtrChannel | null,
): Record<Kind, Candidate[]> {
  const found: Record<Kind, Candidate[]> = {
    exact: [],
    rejoined: [],
    repaired: [],
    truncated: [],
    rrn: [],
  };
  tokens.forEach((token, index) => {
    const own = token.text;
    if (isComplete(own, channel)) {
      found.exact.push({ utr: own, original: own });
      return;
    }
    const fixed = repair(own);
    if (fixed !== null) found.repaired.push({ utr: fixed, original: own });
    else if (isFragment(own)) found.truncated.push({ utr: own, original: own });
    else if (channel === 'imps' && RRN.test(own)) found.rrn.push({ utr: own, original: own });

    // A UTR split by a space: this token and the next, with only blanks between them.
    const following = tokens[index + 1];
    if (following !== undefined && SPACES.test(text.slice(token.end, following.start))) {
      const joined = own + following.text;
      if (!isComplete(following.text, channel) && isComplete(joined, channel)) {
        found.rejoined.push({
          utr: joined,
          original: text.slice(token.start, following.end),
        });
      }
    }
  });
  return found;
}

export function extractUtr(narration: string): UtrExtraction {
  const text = narration.slice(0, MAX_SCAN).normalize('NFKC').toUpperCase();
  const word = CHANNEL_WORD.exec(text)?.[1];
  const channel = word === undefined ? null : (CHANNEL_OF[word] ?? null);
  if (channel !== null && NOT_TRANSFERS.has(channel)) {
    return { utr: null, quality: null, channel, reason: 'not_a_transfer' };
  }

  const found = collect(text, tokenize(text), channel);
  for (const kind of PRIORITY) {
    const candidates = found[kind];
    if (candidates.length === 0) continue;
    const distinct = new Set(candidates.map((c) => c.utr));
    if (distinct.size > 1) return { utr: null, quality: null, channel, reason: 'ambiguous' };
    const first = candidates[0] as Candidate;
    return {
      utr: first.utr,
      quality: kind === 'rrn' ? 'exact' : kind,
      channel,
      original: first.original,
    };
  }
  return { utr: null, quality: null, channel, reason: 'no_candidate' };
}
