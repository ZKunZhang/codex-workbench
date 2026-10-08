import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { basename, isAbsolute, join } from 'node:path';
import { stat } from 'node:fs/promises';
import type { Thread } from './protocol/v2/Thread.ts';
import type { Turn } from './protocol/v2/Turn.ts';
import type { ThreadItemEntry } from './protocol/v2/ThreadItemEntry.ts';
import type { SourceConfig, SourceState, ThreadSummary, PendingRequest, Reply, Snapshot, ThreadDetail, QueueItem } from '../shared/types.ts';
import { CodexConnection, RpcError, type RpcConnection } from './rpc.ts';
import { StateStore } from './state.ts';
import { LocalSessions, type LocalInspector } from './local-sessions.ts';
import { approvalResponse, pendingRequest, runtimeState, summarize, timeline } from './normalize.ts';
import { validateTitle } from '../shared/title.ts';
import { ReadCache } from './read-cache.ts';
import { equalData } from '../shared/equality.ts';

interface ExternalSession { pid: number; state: ThreadSummary['state']; lastActivity: number | null; checkedAt: number }
interface Source { config: SourceConfig; client: RpcConnection; state: SourceState; generation: number; subscriptions: Set<string>; removed: Set<string>; syncing: boolean; lastFullSync: number | null; localIds: Set<string>; external: Map<string, ExternalSession> }
const listParams = { limit: 100, sortKey: 'updated_at', useStateDbOnly: true, modelProviders: [], sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'] };
export class Workbench extends EventEmitter {
  private sources = new Map<string, Source>();
  private threads = new Map<string, ThreadSummary>();
  private pending = new Map<string, { view: PendingRequest; raw: any; generation: number }>();
  private locks = new Set<string>();
  private revision = 0;
  private timer?: NodeJS.Timeout;
  private emission?: NodeJS.Timeout;
  private publishedContent?: unknown;
  private draining = false;
  private discovering = false;
  private stopped = false;
  private detached: Set<string>;
  private details = new ReadCache<ThreadDetail>(16, Date.now, detail => detail.items.reduce((bytes, item) => bytes + 2 * (item.text.length + (item.detail?.length || 0) + item.title.length), 0), 8 * 1024 * 1024);
  constructor(configs: SourceConfig[], public store: StateStore, private demo = false, private factory: (config: SourceConfig) => RpcConnection = c => new CodexConnection(c), private local: LocalInspector = new LocalSessions()) {
    super();
    this.detached = new Set(store.data.detached || []);
    for (const config of configs) this.addSource(config);
  }
  private addSource(config: SourceConfig) {
      const client = this.factory(config);
      const source: Source = { config, client, generation: 0, subscriptions: new Set(), removed: new Set(), localIds: new Set(), external: new Map(), syncing: false, lastFullSync: null, state: { id: config.id, name: config.name, codexHome: config.codexHome || null, connected: false, error: null, localWarning: null, version: null, lastSync: null, hasMore: false, syncing: false } };
      source.state.terminalAddress = config.socket ? `unix://${config.socket}` : config.url;
      this.sources.set(config.id, source);
      client.on('connected', info => {
        source.generation++;
        source.lastFullSync = null;
        source.state.connected = true;
        source.state.error = null;
        source.state.version = info?.userAgent?.match(/(?:codex[^/]*\/)([^ ]+)/)?.[1] || null;
        this.changed();
        void this.sync(source);
      });
      client.on('disconnected', reason => {
        source.generation++;
        this.details.invalidate(`${config.id}:`);
        source.syncing = false;
        source.state.connected = false;
        source.state.syncing = false;
        source.state.error = reason;
        source.subscriptions.clear();
        for (const [key, request] of this.pending) if (request.view.sourceId === config.id) this.pending.delete(key);
        for (const thread of this.threads.values()) if (thread.sourceId === config.id) { thread.state = 'unknown'; thread.subscribed = false; }
        this.changed();
      });
      client.on('request', message => {
        const view = pendingRequest(config.id, source.generation, message);
        this.details.invalidate(`${config.id}:${view.threadId}:`);
        this.pending.set(view.key, { view, raw: message, generation: source.generation });
        this.changed();
      });
      client.on('notification', message => this.notification(source, message));
    return source;
  }
  private async discover() {
    if (this.demo || !this.local.homes || this.discovering || this.stopped) return;
    this.discovering = true;
    try {
      for (const home of await this.local.homes()) {
        if (this.stopped) return;
        const socket = join(home, 'app-server-control/app-server-control.sock');
        if ([...this.sources.values()].some(s => s.config.codexHome === home || s.config.socket === socket)) continue;
        const id = 'home-' + createHash('sha256').update(home).digest('hex').slice(0, 16);
        if (this.sources.has(id)) continue;
        this.addSource({ id, name: basename(home), codexHome: home, socket }).client.start();
        this.changed();
      }
    } catch { /* Each configured source exposes inspection errors through sync. */ }
    finally { this.discovering = false; }
  }
  start() { this.stopped = false; for (const source of this.sources.values()) source.client.start(); void this.discover(); this.timer = setInterval(() => { void this.discover(); for (const source of this.sources.values()) void this.sync(source); }, 5000); }
  stop() { this.stopped = true; clearInterval(this.timer); clearTimeout(this.emission); this.local.close?.(); this.details.clear(); for (const source of this.sources.values()) { source.generation++; source.client.close(); } }
  snapshot(): Snapshot { return { sources: [...this.sources.values()].map(s => ({ ...s.state })), threads: [...this.threads.values()], pending: [...this.pending.values()].map(p => p.view), queue: this.store.data.queue, audit: this.store.data.audit.slice(0, 40), revision: this.revision, demo: this.demo }; }
  private changed() {
    this.revision++;
    if (!this.emission) this.emission = setTimeout(() => {
      this.emission = undefined;
      const snapshot = this.snapshot();
      // Polling timestamps and background sync toggles are not task changes.
      // Keep initial loading, errors, approvals and all task changes observable.
      const content = { ...snapshot, revision: 0, sources: snapshot.sources.map(({ lastSync, syncing, ...source }) => ({ ...source, synced: lastSync !== null, syncing: lastSync === null && syncing })) };
      if (equalData(this.publishedContent, content)) return;
      // Workbench mutates records in place, so retain an independent baseline.
      this.publishedContent = structuredClone(content);
      this.emit('change', snapshot);
    }, 100);
  }
  private getSource(id: string) {
    const source = this.sources.get(id);
    if (!source) throw new Error('连接来源不存在');
    if (!source.client.connected) throw new Error('Codex 服务未连接，请等待恢复后再操作');
    return source;
  }
  private upsert(source: Source, thread: Thread) {
    if (source.removed.has(thread.id)) return;
    const key = `${source.config.id}:${thread.id}`;
    const previous = this.threads.get(key);
    const summary = summarize(thread, source.config.id, source.subscriptions.has(thread.id), previous?.lastActivity || null, source.config.codexHome || null);
    summary.detached = this.detached.has(key);
    this.applyExternal(summary, source.external.get(thread.id));
    if (previous && (previous.updatedAt !== summary.updatedAt || previous.state !== summary.state || previous.externalPid !== summary.externalPid)) this.details.invalidate(`${key}:`);
    this.threads.set(key, summary);
  }
  private applyExternal(thread: ThreadSummary, external?: ExternalSession) {
    thread.externalPid = external?.pid || null;
    if (external) { thread.state = external.state; thread.subscribed = false; thread.lastActivity = external.lastActivity; }
  }
  private async pages<T>(source: Source, method: string, params: object, receive?: (data: T[], hasMore: boolean) => void): Promise<T[]> {
    const generation = source.generation;
    const data: T[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: { data: T[]; nextCursor?: string | null } = await source.client.call(method, { ...params, ...(cursor ? { cursor } : {}) });
      if (!source.client.connected || source.generation !== generation) throw new Error('连接已变化，请等待重新同步');
      data.push(...page.data); receive?.(page.data, !!page.nextCursor);
      cursor = page.nextCursor || null;
      if (cursor && cursors.has(cursor)) throw new Error('Codex 返回了重复的分页游标，请重新同步');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return data;
  }
  private async sync(source: Source, fresh = false) {
    if (!source.client.connected || source.syncing) return;
    source.syncing = true;
    source.state.syncing = true;
    this.changed();
    const generation = source.generation;
    const full = fresh || source.lastFullSync === null || Date.now() - source.lastFullSync >= 60_000;
    const previous = [...this.threads.values()].filter(t => t.sourceId === source.config.id);
    const current = () => source.client.connected && generation === source.generation;
    try {
      const results = await Promise.allSettled([
        full ? this.pages<Thread>(source, 'thread/list', listParams, (data, hasMore) => {
          data.forEach(thread => this.upsert(source, thread)); source.state.hasMore = hasMore; this.changed();
        }) : Promise.resolve<Thread[]>([]),
        this.pages<string>(source, 'thread/loaded/list', { limit: 100 }),
        !this.demo && source.config.codexHome ? Promise.allSettled([this.local.inventory(source.config.codexHome, fresh), this.local.owners(source.config.codexHome, fresh)]) : Promise.resolve(null),
      ]);
      if (!current()) return;
      if (results[0].status === 'rejected') throw results[0].reason;
      if (results[1].status === 'rejected') throw results[1].reason;
      const list = results[0].value;
      const loaded = results[1].value;
      const listedIds = new Set(full ? list.map(t => t.id) : previous.map(t => t.id));
      const loadedIds = new Set(loaded);
      const inspection = results[2].status === 'fulfilled' ? results[2].value : null;
      const warnings: string[] = [];
      if (inspection) {
        if (inspection[0].status === 'fulfilled') source.localIds = inspection[0].value;
        else warnings.push(`本机会话目录读取失败：${inspection[0].reason.message}`);
        if (inspection[1].status === 'fulfilled') {
          const previousOwners = source.external;
          source.external = new Map();
          for (const [id, pid] of inspection[1].value) if (!loadedIds.has(id) && !source.removed.has(id)) {
            const old = previousOwners.get(id);
            source.external.set(id, old?.pid === pid ? old : { pid, state: 'unknown', lastActivity: null, checkedAt: 0 });
          }
        } else { warnings.push(inspection[1].reason.message); for (const external of source.external.values()) external.state = 'unknown'; }
      }
      // A loaded thread belongs to this connection even if process inspection
      // temporarily failed while it moved out of a standalone terminal.
      for (const id of loadedIds) source.external.delete(id);
      list.forEach(thread => this.upsert(source, thread));
      // Older servers can omit legacy subagents from thread/list even when
      // thread/read succeeds. Reconcile on-disk IDs without loading a session.
      for (const id of new Set([...source.localIds, ...source.external.keys()])) {
        if (!current()) return;
        if (listedIds.has(id) || source.removed.has(id)) continue;
        try {
          if (!this.threads.has(`${source.config.id}:${id}`)) {
            const result = await source.client.call<{ thread: Thread }>('thread/read', { threadId: id });
            if (!current()) return;
            this.upsert(source, result.thread);
          }
          listedIds.add(id);
        } catch { warnings.push(`本地 session ${id} 暂时无法读取`); }
      }
      for (const thread of previous) if (!listedIds.has(thread.id) && !loadedIds.has(thread.id)) this.forget(source, thread.id);
      for (const thread of this.threads.values()) if (thread.sourceId === source.config.id && !loadedIds.has(thread.id)) { thread.state = 'history'; thread.externalPid = null; thread.subscribed = false; source.subscriptions.delete(thread.id); }
      // Only join sessions already loaded on this server. Reading history never resumes it.
      for (const id of loaded) {
        if (!current()) return;
        if (source.removed.has(id)) continue;
        if (this.detached.has(`${source.config.id}:${id}`)) continue;
        if (!source.subscriptions.has(id)) {
          const key = `${source.config.id}:${id}`;
          if (this.locks.has(key)) continue;
          await this.locked(key, async () => {
          try {
            const result = await source.client.call<{ thread: Thread }>('thread/resume', { threadId: id, excludeTurns: true });
            if (!current()) return;
            source.subscriptions.add(id);
            this.upsert(source, result.thread);
          } catch {
            if (!current()) return;
            // Metadata remains available even if joining this thread is unsupported.
            const result = await source.client.call<{ thread: Thread }>('thread/read', { threadId: id });
            if (!current()) return;
            this.upsert(source, result.thread);
          }
          });
        } else if (!listedIds.has(id)) {
          const result = await source.client.call<{ thread: Thread }>('thread/read', { threadId: id });
          if (!current()) return;
          this.upsert(source, result.thread);
        }
      }
      await Promise.all([...source.external].map(async ([id, external]) => {
        const thread = this.threads.get(`${source.config.id}:${id}`);
        if (!fresh && external.checkedAt && Date.now() - external.checkedAt < 30_000) {
          if (thread) this.applyExternal(thread, external);
          return;
        }
        try {
          const result = await source.client.call<{ data: Turn[] }>('thread/turns/list', { threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'summary' });
          if (!current()) return;
          const turn = result.data[0];
          external.state = turn?.status === 'inProgress' ? 'running' : turn?.status === 'failed' ? 'error' : turn ? 'idle' : 'unknown';
          external.lastActivity = turn?.completedAt ? turn.completedAt * 1000 : turn?.startedAt ? turn.startedAt * 1000 : null;
          external.checkedAt = Date.now();
        } catch { warnings.push(`独立终端 session ${id} 的执行状态暂时无法读取`); }
        if (!current()) return;
        if (thread) this.applyExternal(thread, external);
      }));
      if (!current()) return;
      source.state.localWarning = warnings.length ? warnings.join('；') : null;
      source.state.lastSync = Date.now(); source.state.error = null;
      if (full) source.lastFullSync = source.state.lastSync;
      this.changed();
      void this.drain();
    } catch (error) { if (current()) { source.state.error = (error as Error).message; this.changed(); } }
    finally { if (generation === source.generation) { source.syncing = false; source.state.syncing = false; this.changed(); } }
  }
  private forget(source: Source, id: string) {
    this.details.invalidate(`${source.config.id}:${id}:`);
    this.threads.delete(`${source.config.id}:${id}`);
    source.subscriptions.delete(id);
    source.external.delete(id);
    source.localIds.delete(id);
    for (const [key, request] of this.pending) if (request.view.sourceId === source.config.id && request.view.threadId === id) this.pending.delete(key);
    const retained = this.store.data.queue.filter(q => q.sourceId !== source.config.id || q.threadId !== id);
    const wasDetached = this.detached.delete(`${source.config.id}:${id}`);
    if (retained.length !== this.store.data.queue.length || wasDetached) {
      this.store.data.queue = retained;
      this.store.data.detached = [...this.detached];
      void this.store.save().catch(error => { source.state.error = `保存队列失败：${error.message}`; this.changed(); });
    }
  }
  private notification(source: Source, message: any) {
    const p = message.params || {};
    const key = `${source.config.id}:${p.threadId}`;
    this.details.invalidate(`${source.config.id}:${p.threadId || p.thread?.id}:`);
    const thread = this.threads.get(key);
    const listChanged = (message.method.startsWith('thread/') && message.method !== 'thread/tokenUsage/updated') || ['turn/started', 'turn/completed', 'serverRequest/resolved', 'error'].includes(message.method);
    if (thread && listChanged) thread.lastActivity = Date.now();
    if (message.method === 'thread/status/changed' && thread) thread.state = runtimeState(p.status);
    if (message.method === 'thread/started' && p.thread) this.upsert(source, p.thread);
    if (message.method === 'thread/archived' || message.method === 'thread/deleted') { source.removed.add(p.threadId); this.forget(source, p.threadId); }
    if (message.method === 'thread/unarchived') { source.removed.delete(p.threadId || p.thread?.id); if (p.thread) this.upsert(source, p.thread); source.lastFullSync = null; void this.sync(source); }
    if (message.method === 'thread/name/updated' && thread) thread.title = p.threadName || p.name || thread.title;
    if (message.method === 'serverRequest/resolved') {
      for (const [id, request] of this.pending) if (request.view.sourceId === source.config.id && request.raw.id === p.requestId) this.pending.delete(id);
    }
    if (message.method === 'turn/completed') {
      if (thread && ['running', 'approval', 'input'].includes(thread.state)) thread.state = p.turn?.status === 'failed' ? 'error' : 'idle';
      for (const [id, request] of this.pending) if (request.view.sourceId === source.config.id && request.view.threadId === p.threadId && request.view.turnId === p.turn?.id) this.pending.delete(id);
      void this.drain();
    }
    // Text/tool/token-usage deltas invalidate only detail data. Avoid changing
    // list timestamps too, otherwise the next sync broadcasts every task again.
    if (listChanged) this.changed();
  }
  async older(sourceId: string) {
    await this.sync(this.getSource(sourceId), true);
  }
  async detail(sourceId: string, id: string, cursor?: string, fresh = false): Promise<ThreadDetail> {
    const source = this.getSource(sourceId);
    const generation = source.generation;
    if (source.removed.has(id)) throw new Error('这段会话已删除或归档');
    const result = await this.details.get(`${sourceId}:${id}:${generation}:${cursor || ''}`, () => this.readDetail(source, id, cursor), detail => {
      if (detail.warning) return 0;
      const thread = this.threads.get(`${sourceId}:${id}`) || detail.thread;
      return thread.externalPid ? 3000 : ['running', 'approval', 'input', 'unknown'].includes(thread.state) ? 3000 : thread.state === 'history' ? 60_000 : 30_000;
    }, fresh);
    if (!source.client.connected || source.generation !== generation) throw new Error('连接已变化，请等待重新同步');
    const thread = this.threads.get(`${sourceId}:${id}`);
    if (!thread || source.removed.has(id)) throw new Error('这段会话已删除或归档');
    return { ...result, thread };
  }
  private async readDetail(source: Source, id: string, cursor?: string): Promise<ThreadDetail> {
    const sourceId = source.config.id;
    const generation = source.generation;
    const { thread } = await source.client.call<{ thread: Thread }>('thread/read', { threadId: id });
    if (!source.client.connected || source.generation !== generation) throw new Error('连接已变化，请等待重新同步');
    if (source.removed.has(id)) throw new Error('这段会话已删除或归档');
    this.upsert(source, thread);
    const [turnResult, itemResult] = await Promise.allSettled([
      source.client.call<{ data: Turn[] }>('thread/turns/list', { threadId: id, limit: 8, sortDirection: 'desc', itemsView: 'summary' }),
      source.client.call<{ data: ThreadItemEntry[]; nextCursor: string | null }>('thread/items/list', { threadId: id, limit: 60, sortDirection: 'desc', ...(cursor ? { cursor } : {}) }),
    ]);
    let turns = turnResult.status === 'fulfilled' ? turnResult.value.data : [];
    let entries = itemResult.status === 'fulfilled' ? itemResult.value.data : [];
    let warning: string | null = turnResult.status === 'rejected' ? '当前执行状态暂时无法读取：' + turnResult.reason.message : null;
    if (itemResult.status === 'rejected' && thread.historyMode !== 'paginated') {
      const legacy = await source.client.call<{ thread: Thread }>('thread/read', { threadId: id, includeTurns: true });
      turns = legacy.thread.turns.slice(-8).reverse();
      warning = null;
      entries = turns.flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item, startedAtMs: turn.startedAt ? turn.startedAt * 1000 : null, completedAtMs: null }))).reverse().slice(0, 60);
    } else if (itemResult.status === 'rejected') warning = '当前 Codex 未返回会话内容：' + itemResult.reason.message;
    if (!source.client.connected || source.generation !== generation) throw new Error('连接已变化，请等待重新同步');
    const summary = this.threads.get(`${sourceId}:${id}`);
    if (!summary || source.removed.has(id)) throw new Error('这段会话已删除或归档');
    const external = source.external.get(id);
    if (external && turnResult.status === 'fulfilled') {
      const latest = turns[0];
      external.state = latest?.status === 'inProgress' ? 'running' : latest?.status === 'failed' ? 'error' : latest ? 'idle' : 'unknown';
      external.lastActivity = latest?.completedAt ? latest.completedAt * 1000 : latest?.startedAt ? latest.startedAt * 1000 : null;
      external.checkedAt = Date.now();
      this.applyExternal(summary, external);
    }
    return { thread: summary, turns: turns.slice(0, 8).map(t => ({ id: t.id, status: t.status, startedAt: t.startedAt ? t.startedAt * 1000 : null, completedAt: t.completedAt ? t.completedAt * 1000 : null, error: t.error?.message || null })), items: entries.slice(0, 60).reverse().map(e => timeline(e.item, e.turnId, e.startedAtMs)).filter((v): v is NonNullable<typeof v> => v !== null), nextCursor: itemResult.status === 'fulfilled' ? itemResult.value.nextCursor : null, warning };
  }
  private async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.locks.has(key)) throw new Error('该任务正在处理上一条操作，请稍后再试');
    this.locks.add(key);
    try { return await fn(); } finally { this.details.invalidate(`${key}:`); this.locks.delete(key); }
  }
  private async assertControllable(source: Source, ids: Set<string>) {
    if (this.demo || !source.config.codexHome) return;
    const owners = await this.local.owners(source.config.codexHome, true);
    if (![...ids].some(id => owners.has(id))) return;
    const loaded = new Set(await this.pages<string>(source, 'thread/loaded/list', { limit: 100 }));
    if ([...ids].some(id => owners.has(id) && !loaded.has(id))) throw new Error('原独立终端仍持有此会话或子对话。请在原终端结束当前执行并输入 /exit，再接入面板；也可以使用双端交互命令恢复同一会话。');
  }
  async deleteThread(sourceId: string, id: string) {
    const source = this.getSource(sourceId);
    return this.locked(`${sourceId}:${id}`, async () => {
      await this.assertControllable(source, new Set([id]));
      const children = (await Promise.all([false, true].map(archived => this.pages<Thread>(source, 'thread/list', { ...listParams, ancestorThreadId: id, archived })))).flat();
      const ids = new Set([id, ...children.map(t => t.id)]);
      let previousSize = 0;
      while (previousSize !== ids.size) {
        previousSize = ids.size;
        for (const thread of this.threads.values()) if (thread.sourceId === sourceId && thread.parentId && ids.has(thread.parentId)) ids.add(thread.id);
      }
      const childKeys = [...ids].filter(child => child !== id).map(child => `${sourceId}:${child}`);
      if (childKeys.some(key => this.locks.has(key))) throw new Error('子对话正在处理操作，请稍后再试');
      childKeys.forEach(key => this.locks.add(key));
      try {
        await this.assertControllable(source, ids);
        const threads = await Promise.all([...ids].map(threadId => source.client.call<{ thread: Thread }>('thread/read', { threadId })));
        if (threads.some(({ thread }) => thread.status.type === 'active')) throw new Error('会话或子对话仍在执行，请先停止后再删除');
        if (this.store.data.queue.some(q => q.sourceId === sourceId && ids.has(q.threadId) && q.status === 'sending')) throw new Error('会话仍在发送消息，请稍后再删除');
        // A timeout can mean the delete reached Codex. Never dispatch queued work
        // while that result is uncertain, including after a workbench restart.
        for (const item of this.store.data.queue) if (item.sourceId === sourceId && ids.has(item.threadId) && item.status === 'queued') { item.status = 'failed'; item.error = '已请求删除；队列暂停发送，请确认会话是否仍存在'; }
        await this.store.save();
        try { await source.client.call('thread/delete', { threadId: id }); }
        catch (error) {
          await this.store.audit({ id: randomUUID(), sourceId, threadId: id, at: Date.now(), action: '删除对话', outcome: error instanceof RpcError && error.uncertain ? 'uncertain' : 'failed', message: (error as Error).message });
          throw error;
        }
        for (const threadId of ids) { source.removed.add(threadId); this.forget(source, threadId); }
        await this.store.audit({ id: randomUUID(), sourceId, threadId: id, at: Date.now(), action: '删除对话', outcome: 'sent', message: '已永久删除对话及其子对话' });
        return { deletedIds: [...ids] };
      } finally { childKeys.forEach(key => this.locks.delete(key)); this.changed(); }
    });
  }
  async rename(sourceId: string, id: string, value: unknown) {
    const title = validateTitle(value);
    const source = this.getSource(sourceId);
    return this.locked(`${sourceId}:${id}`, async () => {
      if (source.removed.has(id)) throw new Error('这段会话已删除或归档');
      const { thread } = await source.client.call<{ thread: Thread }>('thread/read', { threadId: id });
      // Naming is metadata-only, including for historical and terminal-owned
      // sessions. Never resume or interrupt a conversation to change its name.
      try { await source.client.call('thread/name/set', { threadId: id, name: title }); }
      catch (error) {
        await this.store.audit({ id: randomUUID(), at: Date.now(), sourceId, threadId: id, action: '修改标题', outcome: error instanceof RpcError && error.uncertain ? 'uncertain' : 'failed', message: (error as Error).message });
        this.changed();
        throw error;
      }
      if (source.removed.has(id)) throw new Error('这段会话已删除或归档');
      if (!this.threads.has(`${sourceId}:${id}`)) this.upsert(source, thread);
      const summary = this.threads.get(`${sourceId}:${id}`)!;
      summary.title = title;
      await this.store.audit({ id: randomUUID(), at: Date.now(), sourceId, threadId: id, action: '修改标题', outcome: 'sent', message: `标题已修改为“${title}”` });
      this.changed();
      return summary;
    });
  }
  async resume(sourceId: string, id: string) {
    const source = this.getSource(sourceId);
    const generation = source.generation;
    const check = () => {
      if (!source.client.connected || source.generation !== generation) throw new RpcError('连接已变化，请重新确认会话状态', 'DISCONNECTED', true);
      if (source.removed.has(id)) throw new Error('这段会话已删除或归档');
    };
    return this.locked(`${sourceId}:${id}`, async () => {
      await this.assertControllable(source, new Set([id]));
      check();
      const result = await source.client.call<{ thread: Thread }>('thread/resume', { threadId: id, excludeTurns: true });
      check();
      if (this.detached.delete(`${sourceId}:${id}`)) { this.store.data.detached = [...this.detached]; await this.store.save(); }
      check();
      source.external.delete(id);
      source.subscriptions.add(id); this.upsert(source, result.thread); this.changed();
      return this.threads.get(`${sourceId}:${id}`);
    });
  }
  async detach(sourceId: string, id: string) {
    const source = this.getSource(sourceId);
    const key = `${sourceId}:${id}`;
    const generation = source.generation;
    const current = () => source.client.connected && source.generation === generation;
    return this.locked(key, async () => {
      await this.assertControllable(source, new Set([id]));
      const { thread } = await source.client.call<{ thread: Thread }>('thread/read', { threadId: id });
      if (!current()) throw new Error('连接已变化，请等待重新同步');
      if (source.removed.has(id)) throw new Error('这段会话已删除或归档');
      if (thread.status.type !== 'idle' && thread.status.type !== 'notLoaded') throw new Error('请先停止当前执行、处理权限确认，再退出面板连接');
      if ([...this.pending.values()].some(p => p.view.sourceId === sourceId && p.view.threadId === id)) throw new Error('请先处理当前会话的待确认请求');
      if (this.store.data.queue.some(q => q.sourceId === sourceId && q.threadId === id && q.status === 'sending')) throw new Error('会话正在发送消息，请稍后再退出');
      for (const item of this.store.data.queue) if (item.sourceId === sourceId && item.threadId === id && item.status === 'queued') { item.status = 'failed'; item.error = '已退出面板连接；待发送消息已暂停'; }
      // Persist intent before unsubscribing, including uncertain replies and
      // reconnects. Periodic discovery must never silently join it again.
      const wasDetached = this.detached.has(key);
      this.detached.add(key); this.store.data.detached = [...this.detached];
      try { await this.store.save(); }
      catch (error) { if (!wasDetached) this.detached.delete(key); this.store.data.detached = [...this.detached]; throw error; }
      try {
        if (!current()) throw new RpcError('连接已变化，已暂停自动接入，请重连后确认', 'DISCONNECTED', true);
        const result = await source.client.call<{ status: string }>('thread/unsubscribe', { threadId: id });
        if (!current()) throw new RpcError('连接已变化，退出结果需重新确认', 'DISCONNECTED', true);
        if (source.removed.has(id)) throw new Error('这段会话已删除或归档');
        if (!['unsubscribed', 'notSubscribed', 'notLoaded'].includes(result.status)) throw new RpcError('退出结果无法确认，请查看原终端', 'UNKNOWN_RESULT', true);
      } catch (error) {
        const uncertain = error instanceof RpcError && error.uncertain;
        if (!uncertain && !wasDetached) this.detached.delete(key);
        else source.subscriptions.delete(id);
        this.store.data.detached = [...this.detached];
        if (current()) this.upsert(source, thread);
        else { const summary = this.threads.get(key); if (summary) { summary.detached = this.detached.has(key); summary.subscribed = false; } }
        await this.store.audit({ id: randomUUID(), sourceId, threadId: id, at: Date.now(), action: '退出面板连接', outcome: uncertain ? 'uncertain' : 'failed', message: (error as Error).message });
        this.changed(); throw error;
      }
      source.subscriptions.delete(id); this.upsert(source, thread);
      await this.store.audit({ id: randomUUID(), sourceId, threadId: id, at: Date.now(), action: '退出面板连接', outcome: 'sent', message: '已取消面板订阅并暂停队列；历史保留，其他终端不受影响' });
      this.changed();
      const summary = this.threads.get(key);
      if (!summary || source.removed.has(id)) throw new Error('这段会话已删除或归档');
      return summary;
    });
  }
  async create(sourceId: string, cwd: string) {
    if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) throw new Error('请输入存在的绝对项目目录');
    const source = this.getSource(sourceId);
    const result = await source.client.call<{ thread: Thread }>('thread/start', { cwd, serviceName: 'codex-workbench' });
    source.subscriptions.add(result.thread.id); this.upsert(source, result.thread); this.changed();
    return this.threads.get(`${sourceId}:${result.thread.id}`);
  }
  async message(sourceId: string, id: string, text: string, mode: string, requestId: string, expectedTurnId?: string) {
    if (this.detached.has(`${sourceId}:${id}`)) throw new Error('已退出面板连接，请先重新接入');
    if (!text.trim() || text.length > 32000 || !['send', 'queue', 'steer'].includes(mode) || !/^[\w-]{8,100}$/.test(requestId)) throw new Error('消息或操作参数不正确');
    if (this.store.data.audit.some(e => e.id === requestId) || this.store.data.queue.some(e => e.id === requestId)) throw new Error('这条指令已提交，请先查看会话结果');
    const source = this.getSource(sourceId);
    return this.locked(`${sourceId}:${id}`, async () => {
      await this.assertControllable(source, new Set([id]));
      const { thread } = await source.client.call<{ thread: Thread }>('thread/read', { threadId: id });
      if (thread.status.type === 'notLoaded') throw new Error('请先连接此历史会话');
      const item: QueueItem = { id: requestId, sourceId, threadId: id, text: text.trim(), status: mode === 'queue' ? 'queued' : 'sending', createdAt: Date.now() };
      if (this.store.data.queue.length >= 100) throw new Error('待发送队列已满，请先处理已有消息');
      if (mode === 'send' && thread.status.type === 'active') throw new Error('任务已开始执行，请选择立即补充或加入队列');
      if (mode === 'steer' && (!expectedTurnId || thread.status.type !== 'active')) throw new Error('原执行轮次已结束，请刷新后重新发送');
      this.store.data.queue.push(item); await this.store.save(); this.changed();
      if (mode === 'queue') { void this.drain(); return; }
      await this.deliver(source, item, mode === 'steer' ? expectedTurnId : undefined);
    });
  }
  private async deliver(source: Source, item: QueueItem, expectedTurnId?: string) {
    item.status = 'sending'; await this.store.save(); this.changed();
    try {
      const input = [{ type: 'text', text: item.text, text_elements: [] }];
      await source.client.call(expectedTurnId ? 'turn/steer' : 'turn/start', { threadId: item.threadId, clientUserMessageId: item.id, input, ...(expectedTurnId ? { expectedTurnId } : {}) });
      this.store.data.queue = this.store.data.queue.filter(q => q.id !== item.id);
      await this.store.audit({ id: item.id, at: Date.now(), sourceId: item.sourceId, threadId: item.threadId, action: expectedTurnId ? '补充指令' : '发送指令', outcome: 'sent', message: 'Codex 已接收' });
    } catch (error) {
      item.status = error instanceof RpcError && error.uncertain ? 'uncertain' : 'failed'; item.error = (error as Error).message;
      await this.store.audit({ id: item.id, at: Date.now(), sourceId: item.sourceId, threadId: item.threadId, action: '发送指令', outcome: item.status === 'uncertain' ? 'uncertain' : 'failed', message: item.error });
      throw error;
    } finally { this.changed(); }
  }
  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      for (const item of [...this.store.data.queue]) {
        if (item.status !== 'queued' || this.locks.has(`${item.sourceId}:${item.threadId}`)) continue;
        if (this.detached.has(`${item.sourceId}:${item.threadId}`)) continue;
        const known = this.threads.get(`${item.sourceId}:${item.threadId}`);
        if (known && ['running', 'approval', 'input'].includes(known.state)) continue;
        const source = this.sources.get(item.sourceId);
        if (!source?.client.connected) continue;
        try {
          await this.locked(`${item.sourceId}:${item.threadId}`, async () => {
            if (!this.store.data.queue.includes(item) || item.status !== 'queued') return;
            await this.assertControllable(source, new Set([item.threadId]));
            const { thread } = await source.client.call<{ thread: Thread }>('thread/read', { threadId: item.threadId });
            if (thread.status.type === 'idle') await this.deliver(source, item);
          });
        } catch { /* Failed or uncertain deliveries stay visible and are never retried automatically. */ }
      }
    } finally { this.draining = false; }
  }
  async cancelQueue(id: string) {
    const item = this.store.data.queue.find(q => q.id === id);
    if (!item || item.status === 'sending') throw new Error('这条消息已发送或正在发送');
    await this.locked(`${item.sourceId}:${item.threadId}`, async () => {
      if (item.status === 'sending') throw new Error('这条消息正在发送');
      this.store.data.queue = this.store.data.queue.filter(q => q.id !== id); await this.store.save(); this.changed();
    });
  }
  async interrupt(sourceId: string, id: string, turnId: string) {
    if (!turnId) throw new Error('无法确认当前执行轮次，请刷新后重试');
    const source = this.getSource(sourceId);
    await this.locked(`${sourceId}:${id}`, async () => {
      await this.assertControllable(source, new Set([id]));
      // Persist the user's stop intent before sending the interrupt: a completion event
      // may arrive while the RPC is still in flight, but must not dispatch queued work.
      for (const item of this.store.data.queue) if (item.sourceId === sourceId && item.threadId === id && item.status === 'queued') { item.status = 'failed'; item.error = '任务已停止；队列暂停发送，请确认后重新提交'; }
      await this.store.save(); this.changed();
      await source.client.call('turn/interrupt', { threadId: id, turnId });
      await this.store.audit({ id: randomUUID(), sourceId, threadId: id, at: Date.now(), action: '停止执行', outcome: 'sent', message: '已请求中断，等待 Codex 返回结果' }); this.changed();
    });
  }
  async reply(key: string, reply: Reply) {
    const request = this.pending.get(key);
    if (!request || request.view.answering) throw new Error('此请求已处理或已失效，请等待状态更新');
    const source = this.getSource(request.view.sourceId);
    if (request.generation !== source.generation) throw new Error('审批连接已变化，请等待重新同步');
    const result = approvalResponse(request.view, request.raw, reply);
    request.view.answering = true;
    try { source.client.respond(request.raw.id, result); }
    catch (error) { request.view.answering = false; throw error; }
    await this.store.audit({ id: randomUUID(), at: Date.now(), sourceId: request.view.sourceId, threadId: request.view.threadId, action: request.view.kind === 'input' ? '回复问题' : '回复确认', outcome: 'sent', message: '已发送，等待服务端确认' }); this.changed();
  }
}
