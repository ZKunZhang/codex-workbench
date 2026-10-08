import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { RpcConnection } from './rpc.ts';
import type { Thread } from './protocol/v2/Thread.ts';
import type { Turn } from './protocol/v2/Turn.ts';

export class DemoConnection extends EventEmitter implements RpcConnection {
  connected = false;
  threads: Thread[];
  turns = new Map<string, Turn[]>();
  private requested = new Set<string>();
  private timers = new Set<NodeJS.Timeout>();
  constructor() {
    super();
    const now = Math.floor(Date.now() / 1000);
    this.threads = [
      ['task-approval', '优化课程管理的搜索体验', '/workspace/course-admin', { type: 'active', activeFlags: ['waitingOnApproval'] }],
      ['task-running', '为订单导出添加进度提示', '/workspace/course-admin', { type: 'active', activeFlags: [] }],
      ['task-input', '整理网站首页的内容结构', '/workspace/company-website', { type: 'active', activeFlags: ['waitingOnUserInput'] }],
      ['task-idle', '修复上传组件的错误提示', '/workspace/design-system', { type: 'idle' }],
      ['task-history', '检查构建脚本与依赖', '/workspace/design-system', { type: 'notLoaded' }],
    ].map(([id, name, cwd, status], i) => ({ id, name, cwd, status, preview: name, model: '演示模型', modelProvider: 'demo', historyMode: 'paginated', parentThreadId: null, createdAt: now - 3600, updatedAt: now - i * 180, gitInfo: { branch: 'feat/workbench-demo' }, turns: [] } as unknown as Thread));
    for (const thread of this.threads) this.turns.set(thread.id, [{ id: `turn-${thread.id}`, status: thread.status.type === 'active' ? 'inProgress' : 'completed', itemsView: 'full', startedAt: now - 360, completedAt: thread.status.type === 'active' ? null : now - 120, durationMs: null, error: null, items: [
      { type: 'userMessage', id: `user-${thread.id}`, clientId: null, content: [{ type: 'text', text: thread.name!, text_elements: [] }] },
      { type: 'agentMessage', id: `agent-${thread.id}`, text: '已检查相关文件，接下来验证变更后的交互和错误处理。', phase: null, memoryCitation: null, delivery: null, questions: null },
      { type: 'commandExecution', id: `command-${thread.id}`, command: 'pnpm test', cwd: thread.cwd, status: thread.id === 'task-approval' ? 'inProgress' : 'completed', aggregatedOutput: thread.id === 'task-approval' ? null : '✓ 搜索条件重置\n✓ 空结果提示\n✓ 请求失败后的恢复', exitCode: thread.id === 'task-approval' ? null : 0, durationMs: 1240, processId: null, source: 'agent', commandActions: [], pluginId: null, scriptPath: null },
    ] } as Turn]);
  }
  private later(fn: () => void, ms: number) { const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms); this.timers.add(t); }
  start() { this.connected = true; this.later(() => this.emit('connected', { userAgent: 'codex-demo/0.161.0' }), 10); }
  close() { this.connected = false; for (const timer of this.timers) clearTimeout(timer); }
  notify(method: string, params: unknown) { this.emit('notification', { method, params }); }
  async call<T = any>(method: string, params: any = {}): Promise<T> {
    const thread = this.threads.find(t => t.id === params.threadId);
    let result: unknown;
    if (method === 'thread/list') {
      let threads = params.archived ? [] : this.threads;
      if (params.ancestorThreadId) {
        const descendants = new Set<string>([params.ancestorThreadId]);
        let count = 0;
        do { count = descendants.size; for (const t of threads) if (t.parentThreadId && descendants.has(t.parentThreadId)) descendants.add(t.id); } while (descendants.size > count);
        threads = threads.filter(t => t.id !== params.ancestorThreadId && descendants.has(t.id));
      }
      const offset = Number(params.cursor || 0); const limit = params.limit || 100;
      result = { data: threads.slice(offset, offset + limit), nextCursor: offset + limit < threads.length ? String(offset + limit) : null };
    }
    else if (method === 'thread/loaded/list') result = { data: this.threads.filter(t => t.status.type !== 'notLoaded').map(t => t.id) };
    else if (method === 'thread/start') {
      const next = { ...this.threads[3], id: randomUUID(), cwd: params.cwd, name: '新会话', preview: '', status: { type: 'idle' }, turns: [] } as Thread;
      this.threads.unshift(next); this.turns.set(next.id, []); result = { thread: next }; this.notify('thread/started', { thread: next });
    } else if (!thread) throw new Error('会话不存在');
    else if (method === 'thread/name/set') {
      thread.name = params.name;
      this.notify('thread/name/updated', { threadId: thread.id, threadName: thread.name });
      result = {};
    }
    else if (method === 'thread/delete') {
      const { data } = await this.call<{ data: Thread[] }>('thread/list', { ancestorThreadId: thread.id, limit: this.threads.length });
      const ids = new Set([thread.id, ...data.map(t => t.id)]);
      if (this.threads.some(t => ids.has(t.id) && t.status.type === 'active')) throw new Error('会话仍在执行');
      this.threads = this.threads.filter(t => !ids.has(t.id));
      for (const id of ids) { this.turns.delete(id); this.notify('thread/deleted', { threadId: id }); }
      result = {};
    }
    else if (method === 'thread/read') result = { thread: { ...thread, turns: params.includeTurns ? this.turns.get(thread.id) : [] } };
    else if (method === 'thread/unsubscribe') result = { status: thread.status.type === 'notLoaded' ? 'notLoaded' : 'unsubscribed' };
    else if (method === 'thread/resume') {
      if (thread.status.type === 'notLoaded') thread.status = { type: 'idle' };
      result = { thread };
      if (!this.requested.has(thread.id)) {
        this.requested.add(thread.id);
        if (thread.id === 'task-approval') this.later(() => this.emit('request', { id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: thread.id, turnId: `turn-${thread.id}`, itemId: `command-${thread.id}`, command: 'pnpm test', cwd: thread.cwd, reason: '测试需要创建临时缓存文件。', kind: 'command', startedAtMs: Date.now() } }), 100);
        if (thread.id === 'task-input') this.later(() => this.emit('request', { id: 'input-1', method: 'item/tool/requestUserInput', params: { threadId: thread.id, turnId: `turn-${thread.id}`, itemId: 'question-1', isBlocking: true, questions: [{ id: 'direction', header: '首页重点', question: '首页优先呈现哪部分内容？', isSecret: false, options: [{ label: '产品介绍', description: '先说明产品能做什么' }, { label: '客户案例', description: '先展示实际使用效果' }] }] } }), 100);
      }
    } else if (method === 'thread/turns/list') result = { data: [...(this.turns.get(thread.id) || [])].reverse(), nextCursor: null };
    else if (method === 'thread/items/list') {
      const entries = (this.turns.get(thread.id) || []).flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item, startedAtMs: (turn.startedAt || 0) * 1000, completedAtMs: null }))).reverse();
      const offset = Number(params.cursor || 0), limit = params.limit || 60;
      result = { data: entries.slice(offset, offset + limit), nextCursor: offset + limit < entries.length ? String(offset + limit) : null };
    }
    else if (method === 'turn/start' || method === 'turn/steer') {
      if (method === 'turn/steer' && this.turns.get(thread.id)?.at(-1)?.id !== params.expectedTurnId) throw new Error('执行轮次已变化');
      let turn = this.turns.get(thread.id)?.at(-1);
      if (method === 'turn/start') {
        turn = { id: randomUUID(), status: 'inProgress', startedAt: Math.floor(Date.now() / 1000), completedAt: null, durationMs: null, itemsView: 'full', error: null, items: [] };
        this.turns.get(thread.id)!.push(turn);
      }
      turn!.items.push({ type: 'userMessage', id: randomUUID(), clientId: params.clientUserMessageId, content: params.input });
      thread.status = { type: 'active', activeFlags: [] };
      this.notify('thread/status/changed', { threadId: thread.id, status: thread.status });
      result = method === 'turn/start' ? { turn } : { turnId: turn!.id };
      const started = turn!;
      this.later(() => {
        if (started.status !== 'inProgress') return;
        started.items.push({ type: 'agentMessage', id: randomUUID(), text: '演示回复：指令已收到，任务执行完成。', phase: null, memoryCitation: null, delivery: null, questions: null });
        this.complete(thread, started);
      }, 1200);
    } else if (method === 'turn/interrupt') {
      const turn = this.turns.get(thread.id)?.find(t => t.id === params.turnId);
      if (!turn || turn.status !== 'inProgress') throw new Error('执行轮次已结束');
      this.complete(thread, turn, 'interrupted'); result = {};
    } else throw new Error(`演示连接不支持 ${method}`);
    return structuredClone(result) as T;
  }
  private complete(thread: Thread, turn: Turn, status: Turn['status'] = 'completed') {
    turn.status = status; turn.completedAt = Math.floor(Date.now() / 1000); thread.status = { type: 'idle' };
    this.notify('thread/status/changed', { threadId: thread.id, status: thread.status });
    this.notify('turn/completed', { threadId: thread.id, turn });
  }
  respond(id: string | number, _result: unknown) {
    const threadId = id === 'approval-1' ? 'task-approval' : 'task-input';
    this.later(() => { this.notify('serverRequest/resolved', { threadId, requestId: id }); this.complete(this.threads.find(t => t.id === threadId)!, this.turns.get(threadId)!.at(-1)!); }, 100);
  }
}
export const demoFactory = () => new DemoConnection();
