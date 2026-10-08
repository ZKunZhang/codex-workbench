import type { RuntimeState, ThreadSummary } from '../shared/types.ts';

export const stateLabels: Record<RuntimeState, string> = { running: '执行中', approval: '待确认', input: '待回答', idle: '空闲', history: '历史记录', error: '异常', unknown: '状态未知' };
export const priority: Record<RuntimeState, number> = { approval: 0, input: 1, error: 2, running: 3, idle: 4, unknown: 5, history: 6 };
export const basename = (path: string) => path.split('/').filter(Boolean).at(-1) || path;
export const endpoint = (thread: ThreadSummary) => `threads/${encodeURIComponent(thread.sourceId)}/${encodeURIComponent(thread.id)}`;
export const time = (value?: number | null) => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
export function relative(value: number, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - value) / 60000));
  return minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes} 分钟前` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时前` : `${Math.floor(minutes / 1440)} 天前`;
}

export function deleteDisabledReason(thread: ThreadSummary, connected: boolean, busy: boolean): string | undefined {
  if (!connected) return '连接恢复后可删除对话';
  if (busy) return '正在处理操作，请稍后';
  if (thread.externalPid) return '请先退出原独立终端，再删除对话';
  if (['running', 'approval', 'input'].includes(thread.state)) return '请先停止当前执行，再删除对话';
  if (thread.state === 'unknown') return '正在确认会话状态，请稍后';
}
