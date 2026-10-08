import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createWorkbenchServer } from '../server/http.ts';
import { Workbench } from '../server/workbench.ts';
import { StateStore } from '../server/state.ts';
import { DemoConnection } from '../server/demo.ts';

test('the real HTTP router advertises and dispatches authenticated rename without opening a port', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'workbench-http-'));
  const client = new DemoConnection();
  const workbench = new Workbench([{ id: 'demo', name: 'Demo' }], new StateStore(join(folder, 'state.json')), true, () => client);
  const app = await createWorkbenchServer(workbench, { port: 4310, root: resolve('.') });
  t.after(async () => { workbench.stop(); await app.close(); });
  workbench.start();
  const deadline = Date.now() + 3000;
  while (!workbench.snapshot().sources[0].lastSync) {
    if (Date.now() > deadline) throw new Error('demo initialization timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  // Exercise the production request listener directly, rather than duplicating
  // its routing in a test mock. No listen() or real Codex connection is needed.
  const request = (path: string, body?: unknown, token?: string) => new Promise<{ status: number; body: any }>(resolve => {
    const req = Object.assign(new PassThrough(), { url: '/api/' + path, method: body === undefined ? 'GET' : 'POST', headers: { host: '127.0.0.1:4310', 'content-type': 'application/json', ...(token ? { 'x-workbench-token': token } : {}) } });
    let status = 0;
    const res = { headersSent: false, setHeader() {}, writeHead(code: number) { status = code; this.headersSent = true; }, end(data: string) { resolve({ status, body: JSON.parse(data) }); } };
    app.server.emit('request', req, res);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const session = await request('session');
  assert.equal(session.status, 200);
  assert.equal(session.body.capabilities.renameThread, true);
  assert.equal(session.body.capabilities.detachThread, true);
  const token = session.body.token;
  const path = 'threads/demo/task-history';
  assert.equal((await request(path + '/rename', { title: 'unauthorized' })).status, 403);
  const invalid = await request(path + '/rename', { title: '' }, token);
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /请输入对话标题/);
  const renamed = await request(path + '/rename', { title: '从真实路由保存的标题' }, token);
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.title, '从真实路由保存的标题');
  assert.equal(renamed.body.state, 'history');
  assert.equal((await request(path)).body.thread.title, renamed.body.title);
  assert.equal(client.threads.find(thread => thread.id === 'task-history')?.name, renamed.body.title);
  const original = client.call.bind(client);
  let reads = 0;
  client.call = async (method, params) => { if (method === 'thread/items/list') reads++; return original(method, params); };
  await request(path); assert.equal(reads, 0);
  await request(path + '?refresh=1'); assert.equal(reads, 1);
  assert.equal((await request('threads/demo/task-idle/detach', { confirm: true })).status, 403);
  assert.equal((await request('threads/demo/task-idle/detach', {}, token)).status, 400);
  const detached = await request('threads/demo/task-idle/detach', { confirm: true }, token);
  assert.equal(detached.status, 200); assert.equal(detached.body.detached, true);
  assert.equal((await request('threads/demo/task-idle/resume', {}, token)).body.detached, false);
  assert.equal(app.server.listening, false);
});
