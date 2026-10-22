// Free text (ledger memos, bank narrations) is untrusted data (CLAUDE.md §4.5). Ziro never edits
// it, but it refuses a few characters outright: NUL cannot be stored in a Postgres text column at
// all, other control characters have no business in a memo, and bidirectional overrides make text
// display differently from what it says (a spoofing trick in any UI that later shows it).

const ALLOWED_CONTROLS = new Set([0x09, 0x0a, 0x0d]); // tab, line feed, carriage return

function describe(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** The first character that must not appear in free text, as `U+XXXX`, or null if the text is fine. */
export function findForbiddenCharacter(text: string): string | null {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20) {
      if (!ALLOWED_CONTROLS.has(code)) return describe(code);
    } else if (code >= 0x7f && code <= 0x9f) {
      return describe(code); // DEL and the C1 controls
    } else if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) {
      return describe(code); // bidirectional embeddings, overrides and isolates
    } else if (code === 0x2028 || code === 0x2029) {
      return describe(code); // line and paragraph separators
    }
  }
  return null;
}
