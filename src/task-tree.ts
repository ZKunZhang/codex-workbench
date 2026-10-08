import type { ThreadSummary } from '../shared/types.ts';

export interface TaskNode { key: string; thread: ThreadSummary | null; parentId?: string; children: TaskNode[]; count: number }

// Keep ancestors when a search or status filter matches only a child, and keep
// source IDs in every key so identical session IDs from different homes never mix.
export function taskTree(all: ThreadSummary[], matches: ThreadSummary[], compare: (a: ThreadSummary, b: ThreadSummary) => number): TaskNode[] {
  const lookup = new Map(all.map(thread => [thread.key, thread]));
  const included = new Set(matches.map(thread => thread.key));
  for (const match of matches) {
    const seen = new Set([match.key]);
    let thread = match;
    while (thread.parentId) {
      const parent = lookup.get(`${thread.sourceId}:${thread.parentId}`);
      if (!parent || seen.has(parent.key)) break;
      included.add(parent.key); seen.add(parent.key); thread = parent;
    }
  }
  const nodes = new Map([...included].map(key => [key, { key, thread: lookup.get(key)!, children: [], count: 0 } as TaskNode]));
  const roots: TaskNode[] = [];
  const orphans = new Map<string, TaskNode>();
  for (const node of nodes.values()) {
    const thread = node.thread!;
    if (!thread.parentId) { roots.push(node); continue; }
    const parentKey = `${thread.sourceId}:${thread.parentId}`;
    const seen = new Set([node.key]);
    let ancestor = nodes.get(parentKey);
    let cycle = false;
    while (ancestor) {
      if (seen.has(ancestor.key)) { cycle = true; break; }
      seen.add(ancestor.key);
      ancestor = ancestor.thread?.parentId ? nodes.get(`${ancestor.thread.sourceId}:${ancestor.thread.parentId}`) : undefined;
    }
    if (nodes.has(parentKey) && !cycle) nodes.get(parentKey)!.children.push(node);
    else {
      if (!orphans.has(parentKey)) { const group = { key: `missing:${parentKey}`, parentId: thread.parentId, thread: null, children: [], count: 0 }; orphans.set(parentKey, group); roots.push(group); }
      orphans.get(parentKey)!.children.push(node);
    }
  }
  const sort = (siblings: TaskNode[]): ThreadSummary | null => {
    const best = new Map<TaskNode, ThreadSummary>();
    for (const node of siblings) {
      const child = sort(node.children);
      node.count = node.children.reduce((sum, c) => sum + 1 + c.count, 0);
      const thread = node.thread;
      if (thread || child) best.set(node, !thread ? child! : child && compare(child, thread) < 0 ? child : thread);
    }
    siblings.sort((a, b) => compare(best.get(a)!, best.get(b)!));
    return siblings.length ? best.get(siblings[0])! : null;
  };
  sort(roots);
  return roots;
}
