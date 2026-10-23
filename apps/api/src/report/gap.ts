// The "Ziro gap": rupees still unexplained. An exception carries the amount at stake, but the same
// difference often shows up as several exceptions (an edited ledger amount is raised once for the ledger
// entry and once for its payment, each with the same stake). Adding every stake would count that
// rupee twice. So exceptions that share a record are grouped into one CASE, and a case counts once, at
// its largest stake.
//
//   gap = cases still open + cases awaiting a person's review      (what is not yet settled)
//   explained = cases a person or a proof has resolved             (accounted for; action may be pending)
export type ExceptionStatus = 'open' | 'proposed' | 'resolved' | 'dismissed';

export interface GapItem {
  readonly status: ExceptionStatus;
  /** Signed paise, as the matcher recorded it; only the size matters here. */
  readonly stakePaise: bigint;
  /** The ids of every record the exception is about: its subject and its candidates. */
  readonly records: readonly string[];
  /** Days since the subject record's business date, when known. */
  readonly ageDays?: number | null;
}

export type CaseStatus = 'open' | 'awaiting' | 'explained';

/** Exceptions that share records, counted once. */
export interface Case {
  readonly status: CaseStatus;
  /** The largest stake among the members that decide the status. */
  readonly stakePaise: bigint;
  /** The oldest member's age; null when no member has a known age. */
  readonly ageDays: number | null;
  readonly members: number;
}

export interface Gap {
  /** Cases with at least one exception nobody has looked at. */
  readonly openPaise: bigint;
  /** Cases the agent has proposed an answer for that a person has not yet decided. */
  readonly awaitingPaise: bigint;
  /** openPaise + awaitingPaise: not yet settled. This is the number the goal is to bring to zero. */
  readonly gapPaise: bigint;
  /** Cases that are settled. */
  readonly explainedPaise: bigint;
  readonly cases: { readonly open: number; readonly awaiting: number; readonly explained: number };
}

const size = (v: bigint): bigint => (v < 0n ? -v : v);

/** Groups exceptions into cases by the records they share. Dismissed exceptions belong to no case. */
export function casesOf(items: readonly GapItem[]): Case[] {
  // Union-find over exceptions, joined through the records they share.
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] ?? root;
    for (let node = i; parent[node] !== root;) {
      const next = parent[node] ?? root;
      parent[node] = root;
      node = next;
    }
    return root;
  };
  const owner = new Map<string, number>();
  items.forEach((item, i) => {
    for (const record of item.records) {
      const first = owner.get(record);
      if (first === undefined) owner.set(record, i);
      else {
        const [a, b] = [find(first), find(i)];
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
  });

  const groups = new Map<number, GapItem[]>();
  items.forEach((item, i) => {
    const root = find(i);
    const members = groups.get(root);
    if (members === undefined) groups.set(root, [item]);
    else members.push(item);
  });

  const largest = (members: readonly GapItem[], status: ExceptionStatus): bigint =>
    members
      .filter((m) => m.status === status)
      .reduce((max, m) => (size(m.stakePaise) > max ? size(m.stakePaise) : max), 0n);
  const oldest = (members: readonly GapItem[], status: ExceptionStatus): number | null =>
    members
      .filter((m) => m.status === status)
      .reduce<number | null>(
        (max, m) =>
          m.ageDays === undefined || m.ageDays === null ? max : Math.max(max ?? 0, m.ageDays),
        null,
      );

  const out: Case[] = [];
  for (const members of groups.values()) {
    const decide = (status: ExceptionStatus, as: CaseStatus) =>
      out.push({
        status: as,
        stakePaise: largest(members, status),
        ageDays: oldest(members, status),
        members: members.length,
      });
    if (members.some((m) => m.status === 'open')) decide('open', 'open');
    else if (members.some((m) => m.status === 'proposed')) decide('proposed', 'awaiting');
    else if (members.some((m) => m.status === 'resolved')) decide('resolved', 'explained');
  }
  return out;
}

export function gapOf(items: readonly GapItem[]): Gap {
  let open = 0n;
  let awaiting = 0n;
  let explained = 0n;
  const count = { open: 0, awaiting: 0, explained: 0 };
  for (const c of casesOf(items)) {
    if (c.status === 'open') open += c.stakePaise;
    else if (c.status === 'awaiting') awaiting += c.stakePaise;
    else explained += c.stakePaise;
    count[c.status] += 1;
  }
  return {
    openPaise: open,
    awaitingPaise: awaiting,
    gapPaise: open + awaiting,
    explainedPaise: explained,
    cases: count,
  };
}
