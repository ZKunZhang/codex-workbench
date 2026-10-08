import type { Thread } from './protocol/v2/Thread.ts';
import type { ThreadItem } from './protocol/v2/ThreadItem.ts';
import type { RuntimeState, ThreadSummary, TimelineItem, PendingRequest, Reply } from '../shared/types.ts';

export const clip = (value: unknown, max = 24000) => typeof value === 'string' ? (value.length > max ? value.slice(0, max) + '\n… 内容已截断' : value) : '';
export function runtimeState(status: Thread['status'], connected = true): RuntimeState {
  if (!connected) return 'unknown';
  if (status?.type === 'active') {
    if (status.activeFlags.includes('waitingOnApproval')) return 'approval';
    if (status.activeFlags.includes('waitingOnUserInput')) return 'input';
    return 'running';
  }
  return status?.type === 'idle' ? 'idle' : status?.type === 'notLoaded' ? 'history' : status?.type === 'systemError' ? 'error' : 'unknown';
}
export function summarize(thread: Thread, sourceId: string, subscribed = false, lastActivity: number | null = null, codexHome: string | null = null): ThreadSummary {
  const subAgent = typeof thread.source === 'object' && 'subAgent' in thread.source ? thread.source.subAgent : null;
  const parentId = thread.parentThreadId || (subAgent && typeof subAgent === 'object' && 'thread_spawn' in subAgent ? subAgent.thread_spawn.parent_thread_id : null);
  return { id: thread.id, sessionId: thread.sessionId || thread.id, sourceId, key: `${sourceId}:${thread.id}`, title: clip(thread.name || thread.preview || '未命名会话', 90), preview: clip(thread.preview, 200), cwd: thread.cwd, codexHome, externalPid: null, state: runtimeState(thread.status), updatedAt: thread.updatedAt * 1000, createdAt: thread.createdAt * 1000, parentId, model: thread.model, branch: thread.gitInfo?.branch || null, subscribed, lastActivity };
}
export function timeline(item: ThreadItem, turnId: string, time?: number | null): TimelineItem | null {
  const base = { id: item.id, turnId, type: item.type, time };
  switch (item.type) {
    case 'userMessage': return { ...base, title: '你', text: clip(item.content.map(v => v.type === 'text' ? v.text : `[${v.type}]`).join('\n')) };
    case 'agentMessage': return { ...base, title: 'Codex', text: clip(item.text) };
    case 'commandExecution': return { ...base, title: '执行命令', text: clip(item.command), detail: clip(item.aggregatedOutput), status: item.status };
    case 'fileChange': return { ...base, title: '文件变更', text: item.changes.map(c => c.path).join('\n'), detail: clip(item.changes.map(c => c.diff).join('\n')), status: item.status };
    case 'plan': return { ...base, title: '执行计划', text: clip(item.text) };
    case 'mcpToolCall': return { ...base, title: `工具 · ${item.server}`, text: item.tool, detail: clip(JSON.stringify(item.result || item.error, null, 2)), status: item.status };
    case 'dynamicToolCall': return { ...base, title: '工具调用', text: item.tool, status: item.status };
    case 'collabAgentToolCall': return { ...base, title: '子代理', text: `${item.tool} · ${item.receiverThreadIds.length} 个会话`, status: item.status };
    case 'contextCompaction': return { ...base, title: '上下文整理', text: '会话上下文已压缩' };
    default: return null;
  }
}
export function pendingRequest(sourceId: string, generation: number, message: any): PendingRequest {
  const p = message.params || {};
  const common = { key: `${sourceId}:${generation}:${JSON.stringify(message.id)}`, sourceId, threadId: p.threadId || p.conversationId || '', turnId: p.turnId || null, method: message.method, description: clip(p.reason || p.message || ''), receivedAt: Date.now(), answering: false };
  if (message.method === 'item/commandExecution/requestApproval') return { ...common, kind: 'command', title: p.networkApprovalContext ? '网络访问确认' : '命令执行确认', command: clip(p.command), cwd: p.cwd, details: p.networkApprovalContext ? JSON.stringify(p.networkApprovalContext, null, 2) : undefined };
  if (message.method === 'item/fileChange/requestApproval') return { ...common, kind: 'file', title: '文件修改确认', details: p.grantRoot ? `授权目录：${p.grantRoot}` : undefined };
  if (message.method === 'item/permissions/requestApproval') return { ...common, kind: 'permissions', title: '额外权限确认', cwd: p.cwd, details: JSON.stringify(p.permissions, null, 2) };
  if (message.method === 'item/tool/requestUserInput') return { ...common, kind: 'input', title: '需要你的回答', questions: p.questions };
  if (message.method === 'mcpServer/elicitation/request') return { ...common, kind: 'mcp', title: `${p.serverName} 请求确认`, url: p.url, schema: p.requestedSchema };
  return { ...common, kind: 'unsupported', title: '请在原终端处理此请求' };
}
export function approvalResponse(request: PendingRequest, raw: any, reply: Reply): unknown {
  const p = raw.params;
  if (request.kind === 'input') {
    const answers: Record<string, { answers: string[] }> = {};
    for (const question of request.questions || []) {
      const answer = reply.answers?.[question.id];
      if (typeof answer !== 'string' || !answer.trim() || answer.length > 16000) throw new Error('请填写所有问题的回答');
      answers[question.id] = { answers: [answer.trim()] };
    }
    return { answers };
  }
  if (!['accept', 'decline', 'cancel'].includes(reply.decision || '')) throw new Error('无效的审批选择');
  if (request.kind === 'command' || request.kind === 'file') return { decision: reply.decision };
  if (request.kind === 'permissions') return { permissions: reply.decision === 'accept' ? p.permissions : {}, scope: 'turn' };
  if (request.kind === 'mcp') {
    if (request.schema && reply.decision === 'accept') throw new Error('此工具需要结构化表单，请在原终端填写；工作台可以拒绝或取消');
    return { action: reply.decision, content: null, _meta: null };
  }
  throw new Error('此请求类型需要在原终端处理');
}
