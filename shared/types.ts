export type RuntimeState = 'running' | 'approval' | 'input' | 'idle' | 'history' | 'error' | 'unknown';
export interface SourceConfig { id: string; name: string; socket?: string; url?: string; codexHome?: string }
export interface SourceState { id: string; name: string; codexHome: string | null; connected: boolean; error: string | null; localWarning: string | null; version: string | null; lastSync: number | null; hasMore: boolean; syncing: boolean; terminalAddress?: string }
export interface ThreadSummary {
  id: string; sessionId: string; sourceId: string; key: string; title: string; preview: string; cwd: string; codexHome: string | null; externalPid: number | null;
  state: RuntimeState; updatedAt: number; createdAt: number; parentId: string | null;
  model: string | null; branch: string | null; subscribed: boolean; detached?: boolean; lastActivity: number | null;
}
export interface TimelineItem { id: string; turnId: string; type: string; title: string; text: string; detail?: string; status?: string; time?: number | null }
export interface TurnSummary { id: string; status: string; startedAt: number | null; completedAt: number | null; error: string | null }
export interface ThreadDetail { thread: ThreadSummary; turns: TurnSummary[]; items: TimelineItem[]; nextCursor: string | null; warning: string | null }
export interface InputQuestion { id: string; header: string; question: string; isSecret?: boolean; options?: { label: string; description: string }[] | null }
export interface PendingRequest {
  key: string; sourceId: string; threadId: string; turnId: string | null; method: string;
  kind: 'command' | 'file' | 'permissions' | 'input' | 'mcp' | 'unsupported';
  title: string; description: string; command?: string; cwd?: string; details?: string;
  questions?: InputQuestion[]; url?: string; schema?: Record<string, unknown>;
  receivedAt: number; answering: boolean;
}
export interface QueueItem { id: string; sourceId: string; threadId: string; text: string; createdAt: number; status: 'queued' | 'sending' | 'uncertain' | 'failed'; error?: string }
export interface AuditEntry { id: string; at: number; sourceId: string; threadId: string; action: string; outcome: 'sent' | 'failed' | 'uncertain'; message: string }
export interface Snapshot { sources: SourceState[]; threads: ThreadSummary[]; pending: PendingRequest[]; queue: QueueItem[]; audit: AuditEntry[]; revision: number; demo: boolean }
export interface WorkbenchSession { token: string; snapshot: Snapshot; capabilities?: { renameThread?: boolean; detachThread?: boolean } }
export interface Reply { decision?: 'accept' | 'decline' | 'cancel'; answers?: Record<string, string>; content?: Record<string, unknown> }
