import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../server/state.ts';
import { Workbench } from '../server/workbench.ts';
import { DemoConnection } from '../server/demo.ts';
import { RpcError } from '../server/rpc.ts';
import { approvalResponse, pendingRequest, runtimeState, timeline } from '../server/normalize.ts';
import { trustedRequest } from '../server/http.ts';
import { loadSources } from '../server/sources.ts';

async function until(predicate: () => boolean, message = 'condition timed out') {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(message); await new Promise(r => setTimeout(r, 10)); }
}
async function fixture(t: test.TestContext, client = new DemoConnection(), expected = 5) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-workbench-test-'));
  const store = new StateStore(join(dir, 'state.json')); await store.load();
  const workbench = new Workbench([{ id: 'demo', name: 'Demo' }], store, true, () => client);
  workbench.start(); t.after(() => workbench.stop());
  await until(() => workbench.snapshot().threads.length === expected && !!workbench.snapshot().sources[0].lastSync);
  return { workbench, client, store, dir };
}

test('runtime state separates historical sessions, approvals and disconnected sources', () => {
  assert.equal(runtimeState({ type: 'notLoaded' }), 'history');
  assert.equal(runtimeState({ type: 'idle' }), 'idle');
  assert.equal(runtimeState({ type: 'active', activeFlags: ['waitingOnApproval'] }), 'approval');
  assert.equal(runtimeState({ type: 'active', activeFlags: ['waitingOnUserInput'] }), 'input');
  assert.equal(runtimeState({ type: 'active', activeFlags: [] }, false), 'unknown');
});

test('idle detach preserves history, pauses queues, survives refresh and restart, and resumes only on request', async t => {
  const { workbench, client, store, dir } = await fixture(t);
  store.data.queue.push({ id: 'queued-before-exit', sourceId: 'demo', threadId: 'task-idle', text: 'later', createdAt: Date.now(), status: 'queued' });
  const original = client.call.bind(client);
  const calls: string[] = [];
  client.call = async (method, params: any) => { calls.push(`${method}:${params?.threadId || ''}`); return original(method, params); };
  const detached = await workbench.detach('demo', 'task-idle');
  assert.equal(detached.detached, true); assert.equal(detached.subscribed, false);
  assert.equal(detached.state, 'idle'); // Unsubscribe does not imply server unload.
  assert.equal(store.data.queue[0].status, 'failed');
  await workbench.older('demo');
  assert(!calls.includes('thread/resume:task-idle'));
  assert(!calls.includes('thread/delete:task-idle'));
  assert(!calls.includes('turn/interrupt:task-idle'));
  assert((await workbench.detail('demo', 'task-idle')).items.length > 0);
  await assert.rejects(workbench.message('demo', 'task-idle', 'hello', 'send', 'detached-send-01'), /先重新接入/);
  workbench.stop();
  const reloaded = new StateStore(join(dir, 'state.json')); await reloaded.load();
  const nextClient = new DemoConnection();
  const next = new Workbench([{ id: 'demo', name: 'Demo' }], reloaded, true, () => nextClient);
  next.start(); t.after(() => next.stop());
  await until(() => !!next.snapshot().sources[0].lastSync);
  assert.equal(next.snapshot().threads.find(thread => thread.id === 'task-idle')!.subscribed, false);
  assert.equal(next.snapshot().threads.find(thread => thread.id === 'task-idle')!.detached, true);
  const resumed = await next.resume('demo', 'task-idle');
  assert.equal(resumed?.detached, false); assert.equal(resumed?.subscribed, true);
  assert.deepEqual(reloaded.data.detached, []);
});

test('detach rejects fresh active state and pending permissions without dispatching unsubscribe', async t => {
  const { workbench, client, store } = await fixture(t);
  const original = client.call.bind(client); let unsubscribes = 0;
  client.call = async (method, params) => { if (method === 'thread/unsubscribe') unsubscribes++; return original(method, params); };
  client.threads.find(thread => thread.id === 'task-idle')!.status = { type: 'active', activeFlags: [] };
  await assert.rejects(workbench.detach('demo', 'task-idle'), /先停止/);
  client.threads.find(thread => thread.id === 'task-idle')!.status = { type: 'idle' };
  client.emit('request', { id: 'pending-exit', method: 'item/commandExecution/requestApproval', params: { threadId: 'task-idle', turnId: 'turn-task-idle', command: 'echo hello' } });
  await assert.rejects(workbench.detach('demo', 'task-idle'), /待确认请求/);
  assert.equal(unsubscribes, 0); assert.equal(store.data.detached?.length || 0, 0);
});

test('failed unsubscribe is visible and uncertain exits never automatically reattach', async t => {
  const { workbench, client, store } = await fixture(t);
  const original = client.call.bind(client);
  for (const uncertain of [false, true]) {
    client.call = async (method, params) => {
      if (method === 'thread/unsubscribe') throw new RpcError('unsubscribe failed', uncertain ? 'TIMEOUT' : 'UNSUPPORTED', uncertain);
      return original(method, params);
    };
    await assert.rejects(workbench.detach('demo', 'task-idle'), /unsubscribe failed/);
    assert.equal(store.data.audit[0].outcome, uncertain ? 'uncertain' : 'failed');
    assert.equal(workbench.snapshot().threads.find(thread => thread.id === 'task-idle')!.detached, uncertain);
  }
  let joins = 0;
  client.call = async (method, params: any) => { if (method === 'thread/resume' && params.threadId === 'task-idle') joins++; return original(method, params); };
  await workbench.older('demo'); assert.equal(joins, 0);
});

test('text deltas do not generate whole task snapshots; state and approval notifications still do', async t => {
  const { workbench, client } = await fixture(t);
  await new Promise(resolve => setTimeout(resolve, 250)); // Initial approvals settle.
  let snapshots = 0; workbench.on('change', () => snapshots++);
  for (let i = 0; i < 1000; i++) client.notify('item/agentMessage/delta', { threadId: 'task-running', itemId: 'agent-1', delta: 'x' });
  await new Promise(resolve => setTimeout(resolve, 120)); assert.equal(snapshots, 0);
  client.notify('thread/status/changed', { threadId: 'task-running', status: { type: 'idle' } });
  await until(() => snapshots > 0);
  const count = snapshots;
  client.emit('request', { id: 'memory-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'task-idle', turnId: 'turn-task-idle', command: 'echo hello' } });
  await until(() => snapshots > count);
});

test('delete notifications during detach or resume never return a missing thread as success', async t => {
  for (const action of ['detach', 'resume'] as const) {
    const { workbench, client, store } = await fixture(t);
    const original = client.call.bind(client);
    let entered = false, finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    client.call = async (method, params: any) => {
      const result = await original(method, params);
      if (method === (action === 'detach' ? 'thread/unsubscribe' : 'thread/resume') && params.threadId === 'task-idle') { entered = true; await held; }
      return result;
    };
    const pending = workbench[action]('demo', 'task-idle');
    await until(() => entered);
    client.threads = client.threads.filter(thread => thread.id !== 'task-idle');
    client.notify('thread/deleted', { threadId: 'task-idle' });
    finish();
    await assert.rejects(pending, /已删除或归档/);
    assert(!workbench.snapshot().threads.some(thread => thread.id === 'task-idle'));
    assert(!store.data.detached?.includes('demo:task-idle'));
  }
});

test('light synchronization avoids history reads, retains all sessions and periodically reconciles', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
  const { workbench, client } = await fixture(t);
  const original = client.call.bind(client);
  const calls: string[] = [];
  client.call = async (method, params) => { calls.push(method); return original(method, params); };
  t.mock.timers.tick(5000);
  await until(() => workbench.snapshot().sources[0].lastSync === Date.now());
  assert.deepEqual(calls, ['thread/loaded/list']);
  assert.equal(workbench.snapshot().threads.length, 5);
  calls.length = 0;
  t.mock.timers.tick(55_000);
  await until(() => workbench.snapshot().sources[0].lastSync === Date.now());
  assert.equal(calls.filter(method => method === 'thread/list').length, 1);
  calls.length = 0;
  await workbench.older('demo');
  assert(calls.includes('thread/list'));
});

test('cached details coalesce readers, invalidate on changes and explicit refresh, and never resume history', async t => {
  const { workbench, client } = await fixture(t);
  const original = client.call.bind(client);
  const calls: string[] = [];
  client.call = async (method, params) => { calls.push(method); return original(method, params); };
  const initial = await Promise.all([workbench.detail('demo', 'task-history'), workbench.detail('demo', 'task-history')]);
  assert.deepEqual(initial[0], initial[1]);
  assert.deepEqual(calls, ['thread/read', 'thread/turns/list', 'thread/items/list']);
  calls.length = 0;
  await workbench.detail('demo', 'task-history'); assert.equal(calls.length, 0);
  await workbench.detail('demo', 'task-history', undefined, true);
  assert.equal(calls.length, 3);
  calls.length = 0;
  const agent = client.turns.get('task-history')![0].items.find(item => item.type === 'agentMessage')!;
  if (agent.type === 'agentMessage') agent.text = '新的执行结果';
  client.notify('item/completed', { threadId: 'task-history', item: agent });
  const updated = await workbench.detail('demo', 'task-history');
  assert.match(JSON.stringify(updated.items), /新的执行结果/);
  assert.equal(calls.length, 3);
  calls.length = 0;
  client.notify('turn/completed', { threadId: 'task-history', turn: { id: 'turn-task-history', status: 'completed' } });
  await new Promise(resolve => setImmediate(resolve));
  assert(!calls.includes('thread/list'));
  client.connected = false; client.emit('disconnected', 'offline');
  await assert.rejects(workbench.detail('demo', 'task-history'), /未连接/);
  assert(!calls.includes('thread/resume'));
});

test('warm detail caches never replace fresh mutation safety checks', async t => {
  const { workbench, client } = await fixture(t);
  await workbench.detail('demo', 'task-idle');
  client.threads.find(thread => thread.id === 'task-idle')!.status = { type: 'active', activeFlags: [] };
  await assert.rejects(workbench.deleteThread('demo', 'task-idle'), /仍在执行/);
  await assert.rejects(workbench.message('demo', 'task-idle', 'hello', 'send', 'cache-safety-send'), /任务已开始执行/);
});

test('renaming persists in the source and survives refresh without resuming history', async t => {
  const { workbench, client, store } = await fixture(t);
  const original = client.call.bind(client);
  const calls: string[] = [];
  client.call = async (method, params) => { calls.push(method); return original(method, params); };
  const renamed = await workbench.rename('demo', 'task-history', '  新的对话标题  ');
  assert.equal(renamed.title, '新的对话标题');
  assert.equal(renamed.state, 'history');
  assert.equal(client.threads.find(t => t.id === 'task-history')?.name, '新的对话标题');
  assert.equal(store.data.audit[0].action, '修改标题');
  await workbench.older('demo');
  assert.equal((await workbench.detail('demo', 'task-history')).thread.title, '新的对话标题');
  assert(!calls.some(method => ['thread/resume', 'turn/start', 'turn/interrupt'].includes(method)));
  await workbench.rename('demo', 'task-running', '运行中的任务也可改名');
  assert.equal(workbench.snapshot().threads.find(t => t.id === 'task-running')?.state, 'running');
});

test('invalid, missing, deleted and offline rename targets never dispatch a metadata write', async t => {
  const { workbench, client } = await fixture(t);
  const original = client.call.bind(client);
  let writes = 0;
  client.call = async (method, params) => { if (method === 'thread/name/set') writes++; return original(method, params); };
  for (const title of [undefined, null, 42, {}, '', ' \n\t ', 'a'.repeat(201), 'first\nsecond', 'bad\u0000title']) await assert.rejects(workbench.rename('demo', 'task-history', title));
  await assert.rejects(workbench.rename('demo', 'does-not-exist', '合法标题'), /不存在/);
  await workbench.deleteThread('demo', 'task-history');
  await assert.rejects(workbench.rename('demo', 'task-history', '合法标题'), /已删除/);
  client.connected = false; client.emit('disconnected', 'offline');
  await assert.rejects(workbench.rename('demo', 'task-idle', '合法标题'), /未连接/);
  assert.equal(writes, 0);
});

test('failed and uncertain title writes do not invent success or automatically retry', async t => {
  const { workbench, client, store } = await fixture(t);
  const title = workbench.snapshot().threads.find(t => t.id === 'task-history')!.title;
  const original = client.call.bind(client);
  let writes = 0;
  for (const uncertain of [false, true]) {
    client.call = async (method, params) => {
      if (method === 'thread/name/set') { writes++; throw new RpcError('rename failed', uncertain ? 'TIMEOUT' : 'RPC_ERROR', uncertain); }
      return original(method, params);
    };
    await assert.rejects(workbench.rename('demo', 'task-history', '不能显示为成功'), /rename failed/);
    assert.equal(workbench.snapshot().threads.find(t => t.id === 'task-history')!.title, title);
    assert.equal(store.data.audit[0].outcome, uncertain ? 'uncertain' : 'failed');
  }
  assert.equal(writes, 2);
});

test('renaming subagents is source-scoped and preserves the task tree', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-rename-'));
  const clients = new Map(['one', 'two'].map(id => {
    const client = new DemoConnection();
    client.threads.find(t => t.id === 'task-history')!.parentThreadId = 'task-idle';
    return [id, client] as const;
  }));
  const workbench = new Workbench([{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }], new StateStore(join(dir, 'state.json')), true, config => clients.get(config.id)!);
  workbench.start(); t.after(() => workbench.stop());
  await until(() => workbench.snapshot().sources.every(s => !!s.lastSync));
  const renamed = await workbench.rename('one', 'task-history', '重命名子任务');
  assert.equal(renamed.parentId, 'task-idle');
  assert.equal(renamed.key, 'one:task-history');
  assert.notEqual(workbench.snapshot().threads.find(t => t.key === 'two:task-history')!.title, renamed.title);
  clients.get('one')!.notify('thread/name/updated', { threadId: 'task-history', threadName: '来自其他客户端的新标题' });
  assert.equal(workbench.snapshot().threads.find(t => t.key === renamed.key)!.title, '来自其他客户端的新标题');
});

test('saved Codex homes supplement the default source and environment sources override them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-sources-'));
  await mkdir(join(root, '.workbench'));
  await writeFile(join(root, '.workbench/sources.json'), JSON.stringify([{ id: 'second', name: 'Second', codexHome: '/another/codex home' }]));
  const sources = await loadSources(root, { CODEX_HOME: '/default/codex' });
  assert.deepEqual(sources.map(s => s.socket), ['/default/codex/app-server-control/app-server-control.sock', '/another/codex home/app-server-control/app-server-control.sock']);
  assert.deepEqual(sources.map(s => s.codexHome), ['/default/codex', '/another/codex home']);
  const inferred = await loadSources(root, { CODEX_WORKBENCH_SOURCES: JSON.stringify([{ id: 'socket', name: 'Socket', socket: '/custom/codex/app-server-control/app-server-control.sock' }]) });
  assert.equal(inferred[0].codexHome, '/custom/codex');
  assert.deepEqual((await loadSources(root, { CODEX_WORKBENCH_SOURCES: JSON.stringify([{ id: 'only', name: 'Only', url: 'ws://127.0.0.1:4500' }]) })).map(s => s.id), ['only']);
  for (const invalid of [null, [], [{ id: 'bad', name: 'Bad', codexHome: 'relative' }], [{ id: 'bad', name: 'Bad', url: 'ws://remote.example:4500' }], [{ id: 'bad', name: 'Bad', socket: '/tmp/a', codexHome: '/tmp/b' }]]) {
    await assert.rejects(loadSources(root, { CODEX_WORKBENCH_SOURCES: JSON.stringify(invalid) }));
  }
  const socket = join(root, 'socket'); await writeFile(socket, ''); await symlink(socket, join(root, 'alias'));
  const duplicate = [{ id: 'one', name: 'One', socket }, { id: 'two', name: 'Two', socket: join(root, 'alias') }];
  assert.equal((await loadSources(root, { CODEX_WORKBENCH_SOURCES: JSON.stringify(duplicate) })).length, 1);
});

test('all thread and loaded-session pages are discovered, including children, without resuming history', async t => {
  const client = new DemoConnection();
  const history = client.threads.find(t => t.id === 'task-history')!;
  client.threads.push(...Array.from({ length: 205 }, (_, i) => ({ ...history, id: `older-${i}`, parentThreadId: i === 204 ? 'task-history' : null })));
  const original = client.call.bind(client); const cursors: unknown[] = []; const resumed: string[] = [];
  client.call = async (method, params: any) => {
    if (method === 'thread/list') cursors.push(params.cursor);
    if (method === 'thread/resume') resumed.push(params.threadId);
    if (method === 'thread/loaded/list') return (params.cursor ? { data: ['task-idle'], nextCursor: null } : { data: ['task-running', 'task-approval', 'task-input'], nextCursor: 'loaded-next' }) as any;
    return original(method, params);
  };
  const { workbench } = await fixture(t, client, 210);
  assert.deepEqual(cursors, [undefined, '100', '200']);
  assert.equal(workbench.snapshot().threads.find(t => t.id === 'older-204')?.parentId, 'task-history');
  assert(!resumed.some(id => id === 'task-history' || id.startsWith('older-')));
  assert(resumed.includes('task-idle'));
  assert.equal(workbench.snapshot().sources[0].hasMore, false);
});

test('interrupted pagination retains prior results and does not claim complete synchronization', async t => {
  const { workbench, client } = await fixture(t);
  const original = client.call.bind(client);
  client.call = async (method, params: any) => {
    if (method === 'thread/list') {
      if (params.cursor) throw new Error('second page failed');
      return { data: [client.threads[0]], nextCursor: 'next' } as any;
    }
    return original(method, params);
  };
  const previous = workbench.snapshot().sources[0].lastSync;
  await workbench.older('demo');
  assert.equal(workbench.snapshot().threads.length, 5);
  assert.equal(workbench.snapshot().sources[0].lastSync, previous);
  assert.match(workbench.snapshot().sources[0].error!, /second page failed/);
});

test('disconnecting during pagination discards responses from the old connection', async t => {
  const { workbench, client } = await fixture(t);
  const original = client.call.bind(client);
  let finish: (value: any) => void = () => {};
  client.call = async (method, params) => method === 'thread/list' ? new Promise(resolve => { finish = resolve; }) : original(method, params);
  const refresh = workbench.older('demo');
  client.connected = false; client.emit('disconnected', 'offline');
  finish({ data: [{ ...client.threads[0], id: 'stale' }], nextCursor: null });
  await refresh;
  assert(!workbench.snapshot().threads.some(t => t.id === 'stale'));
  assert(workbench.snapshot().threads.every(t => t.state === 'unknown'));
});

test('deletion removes descendants, pending requests and queue records, and stays deleted after refresh', async t => {
  const { workbench, client, store, dir } = await fixture(t);
  const child = { ...client.threads.find(t => t.id === 'task-history')!, id: 'child-history', parentThreadId: 'task-history' };
  client.threads.push(child); client.notify('thread/started', { thread: child });
  client.emit('request', { id: 'child-request', method: 'unknown', params: { threadId: child.id } });
  store.data.queue.push({ id: 'child-queue', sourceId: 'demo', threadId: child.id, text: 'never send', status: 'queued', createdAt: Date.now() });
  const result = await workbench.deleteThread('demo', 'task-history');
  assert.deepEqual(result.deletedIds, ['task-history', child.id]);
  assert(!workbench.snapshot().threads.some(t => result.deletedIds.includes(t.id)));
  assert(!workbench.snapshot().pending.some(p => p.threadId === child.id));
  assert.equal(store.data.queue.length, 0);
  assert.equal(store.data.audit[0].action, '删除对话');
  assert.equal(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).queue.length, 0);
  // A late page or notification must not resurrect the removed conversation.
  client.notify('thread/started', { thread: child });
  await workbench.older('demo');
  assert(!workbench.snapshot().threads.some(t => result.deletedIds.includes(t.id)));
});

test('deletion rejects active parents and descendants using fresh server state', async t => {
  const { workbench, client } = await fixture(t);
  await assert.rejects(workbench.deleteThread('demo', 'task-running'), /请先停止/);
  client.threads.push({ ...client.threads[0], id: 'active-child', parentThreadId: 'task-history' });
  await assert.rejects(workbench.deleteThread('demo', 'task-history'), /请先停止/);
  assert(client.threads.some(t => t.id === 'task-history'));
});

test('deleting during a detail refresh returns a clear error instead of an incomplete detail object', async t => {
  const { workbench, client } = await fixture(t);
  const original = client.call.bind(client);
  let release: (() => void) | undefined;
  client.call = async (method, params) => {
    if (method === 'thread/items/list') { const items = await original(method, params); return new Promise(resolve => { release = () => resolve(items); }); }
    return original(method, params);
  };
  const detail = workbench.detail('demo', 'task-history');
  await until(() => !!release);
  await workbench.deleteThread('demo', 'task-history');
  release!();
  await assert.rejects(detail, /已删除或归档/);
});

test('deleting a conversation affects only its source even when thread IDs match', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-multi-source-'));
  const store = new StateStore(join(dir, 'state.json'));
  const workbench = new Workbench([{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }], store, true, () => new DemoConnection());
  workbench.start(); t.after(() => workbench.stop());
  await until(() => workbench.snapshot().sources.every(s => !!s.lastSync));
  store.data.queue.push({ id: 'other-queue', sourceId: 'two', threadId: 'task-history', text: 'retain', status: 'queued', createdAt: Date.now() });
  await workbench.deleteThread('one', 'task-history');
  assert(!workbench.snapshot().threads.some(t => t.key === 'one:task-history'));
  assert(workbench.snapshot().threads.some(t => t.key === 'two:task-history'));
  assert.equal(store.data.queue[0].sourceId, 'two');
});

test('failed or uncertain deletion preserves the conversation and pauses queued work across restart', async t => {
  const { workbench, client, store, dir } = await fixture(t);
  const original = client.call.bind(client);
  store.data.queue.push({ id: 'delete-queue', sourceId: 'demo', threadId: 'task-history', text: 'do not send', status: 'queued', createdAt: Date.now() });
  client.call = async (method, params) => { if (method === 'thread/delete') throw new RpcError('timeout', 'TIMEOUT', true); return original(method, params); };
  await assert.rejects(workbench.deleteThread('demo', 'task-history'), /timeout/);
  assert(workbench.snapshot().threads.some(t => t.id === 'task-history'));
  assert.equal(store.data.queue[0].status, 'failed');
  assert.equal(store.data.audit[0].outcome, 'uncertain');
  const reloaded = new StateStore(join(dir, 'state.json')); await reloaded.load();
  assert.equal(reloaded.data.queue[0].status, 'failed');
});
test('approval responses grant only the requested permissions for the current turn', () => {
  const raw = { id: 8, method: 'item/permissions/requestApproval', params: { threadId: 't', turnId: 'v', permissions: { network: { enabled: true } } } };
  const view = pendingRequest('local', 1, raw);
  assert.deepEqual(approvalResponse(view, raw, { decision: 'accept' }), { permissions: raw.params.permissions, scope: 'turn' });
  assert.deepEqual(approvalResponse(view, raw, { decision: 'decline' }), { permissions: {}, scope: 'turn' });
  assert.throws(() => approvalResponse(view, raw, { decision: 'acceptForSession' } as any));
});
test('user-input replies require all answers and preserve structured question IDs', () => {
  const raw = { id: 'input', method: 'item/tool/requestUserInput', params: { threadId: 't', questions: [{ id: 'first', question: 'A' }, { id: 'second', question: 'B' }] } };
  const view = pendingRequest('local', 1, raw);
  assert.throws(() => approvalResponse(view, raw, { answers: { first: 'yes' } }));
  assert.deepEqual(approvalResponse(view, raw, { answers: { first: 'yes', second: 'no' } }), { answers: { first: { answers: ['yes'] }, second: { answers: ['no'] } } });
});
test('unsupported and structured MCP requests cannot be blindly accepted', () => {
  const raw = { id: 1, method: 'mcpServer/elicitation/request', params: { threadId: 't', requestedSchema: { type: 'object' } } };
  assert.throws(() => approvalResponse(pendingRequest('l', 1, raw), raw, { decision: 'accept' }));
  const unknown = { id: 2, method: 'item/tool/call', params: {} };
  assert.throws(() => approvalResponse(pendingRequest('l', 1, unknown), unknown, { decision: 'accept' }));
});
test('timeline excludes reasoning and treats returned text as plain content', () => {
  assert.equal(timeline({ type: 'reasoning', id: 'i', summary: ['private'], content: [] }, 't'), null);
  assert.equal(timeline({ type: 'agentMessage', id: 'i', text: '<script>alert(1)</script>' } as any, 't')?.text, '<script>alert(1)</script>');
});
test('local HTTP guard rejects cross-site requests and DNS rebinding', () => {
  assert.equal(trustedRequest({ headers: { host: '127.0.0.1:4310', origin: 'http://127.0.0.1:4310' } }, 4310), true);
  assert.equal(trustedRequest({ headers: { host: 'localhost:4310', origin: 'https://evil.example' } }, 4310), false);
  assert.equal(trustedRequest({ headers: { host: 'evil.example:4310' } }, 4310), false);
  assert.equal(trustedRequest({ headers: { host: '127.0.0.1:4310', 'sec-fetch-site': 'cross-site' } }, 4310), false);
});
test('restart marks in-flight deliveries uncertain instead of retrying', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-workbench-state-')); const file = join(dir, 'state.json');
  const store = new StateStore(file); store.data.queue.push({ id: 'message-1', sourceId: 'local', threadId: 'thread-1', text: 'hello', createdAt: Date.now(), status: 'sending' }); await store.save();
  const reloaded = new StateStore(file); await reloaded.load();
  assert.equal(reloaded.data.queue[0].status, 'uncertain');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).queue[0].status, 'sending');
});
test('reading history does not resume it and immediate sends to active turns are rejected', async t => {
  const { workbench, client } = await fixture(t);
  await workbench.detail('demo', 'task-history');
  assert.equal(client.threads.find(t => t.id === 'task-history')!.status.type, 'notLoaded');
  await assert.rejects(workbench.message('demo', 'task-running', 'hello', 'send', 'request-test-1'), /任务已开始执行/);
});
test('stopping a turn pauses its queue before completion notifications arrive', async t => {
  const { workbench, client, store } = await fixture(t);
  await workbench.message('demo', 'task-running', 'must not run', 'queue', 'request-stop-1');
  assert.equal(store.data.queue[0].status, 'queued');
  await workbench.interrupt('demo', 'task-running', 'turn-task-running');
  await new Promise(r => setTimeout(r, 100));
  assert.equal(store.data.queue[0].status, 'failed');
  assert.equal(client.turns.get('task-running')!.length, 1);
});
test('cancelled queue entries are not delivered on later completion', async t => {
  const { workbench, client, store } = await fixture(t);
  await workbench.message('demo', 'task-running', 'never send', 'queue', 'request-cancel-1');
  await workbench.cancelQueue('request-cancel-1');
  const thread = client.threads.find(t => t.id === 'task-running')!; thread.status = { type: 'idle' };
  client.notify('turn/completed', { threadId: thread.id, turn: client.turns.get(thread.id)![0] });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(store.data.queue.length, 0); assert.equal(client.turns.get(thread.id)!.length, 1);
});
test('queued messages are dispatched once after normal completion', async t => {
  const { workbench, client, store } = await fixture(t);
  await workbench.message('demo', 'task-running', 'next step', 'queue', 'request-next-1');
  client.threads.find(t => t.id === 'task-running')!.status = { type: 'idle' };
  client.notify('turn/completed', { threadId: 'task-running', turn: client.turns.get('task-running')![0] });
  await until(() => store.data.queue.length === 0);
  assert.equal(client.turns.get('task-running')!.length, 2);
  assert.equal(store.data.audit[0].id, 'request-next-1');
});
test('uncertain sends remain visible and duplicate submissions are rejected', async t => {
  const { workbench, client, store } = await fixture(t);
  const original = client.call.bind(client); let sends = 0;
  client.call = async (method, params) => { if (method === 'turn/start') { sends++; throw new RpcError('timeout', 'TIMEOUT', true); } return original(method, params); };
  await assert.rejects(workbench.message('demo', 'task-idle', 'test', 'send', 'request-unknown-1'));
  assert.equal(store.data.queue[0].status, 'uncertain');
  await assert.rejects(workbench.message('demo', 'task-idle', 'test', 'send', 'request-unknown-1'), /已提交/);
  assert.equal(sends, 1);
});
test('approval can be submitted only once, and disconnected approvals expire', async t => {
  const { workbench, client } = await fixture(t);
  await until(() => workbench.snapshot().pending.length >= 2);
  const request = workbench.snapshot().pending.find(p => p.kind === 'command')!;
  await workbench.reply(request.key, { decision: 'accept' });
  await assert.rejects(workbench.reply(request.key, { decision: 'accept' }), /已处理或已失效/);
  client.connected = false; client.emit('disconnected', 'test disconnect');
  assert.equal(workbench.snapshot().pending.length, 0);
  assert(workbench.snapshot().threads.every(t => t.state === 'unknown'));
});

test('unchanged synchronization and token notifications stay silent while approvals and mutations still publish', async t => {
  const client = new DemoConnection();
  client.threads = client.threads.filter(thread => ['task-idle', 'task-history'].includes(thread.id));
  const { workbench } = await fixture(t, client, 2);
  const emissions: ReturnType<Workbench['snapshot']>[] = [];
  workbench.on('change', snapshot => emissions.push(structuredClone(snapshot)));
  await until(() => emissions.length > 0);
  const initial = emissions.length;
  const lastSync = workbench.snapshot().sources[0].lastSync;
  const activity = workbench.snapshot().threads.find(thread => thread.id === 'task-idle')!.lastActivity;
  for (let i = 0; i < 3; i++) {
    client.notify('thread/tokenUsage/updated', { threadId: 'task-idle', tokenUsage: { total: i } });
    client.notify('item/agentMessage/delta', { threadId: 'task-idle', delta: 'text' });
    await workbench.older('demo');
    await new Promise(resolve => setTimeout(resolve, 130));
  }
  assert.equal(emissions.length, initial);
  assert(workbench.snapshot().sources[0].lastSync! > lastSync!);
  assert.equal(workbench.snapshot().threads.find(thread => thread.id === 'task-idle')!.lastActivity, activity);
  client.notify('thread/name/updated', { threadId: 'task-idle', threadName: 'Changed' });
  await until(() => emissions.length === initial + 1);
  assert.equal(emissions.at(-1)!.threads.find(thread => thread.id === 'task-idle')!.title, 'Changed');
  client.emit('request', { id: 'cpu-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'task-idle', turnId: 'turn', command: 'test -d .' } });
  await until(() => emissions.at(-1)!.pending.length === 1);
  client.notify('serverRequest/resolved', { threadId: 'task-idle', requestId: 'cpu-approval' });
  await until(() => emissions.at(-1)!.pending.length === 0);
  client.emit('disconnected', 'offline');
  await until(() => emissions.at(-1)!.sources[0].connected === false);
});
