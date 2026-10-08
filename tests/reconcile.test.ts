import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileDetail, reconcileSnapshot } from '../src/reconcile.ts';
import type { Snapshot, ThreadDetail, ThreadSummary } from '../shared/types.ts';

const thread = (key: string): ThreadSummary => ({ key, id: key, sourceId: 'source', sessionId: key, title: key, preview: '', cwd: '/test', codexHome: '/codex', externalPid: null, state: 'idle', updatedAt: 1, createdAt: 1, parentId: null, model: null, branch: null, subscribed: true, lastActivity: null });
const snapshot = (): Snapshot => ({ sources: [{ id: 'source', name: 'Source', codexHome: '/codex', connected: true, error: null, localWarning: null, version: null, lastSync: 1, hasMore: false, syncing: false }], threads: [thread('parent'), { ...thread('child'), parentId: 'parent' }], pending: [], queue: [], audit: [], revision: 1, demo: true });

test('snapshot reconciliation retains unchanged rows across time updates, reordering and removal', () => {
  const before = snapshot();
  const unchanged = structuredClone(before); unchanged.revision++;
  assert.equal(reconcileSnapshot(before, unchanged), before);
  const heartbeat = structuredClone(before); heartbeat.sources[0].lastSync = 2;
  const synced = reconcileSnapshot(before, heartbeat);
  assert.equal(synced.threads, before.threads);
  assert.equal(synced.pending, before.pending);
  assert.notEqual(synced.sources, before.sources);
  const changed = structuredClone(before); changed.threads[1].state = 'approval'; changed.threads.reverse();
  const next = reconcileSnapshot(before, changed);
  assert.equal(next.threads[1], before.threads[0]);
  assert.equal(next.threads[0].state, 'approval');
  assert.equal(next.threads[0].parentId, 'parent');
  assert.equal(before.threads[1].state, 'idle');
  assert.deepEqual(reconcileSnapshot(next, { ...changed, threads: [changed.threads[0]] }).threads.map(row => row.key), ['child']);
});

test('approval contents, connection state, queue changes and audit remain observable', () => {
  const before = snapshot();
  before.pending = [{ key: 'request', sourceId: 'source', threadId: 'parent', turnId: null, method: 'input', kind: 'input', title: 'Confirm', description: '', receivedAt: 1, answering: false, questions: [{ id: 'q', header: 'Choice', question: 'Choose', isSecret: false, options: [{ label: 'A', description: 'First' }] }] }];
  before.queue = [{ id: 'queue', sourceId: 'source', threadId: 'parent', text: 'Next', createdAt: 1, status: 'queued' }];
  assert.equal(reconcileSnapshot(before, structuredClone(before)), before);
  const changed = structuredClone(before);
  changed.pending[0].questions![0].options![0].description = 'Updated';
  changed.sources[0].connected = false;
  changed.queue[0].status = 'failed';
  changed.audit.push({ id: 'audit', at: 1, sourceId: 'source', threadId: 'parent', action: 'send', outcome: 'failed', message: 'Offline' });
  const next = reconcileSnapshot(before, changed);
  assert.deepEqual(next, changed);
  assert.notEqual(next.pending[0], before.pending[0]);
  assert.equal(next.threads, before.threads);
});

test('unchanged details retain item references; streamed edits, warnings and pagination still update', () => {
  const before: ThreadDetail = { thread: thread('parent'), turns: [], items: [{ id: 'one', turnId: 'turn', type: 'agentMessage', title: 'Codex', text: 'Hello' }, { id: 'two', turnId: 'turn', type: 'commandExecution', title: 'Command', text: 'test', status: 'inProgress' }], warning: null, nextCursor: 'older' };
  assert.equal(reconcileDetail(before, structuredClone(before)), before);
  const changed = structuredClone(before); changed.items[1].status = 'completed'; changed.items[1].detail = 'done'; changed.warning = 'warning'; changed.nextCursor = null;
  const next = reconcileDetail(before, changed);
  assert.equal(next.items[0], before.items[0]);
  assert.notEqual(next.items[1], before.items[1]);
  assert.deepEqual(next, changed);
  const another = reconcileDetail(before, { ...changed, thread: thread('other'), items: Array.from({ length: 100 }, (_, i) => ({ ...changed.items[0], id: String(i) })) });
  assert.equal(another.items.length, 60);
  assert.equal(another.thread.key, 'other');
});
