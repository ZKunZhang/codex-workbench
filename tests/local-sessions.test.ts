import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSessions, parseSessionOwners } from '../server/local-sessions.ts';
import { Workbench } from '../server/workbench.ts';
import { StateStore } from '../server/state.ts';
import { DemoConnection } from '../server/demo.ts';
import { summarize } from '../server/normalize.ts';
import type { Thread } from '../server/protocol/v2/Thread.ts';

const id = '01a1194b-230b-74c0-a7b1-a32f7f932a2a';
const childId = '01a0bcd6-9e39-7d01-bfcb-b38ae5ad6185';
async function until(predicate: () => boolean) {
  const end = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); }
}

test('live ownership is scoped by home and requires a Codex process with an open writer lock', async () => {
  const output = `p42\nccodex\nn/home/one/thread-writer-locks/${id}.lock\np43\nccodex\nn/home/two/thread-writer-locks/${id}.lock\np44\ncnode\nn/home/one/thread-writer-locks/${childId}.lock\np45\nccodex\nn/home/one/sessions/rollout-${childId}.jsonl\n`;
  const homes = parseSessionOwners(output);
  assert.equal(homes.get('/home/one')?.get(id), 42);
  assert.equal(homes.get('/home/two')?.get(id), 43);
  assert(!homes.get('/home/one')?.has(childId));
  const inspector = new LocalSessions(async () => output);
  assert.deepEqual([...await inspector.owners('/home/one')], [[id, 42]]);
  assert.equal((await inspector.owners('/home/absent')).size, 0);
  assert.deepEqual(await inspector.homes(), ['/home/one', '/home/two']);
});

test('inventory discovers nested legacy rollouts and excludes archives, unrelated files and symlink loops', async t => {
  const home = await mkdtemp(join(tmpdir(), 'workbench-inventory-'));
  await mkdir(join(home, 'sessions/2026/10/08'), { recursive: true });
  await mkdir(join(home, 'archived_sessions'));
  await writeFile(join(home, `sessions/2026/10/08/rollout-time-${id}.jsonl`), '{}');
  await writeFile(join(home, `sessions/notes-${childId}.jsonl`), '{}');
  await writeFile(join(home, `archived_sessions/rollout-time-${childId}.jsonl`), '{}');
  await symlink(home, join(home, 'sessions/loop'));
  const inspector = new LocalSessions(); t.after(() => inspector.close());
  assert.deepEqual([...await inspector.inventory(home)], [id]);
});

test('normalization preserves session identity separately from a child thread ID', () => {
  const thread = new DemoConnection().threads[0];
  const child = { ...thread, id: childId, sessionId: id, parentThreadId: null, source: { subAgent: { thread_spawn: { parent_thread_id: id } } } } as Thread;
  const result = summarize(child, 'second', false, null, '/custom/home');
  assert.equal(result.id, childId);
  assert.equal(result.sessionId, id);
  assert.equal(result.parentId, id);
  assert.equal(result.codexHome, '/custom/home');
});

async function externalFixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-external-'));
  const store = new StateStore(join(dir, 'state.json'));
  const client = new DemoConnection();
  const original = client.call.bind(client);
  const legacy = { ...client.threads.find(t => t.id === 'task-history')!, id: childId, sessionId: id, parentThreadId: id };
  client.threads.push(legacy);
  const calls: string[] = [];
  client.call = async (method, params: any) => {
    calls.push(`${method}:${params?.threadId || ''}`);
    const result = await original(method, params);
    if (method === 'thread/list') result.data = result.data.filter((t: Thread) => t.id !== childId);
    return result;
  };
  const owners = new Map([['task-history', 4242]]);
  const inspection = { inventory: async () => new Set(['task-history', childId]), owners: async () => owners };
  const workbench = new Workbench([{ id: 'custom', name: 'Custom', codexHome: '/custom/home' }], store, false, () => client, inspection);
  workbench.start(); t.after(() => workbench.stop());
  await until(() => !!workbench.snapshot().sources[0].lastSync);
  return { workbench, client, calls, owners, inspection, store };
}

test('live external sessions and missing legacy sessions are shown without resuming either', async t => {
  const { workbench, client, calls, owners } = await externalFixture(t);
  let snapshot = workbench.snapshot();
  assert.equal(snapshot.threads.length, 6);
  assert.equal(snapshot.sources[0].codexHome, '/custom/home');
  assert(snapshot.threads.every(t => t.codexHome === '/custom/home'));
  assert.equal(snapshot.threads.find(t => t.id === 'task-history')?.externalPid, 4242);
  assert.equal(snapshot.threads.find(t => t.id === 'task-history')?.state, 'idle');
  client.turns.get('task-history')![0].status = 'inProgress';
  await workbench.older('custom');
  await workbench.detail('custom', 'task-history');
  assert.equal(workbench.snapshot().threads.find(t => t.id === 'task-history')?.state, 'running');
  assert(!calls.includes('thread/resume:task-history'));
  assert(!calls.includes(`thread/resume:${childId}`));
  assert(workbench.snapshot().threads.some(t => t.id === childId));
  owners.clear(); await workbench.older('custom');
  snapshot = workbench.snapshot();
  assert.equal(snapshot.threads.find(t => t.id === 'task-history')?.externalPid, null);
  assert.equal(snapshot.threads.find(t => t.id === 'task-history')?.state, 'history');
});

test('external owners prevent resume, sending, stopping and deletion, including unlisted children', async t => {
  const { workbench, owners, client } = await externalFixture(t);
  await assert.rejects(workbench.resume('custom', 'task-history'), /独立终端/);
  await assert.rejects(workbench.message('custom', 'task-history', 'hello', 'queue', 'external-message-1'), /独立终端/);
  await assert.rejects(workbench.interrupt('custom', 'task-history', 'turn-task-history'), /独立终端/);
  await assert.rejects(workbench.deleteThread('custom', 'task-history'), /独立终端/);
  owners.clear(); owners.set(childId, 4343);
  client.threads.find(t => t.id === childId)!.parentThreadId = 'task-history';
  client.notify('thread/started', { thread: client.threads.find(t => t.id === childId) });
  await assert.rejects(workbench.deleteThread('custom', 'task-history'), /独立终端/);
  owners.clear(); owners.set('task-idle', 4444);
  await workbench.resume('custom', 'task-idle'); // Owned by the connected service.
});

test('terminal-owned sessions can rename metadata without taking over execution', async t => {
  const { workbench, calls } = await externalFixture(t);
  calls.length = 0;
  const renamed = await workbench.rename('custom', 'task-history', '终端任务的新标题');
  assert.equal(renamed.externalPid, 4242);
  assert.equal(renamed.state, 'idle');
  assert.equal(renamed.title, '终端任务的新标题');
  assert.deepEqual(calls, ['thread/read:task-history', 'thread/name/set:task-history']);
});

test('inspection failures stay visible and block an unsafe resume', async t => {
  const { workbench, inspection } = await externalFixture(t);
  inspection.owners = async () => { throw new Error('lsof unavailable'); };
  await workbench.older('custom');
  assert.match(workbench.snapshot().sources[0].localWarning!, /lsof unavailable/);
  await assert.rejects(workbench.resume('custom', 'task-history'), /lsof unavailable/);
});

test('handoff resumes the original session after its terminal exits, clears ownership and accepts messages', async t => {
  const { workbench, owners, store } = await externalFixture(t);
  await assert.rejects(workbench.resume('custom', 'task-history'), /独立终端/);
  owners.clear();
  const thread = await workbench.resume('custom', 'task-history');
  assert.equal(thread?.id, 'task-history');
  assert.equal(thread?.externalPid, null);
  assert.equal(thread?.state, 'idle');
  await workbench.message('custom', 'task-history', 'continue same session', 'send', 'handoff-message-01');
  assert.equal(store.data.audit[0].outcome, 'sent');
});

test('loaded sessions clear stale external ownership even when process inspection fails', async t => {
  const { workbench, client, inspection } = await externalFixture(t);
  client.threads.find(t => t.id === 'task-history')!.status = { type: 'idle' };
  inspection.owners = async () => { throw new Error('lsof temporarily unavailable'); };
  await workbench.older('custom');
  assert.equal(workbench.snapshot().threads.find(t => t.id === 'task-history')?.externalPid, null);
  assert.equal(workbench.snapshot().threads.find(t => t.id === 'task-history')?.state, 'idle');
});

test('active homes are discovered once without overwriting explicitly configured sources', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-discovery-'));
  const calls: string[] = [];
  const inspector = { homes: async () => ['/custom/one', '/custom/two', '/custom/two'], inventory: async () => new Set<string>(), owners: async () => new Map<string, number>() };
  const workbench = new Workbench([{ id: 'custom', name: 'My Config', codexHome: '/custom/one' }], new StateStore(join(dir, 'state.json')), false, config => { calls.push(config.codexHome!); return new DemoConnection(); }, inspector);
  workbench.start(); t.after(() => workbench.stop());
  await until(() => workbench.snapshot().sources.length === 2 && workbench.snapshot().sources.every(s => !!s.lastSync));
  assert.deepEqual(calls, ['/custom/one', '/custom/two']);
  assert.equal(workbench.snapshot().sources[0].name, 'My Config');
  assert.equal(workbench.snapshot().sources[1].terminalAddress, 'unix:///custom/two/app-server-control/app-server-control.sock');
});
