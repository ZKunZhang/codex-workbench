// Read-only by default. --exercise creates one isolated test conversation and sends
// a no-tools prompt. It never sends messages to, interrupts, or resumes user tasks.
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const base = process.env.WORKBENCH_URL || 'http://127.0.0.1:4310';
let token = '';
async function api(path, body) {
  const response = await fetch(base + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? undefined : { 'Content-Type': 'application/json', 'X-Workbench-Token': token }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error); return value;
}
const session = await api('session'); token = session.token;
const source = session.snapshot.sources.find(s => s.connected && (!process.env.WORKBENCH_SOURCE || s.id === process.env.WORKBENCH_SOURCE));
if (!source) throw new Error('No connected Codex source');
console.log(JSON.stringify({ connected: true, source: source.id, version: source.version, threads: session.snapshot.threads.length }));
if (process.argv.includes('--exercise')) {
  const cwd = join(tmpdir(), 'codex-workbench-smoke'); await mkdir(cwd, { recursive: true });
  const thread = await api('threads', { sourceId: source.id, cwd });
  const path = `threads/${source.id}/${thread.id}`;
  console.log(JSON.stringify({ createdTestThread: thread.id }));
  await api(path + '/message', { requestId: crypto.randomUUID(), mode: 'send', text: '这是本机 Codex 工作台的连接自检。不要读取或修改文件，不调用任何工具，只回复 WORKBENCH_SMOKE_OK。' });
  const deadline = Date.now() + 90000;
  let passed = false;
  while (Date.now() < deadline) {
    const detail = await api(path);
    if (detail.items.some(i => i.type === 'agentMessage' && i.text.includes('WORKBENCH_SMOKE_OK')) && detail.turns[0]?.status === 'completed') {
      console.log(JSON.stringify({ sendAndReply: 'passed', turnStatus: detail.turns[0].status, threadId: thread.id })); passed = true; break;
    }
    if (detail.turns[0]?.status === 'failed') throw new Error(detail.turns[0].error || 'Test turn failed');
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  if (!passed) throw new Error('Live test timed out; inspect only the newly created test thread.');
  await api(path + '/resume', {});
  console.log(JSON.stringify({ rejoin: 'passed' }));
}
