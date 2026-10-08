import test from 'node:test';
import assert from 'node:assert/strict';
import { taskTree } from '../src/task-tree.ts';
import { DemoConnection } from '../server/demo.ts';
import { summarize } from '../server/normalize.ts';
import type { ThreadSummary } from '../shared/types.ts';

const base = summarize(new DemoConnection().threads[0], 'one');
const thread = (id: string, parentId: string | null = null, sourceId = 'one'): ThreadSummary => ({ ...base, id, sessionId: parentId || id, key: `${sourceId}:${id}`, sourceId, parentId });
const compare = (a: ThreadSummary, b: ThreadSummary) => a.id.localeCompare(b.id);

test('subagents and grandchildren nest under their task without mixing homes', () => {
  const all = [thread('root'), thread('child', 'root'), thread('grandchild', 'child'), thread('root', null, 'two')];
  const tree = taskTree(all, all, compare);
  assert.equal(tree.length, 2);
  const parent = tree.find(n => n.key === 'one:root')!;
  assert.equal(parent.count, 2);
  assert.equal(parent.children[0].key, 'one:child');
  assert.equal(parent.children[0].children[0].key, 'one:grandchild');
  assert.equal(tree.find(n => n.key === 'two:root')?.children.length, 0);
});

test('searching only a subtask retains the parent context and excludes unrelated siblings', () => {
  const all = [thread('root'), thread('child', 'root'), thread('sibling', 'root')];
  const tree = taskTree(all, [all[1]], compare);
  assert.equal(tree[0].key, 'one:root');
  assert.deepEqual(tree[0].children.map(n => n.key), ['one:child']);
});

test('missing parents and cyclic metadata never promote subagents to indistinguishable root tasks', () => {
  const all = [thread('orphan', 'missing'), thread('cycle-a', 'cycle-b'), thread('cycle-b', 'cycle-a')];
  const tree = taskTree(all, all, compare);
  assert(tree.every(n => n.thread === null));
  assert.equal(tree.flatMap(n => n.children).length, 3);
});
