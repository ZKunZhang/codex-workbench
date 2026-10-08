import { equalData } from '../shared/equality.ts';
import type { Snapshot, ThreadDetail } from '../shared/types.ts';

function reuseRows<T>(previous: T[], next: T[], key: (row: T) => string): T[] {
  const lookup = new Map(previous.map(row => [key(row), row]));
  const rows = next.map(row => {
    const old = lookup.get(key(row));
    return old && equalData(old, row) ? old : row;
  });
  return rows.length === previous.length && rows.every((row, i) => row === previous[i]) ? previous : rows;
}

// Keep unchanged references across JSON responses so memoized rows actually
// skip work. A revision-only notification needs no React commit at all.
export function reconcileSnapshot(previous: Snapshot, next: Snapshot): Snapshot {
  const sources = reuseRows(previous.sources, next.sources, row => row.id);
  const threads = reuseRows(previous.threads, next.threads, row => row.key);
  const pending = reuseRows(previous.pending, next.pending, row => row.key);
  const queue = reuseRows(previous.queue, next.queue, row => row.id);
  const audit = reuseRows(previous.audit, next.audit, row => row.id);
  return sources === previous.sources && threads === previous.threads && pending === previous.pending && queue === previous.queue && audit === previous.audit && next.demo === previous.demo
    ? previous : { ...next, sources, threads, pending, queue, audit };
}

export function reconcileDetail(previous: ThreadDetail | null, next: ThreadDetail): ThreadDetail {
  const bounded = { ...next, items: next.items.slice(-60) };
  if (!previous || previous.thread.key !== next.thread.key) return bounded;
  const items = reuseRows(previous.items, bounded.items, row => `${row.turnId}:${row.id}`);
  const turns = reuseRows(previous.turns, next.turns, row => row.id);
  const thread = equalData(previous.thread, next.thread) ? previous.thread : next.thread;
  return items === previous.items && turns === previous.turns && thread === previous.thread && next.nextCursor === previous.nextCursor && next.warning === previous.warning
    ? previous : { ...bounded, items, turns, thread };
}
