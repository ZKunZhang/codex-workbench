import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Activity, ArrowLeft, Bell, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, Clock3, Code2, Command, ExternalLink, Folder, GitBranch, Inbox, Layers, LoaderCircle, MessageSquare, PanelLeftClose, PanelLeftOpen, Pencil, Plus, RefreshCw, Search, Send, ShieldCheck, Square, Star, Terminal, Trash2, Unplug, X } from 'lucide-react';
import type { Snapshot, ThreadSummary, ThreadDetail, PendingRequest, Reply, RuntimeState, WorkbenchSession } from '../shared/types.ts';
import { api, setToken } from './api.ts';
import { taskTree } from './task-tree.ts';
import { TaskList } from './components/TaskList.tsx';
import { ActionMenu, IconButton, Modal, Status, ThreadIdentity } from './components/ui.tsx';
import { basename, deleteDisabledReason, endpoint, priority, time } from './format.ts';
import { terminalCommand } from '../shared/terminal.ts';
import { ConversationItem } from './components/ConversationItem.tsx';
import { MAX_TITLE_LENGTH, validateTitle } from '../shared/title.ts';
import { useVisibilityPolling } from './useVisibilityPolling.ts';
import { reconcileDetail, reconcileSnapshot } from './reconcile.ts';

const empty: Snapshot = { sources: [], threads: [], pending: [], queue: [], audit: [], revision: 0, demo: false };

function RequestCard({ request, reply, busy }: { request: PendingRequest; reply: (key: string, value: Reply) => Promise<void>; busy: boolean }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const disabled = busy || request.answering;
  const safeUrl = request.url && /^https?:\/\//i.test(request.url) ? request.url : null;
  return <section className="request-card">
    <div className="request-title"><ShieldCheck size={18} /><strong>{request.title}</strong><span>{request.answering ? '等待服务端确认' : '需要你处理'}</span></div>
    {request.description && <p>{request.description}</p>}
    {request.cwd && <div className="muted path" title={request.cwd}>{request.cwd}</div>}
    {request.command && <pre className="command-preview">{request.command}</pre>}
    {request.details && <details><summary>查看请求范围</summary><pre>{request.details}</pre></details>}
    {request.questions?.map(q => <fieldset key={q.id}><legend>{q.question}</legend>{q.options?.length ? <div className="answer-options">{q.options.map(option => <label className={answers[q.id] === option.label ? 'chosen' : ''} key={option.label}><input type="radio" name={request.key + q.id} checked={answers[q.id] === option.label} onChange={() => setAnswers({ ...answers, [q.id]: option.label })} disabled={disabled} /><span><b>{option.label}</b><small>{option.description}</small></span></label>)}</div> : null}<input type={q.isSecret ? 'password' : 'text'} aria-label={q.question} placeholder={q.options?.length ? '也可以输入自己的回答' : '请输入回答'} value={answers[q.id] || ''} onChange={e => setAnswers({ ...answers, [q.id]: e.target.value })} disabled={disabled} /></fieldset>)}
    {safeUrl && <a href={safeUrl} target="_blank" rel="noreferrer" className="external-link">打开工具确认页面 <ExternalLink size={14} /></a>}
    {request.schema && <p className="muted">此工具需要填写结构化表单，请在原终端完成。你也可以在这里拒绝。</p>}
    {request.kind === 'unsupported' ? <p className="muted">当前请求需要原终端提供的能力，请回到原终端处理。</p> : <div className="request-actions">{request.kind === 'input' ? <button className="button primary" disabled={disabled || request.questions?.some(q => !answers[q.id]?.trim())} onClick={() => void reply(request.key, { answers })}><Check size={16} />提交回答</button> : <><button className="button" disabled={disabled} onClick={() => void reply(request.key, { decision: 'decline' })}>拒绝</button>{!request.schema && <button className="button primary" disabled={disabled} onClick={() => void reply(request.key, { decision: 'accept' })}><Check size={16} />{request.kind === 'mcp' ? '已完成确认' : '允许本次'}</button>}</>}</div>}
  </section>;
}

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  const [connection, setConnection] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [supportsRename, setSupportsRename] = useState<boolean | null>(null);
  const [supportsDetach, setSupportsDetach] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [project, setProject] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [view, setView] = useState('all');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [favorites, setFavorites] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem('codex-workbench:favorites') || '[]'); } catch { return []; } });
  const [showChildren, setShowChildren] = useState(true);
  const [collapsedParents, setCollapsedParents] = useState<string[]>([]);
  const [approvalCenter, setApprovalCenter] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => { try { const saved = localStorage.getItem('codex-workbench:sidebar-collapsed'); return saved === null ? matchMedia('(max-width: 800px)').matches : saved === 'true'; } catch { return false; } });
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailTab, setDetailTab] = useState('conversation');
  const [text, setText] = useState('');
  const [mode, setMode] = useState('queue');
  const [busy, setBusy] = useState(false);
  const [newTask, setNewTask] = useState(false);
  const [connectTarget, setConnectTarget] = useState<ThreadSummary | null>(null);
  const [newCwd, setNewCwd] = useState('');
  const [newSource, setNewSource] = useState('');
  const [renameTarget, setRenameTarget] = useState<ThreadSummary | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [confirm, setConfirm] = useState<{ title: string; message: string; danger?: boolean; action: () => Promise<void> } | null>(null);
  const [now, setNow] = useState(Date.now());
  const detailSequence = useRef(0);
  const detailRequest = useRef<{ key: string; controller: AbortController; promise: Promise<void> } | null>(null);
  const [historyCursors, setHistoryCursors] = useState<string[]>([]);
  const historyCursorRef = useRef(historyCursors);
  historyCursorRef.current = historyCursors;
  const conversationRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  const previousRequests = useRef(new Set<string>());
  const notificationReady = useRef(false);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const selected = snapshot.threads.find(t => t.key === selectedKey) || null;
  const connected = connection === 'online' && !!snapshot.sources.find(s => s.id === selected?.sourceId)?.connected;
  const activeTurn = detail?.turns.find(t => t.status === 'inProgress');
  const requests = snapshot.pending.filter(r => r.sourceId === selected?.sourceId && r.threadId === selected?.id);
  const queued = snapshot.queue.filter(q => q.sourceId === selected?.sourceId && q.threadId === selected?.id);
  const running = !!selected && ['running', 'approval', 'input'].includes(selected.state);
  const target = snapshot.threads.find(t => t.key === connectTarget?.key) || connectTarget;
  const targetSource = snapshot.sources.find(s => s.id === target?.sourceId);
  const targetCommand = target && targetSource?.terminalAddress ? terminalCommand({ codexHome: target.codexHome || undefined, url: targetSource.terminalAddress }, target.id) : null;

  useEffect(() => {
    let stopped = false; let socket: WebSocket | undefined; let timer: ReturnType<typeof setTimeout>;
    const connect = async () => {
      try {
        const response = await api<WorkbenchSession>('session');
        if (stopped) return;
        setToken(response.token); setSnapshot(current => reconcileSnapshot(current, response.snapshot));
        setSupportsRename(response.capabilities?.renameThread === true);
        setSupportsDetach(response.capabilities?.detachThread === true);
        socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/events`, ['workbench', response.token]);
        socket.onopen = () => setConnection('online');
        socket.onmessage = e => { if (!stopped) { const next = JSON.parse(e.data); setSnapshot(current => reconcileSnapshot(current, next)); } };
        socket.onclose = () => { if (!stopped) { setConnection('offline'); setSnapshot(s => ({ ...s, threads: s.threads.map(t => ({ ...t, state: 'unknown' })) })); timer = setTimeout(connect, 2000); } };
        socket.onerror = () => socket?.close();
      } catch { if (!stopped) { setConnection('offline'); timer = setTimeout(connect, 3000); } }
    };
    void connect(); return () => { stopped = true; clearTimeout(timer); socket?.close(); };
  }, []);
  const refreshClock = useCallback(async () => { setNow(Date.now()); }, []);
  useVisibilityPolling(refreshClock, 60_000);
  useEffect(() => { try { localStorage.setItem('codex-workbench:favorites', JSON.stringify(favorites)); } catch { /* Preferences are optional. */ } }, [favorites]);
  useEffect(() => { try { localStorage.setItem('codex-workbench:sidebar-collapsed', String(sidebarCollapsed)); } catch { /* Preferences are optional. */ } }, [sidebarCollapsed]);
  useEffect(() => { if (notice) { const timer = setTimeout(() => setNotice(''), 4000); return () => clearTimeout(timer); } }, [notice]);
  useEffect(() => {
    if (notificationReady.current && 'Notification' in window && Notification.permission === 'granted') for (const request of snapshot.pending) if (!previousRequests.current.has(request.key)) new Notification('Codex 需要你处理', { body: request.title });
    previousRequests.current = new Set(snapshot.pending.map(p => p.key)); if (connection === 'online') notificationReady.current = true;
  }, [snapshot.pending, connection]);

  const refreshDetail = useCallback((initial = false, fresh = false, page?: string[]): Promise<void> => {
    if (!selected || !connected) return Promise.resolve();
    if (detailRequest.current?.key === selected.key && page === undefined) return detailRequest.current.promise;
    detailRequest.current?.controller.abort();
    const sequence = ++detailSequence.current;
    const controller = new AbortController();
    if (initial) setLoadingDetail(true);
    const promise = (async () => {
      try {
        const cursors = page ?? historyCursorRef.current;
        const query = new URLSearchParams();
        if (cursors.length) query.set('cursor', cursors.at(-1)!);
        if (fresh) query.set('refresh', '1');
        const next = await api<ThreadDetail>(endpoint(selected) + (query.size ? '?' + query : ''), undefined, controller.signal);
        if (sequence !== detailSequence.current) return;
        // A page replaces the previous page. Never accumulate an entire session
        // through polling or history navigation in the browser heap and DOM.
        setDetail(current => reconcileDetail(current, next));
        if (page) { historyCursorRef.current = page; setHistoryCursors(page); }
        setDetailError('');
      } catch (error) { if (!controller.signal.aborted && sequence === detailSequence.current) setDetailError((error as Error).message); }
      finally {
        if (sequence === detailSequence.current) setLoadingDetail(false);
        if (detailRequest.current?.controller === controller) detailRequest.current = null;
      }
    })();
    detailRequest.current = { key: selected.key, controller, promise };
    return promise;
  }, [selectedKey, connected]);
  useEffect(() => { setDetail(null); setDetailError(''); setText(''); setLoadingDetail(!!selectedKey); stickBottom.current = true; historyCursorRef.current = []; setHistoryCursors([]); }, [selectedKey]);
  useEffect(() => () => { ++detailSequence.current; detailRequest.current?.controller.abort(); detailRequest.current = null; }, [refreshDetail]);
  useVisibilityPolling(refreshDetail, !selected || !connected || historyCursors.length ? null : selected.detached ? Infinity : running || selected.externalPid || selected.state === 'unknown' ? 3000 : selected.state === 'history' ? 60_000 : 30_000);
  useEffect(() => { if (stickBottom.current) conversationRef.current?.scrollTo({ top: conversationRef.current.scrollHeight }); }, [detail?.items]);
  const choose = useCallback((thread: ThreadSummary) => {
    setSelectedKey(thread.key); setDetailTab('conversation');
    const parents: string[] = []; let current = thread;
    while (current.parentId) { const key = `${current.sourceId}:${current.parentId}`; if (parents.includes(key)) break; parents.push(key); const parent = snapshotRef.current.threads.find(t => t.key === key); if (!parent) break; current = parent; }
    setCollapsedParents(values => values.filter(key => !parents.includes(key)));
  }, []);
  const closeMobileSidebar = () => { if (matchMedia('(max-width: 800px)').matches) setSidebarCollapsed(true); };
  const showAll = () => { setView('all'); setProject('all'); setSourceFilter('all'); setFilter('all'); setSearch(''); setShowChildren(true); closeMobileSidebar(); };
  async function act(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  const connectedSourceKey = JSON.stringify(snapshot.sources.filter(source => source.connected).map(source => source.id));
  const connectedSources = useMemo(() => new Set<string>(JSON.parse(connectedSourceKey)), [connectedSourceKey]);
  const deleteReason = useCallback((thread: ThreadSummary) => deleteDisabledReason(thread, connection === 'online' && connectedSources.has(thread.sourceId), busy), [connection, connectedSources, busy]);
  const requestDelete = useCallback((thread: ThreadSummary) => {
    if (deleteReason(thread)) return;
    setError('');
    setConfirm({
      title: '永久删除这段对话？',
      danger: true,
      message: `将永久删除“${thread.title}”及其所有子对话，并移除相关待发送消息。此操作无法撤销，已修改的项目文件会保留。来源：${snapshotRef.current.sources.find(source => source.id === thread.sourceId)?.name}。`,
      action: async () => {
        const { deletedIds } = await api<{ deletedIds: string[] }>(`${endpoint(thread)}/delete`, { confirm: true });
        const keys = new Set(deletedIds.map(id => `${thread.sourceId}:${id}`));
        if (selectedKey && keys.has(selectedKey)) { ++detailSequence.current; setText(''); }
        setSnapshot(current => ({ ...current, threads: current.threads.filter(item => !keys.has(item.key)), pending: current.pending.filter(item => !keys.has(`${item.sourceId}:${item.threadId}`)), queue: current.queue.filter(item => !keys.has(`${item.sourceId}:${item.threadId}`)) }));
        setFavorites(values => values.filter(key => !keys.has(key)));
        setCollapsedParents(values => values.filter(key => !keys.has(key)));
        setSelectedKey(key => key && keys.has(key) ? null : key);
        setDetail(current => current && keys.has(current.thread.key) ? null : current);
        setNotice('对话已永久删除');
      },
    });
  }, [deleteReason, selectedKey]);
  async function reply(key: string, value: Reply) { await act(async () => { await api(`requests/${encodeURIComponent(key)}`, value); setNotice('回答已发送，等待 Codex 确认'); }); }
  function send(e?: FormEvent) {
    e?.preventDefault(); if (!selected || !text.trim()) return;
    void act(async () => { await api(`${endpoint(selected)}/message`, { text, mode: running ? mode : 'send', requestId: crypto.randomUUID(), turnId: activeTurn?.id }); setText(''); setNotice(running && mode === 'queue' ? '已加入待发送队列' : '指令已发送'); await refreshDetail(); });
  }
  const projects = useMemo(() => [...new Set(snapshot.threads.map(t => t.cwd))].sort(), [snapshot.threads]);
  const visibleThreads = useMemo(() => snapshot.threads.filter(t => (showChildren || !t.parentId) && (sourceFilter === 'all' || t.sourceId === sourceFilter) && (project === 'all' || t.cwd === project) && (view !== 'favorites' || favorites.includes(t.key)) && (view !== 'inbox' || ['approval', 'input', 'error'].includes(t.state) || snapshot.pending.some(r => r.sourceId === t.sourceId && r.threadId === t.id)) && (filter === 'all' || (filter === 'active' ? ['running', 'approval', 'input'].includes(t.state) || !!t.externalPid : filter === 'waiting' ? ['approval', 'input'].includes(t.state) : t.state === 'history')) && `${t.title} ${t.cwd} ${t.id} ${t.sessionId || ''} ${t.codexHome || ''}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => priority[a.state] - priority[b.state] || b.updatedAt - a.updatedAt), [snapshot.threads, snapshot.pending, showChildren, sourceFilter, project, view, favorites, filter, search]);
  const count = (states: RuntimeState[]) => snapshot.threads.filter(t => !t.parentId && states.includes(t.state)).length;
  const inboxCount = Math.max(snapshot.pending.length, count(['approval', 'input', 'error']));
  const pageTitle = sourceFilter !== 'all' ? snapshot.sources.find(s => s.id === sourceFilter)?.name || '连接来源' : view === 'inbox' ? '待处理事项' : view === 'favorites' ? '收藏任务' : project === 'all' ? '所有任务' : basename(project);
  const toggleStar = (key: string) => setFavorites(values => values.includes(key) ? values.filter(v => v !== key) : [...values, key]);

  const tree = useMemo(() => taskTree(snapshot.threads, visibleThreads, (a, b) => priority[a.state] - priority[b.state] || b.updatedAt - a.updatedAt), [snapshot.threads, visibleThreads]);
  const favoriteKeys = useMemo(() => new Set(favorites), [favorites]);
  const collapsedKeys = useMemo(() => new Set(collapsedParents), [collapsedParents]);
  const sourceNames = useMemo(() => new Map(snapshot.sources.map(source => [source.id, source.name])), [snapshot.sources]);
  const toggleParent = useCallback((key: string) => setCollapsedParents(values => values.includes(key) ? values.filter(value => value !== key) : [...values, key]), []);

  return <div className={`app ${selected ? 'has-selection' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : 'sidebar-expanded'}`}>
    {!sidebarCollapsed && <button className="sidebar-backdrop" aria-label="关闭导航菜单" onClick={() => setSidebarCollapsed(true)} />}
    <aside className="sidebar" id="workspace-navigation">
      <a className="brand" href="/" aria-label="Codex 工作台首页"><span className="brand-mark"><Terminal size={24} /></span><span>Codex <b>工作台</b><small>LOCAL WORKSPACE</small></span></a>
      <button className="new-task" onClick={() => { setNewSource(snapshot.sources.find(s => s.connected && (sourceFilter === 'all' || s.id === sourceFilter))?.id || ''); setNewCwd(selected?.cwd || (project !== 'all' ? project : '')); setNewTask(true); }} disabled={!snapshot.sources.some(s => s.connected)}><Plus size={18} />新建会话</button>
      <div className="nav-label">工作空间</div>
      <nav className="primary-nav">
        <button className={view === 'all' && project === 'all' ? 'active' : ''} aria-label="所有任务" onClick={showAll}><Layers size={18} />所有任务<span>{snapshot.threads.length}</span></button>
        <button className={view === 'inbox' ? 'active' : ''} onClick={() => { setView('inbox'); setProject('all'); setFilter('all'); closeMobileSidebar(); }}><Inbox size={18} />待处理事项{inboxCount > 0 && <span className="nav-count">{inboxCount}</span>}</button>
        <button className={view === 'favorites' ? 'active' : ''} onClick={() => { setView('favorites'); setProject('all'); setFilter('all'); closeMobileSidebar(); }}><Star size={18} />收藏任务</button>
      </nav>
      <div className="nav-label projects-title">项目<span>{projects.length}</span></div>
      <nav className="projects">{projects.map(path => <button title={path} className={project === path ? 'active' : ''} key={path} onClick={() => { setView('all'); setProject(path); closeMobileSidebar(); }}><Folder size={16} /><span>{basename(path)}</span>{snapshot.threads.some(t => t.cwd === path && t.state === 'running') && <i className="project-active" />}</button>)}{projects.length === 0 && <p className="sidebar-note">连接后会自动发现项目</p>}</nav>
      <div className="sidebar-bottom"><div className="nav-label">连接来源</div>{snapshot.sources.map(source => <button className={`source ${sourceFilter === source.id ? 'selected' : ''}`} key={source.id} title={source.error || source.codexHome || `上次同步：${time(source.lastSync)}`} onClick={() => { setSourceFilter(source.id); setView('all'); setProject('all'); setFilter('all'); setSearch(''); setShowChildren(true); setSelectedKey(null); closeMobileSidebar(); }}><span className={`connection-dot ${source.connected ? 'online' : 'offline'}`} /><span className="source-info"><strong>{source.name} · {snapshot.threads.filter(t => t.sourceId === source.id).length}</strong><small>{source.connected ? `已连接${source.version ? ` · ${source.version}` : ''}` : '正在重新连接'}</small></span></button>)}<div className="local-caption"><ShieldCheck size={14} />仅本机访问 · 数据保留在本机</div></div>
    </aside>
    <main className="workspace">
      <header className="topbar"><div className="breadcrumb"><button type="button" className="icon-button sidebar-toggle" aria-label={sidebarCollapsed ? '展开左侧菜单' : '折叠左侧菜单'} title={sidebarCollapsed ? '展开左侧菜单' : '折叠左侧菜单'} aria-expanded={!sidebarCollapsed} aria-controls="workspace-navigation" onClick={() => setSidebarCollapsed(value => !value)}>{sidebarCollapsed ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}</button><Command size={17} /><span>工作空间</span><ChevronRight size={14} /><strong>{pageTitle}</strong></div><div className="topbar-right"><button className={`approval-entry ${snapshot.pending.length ? 'has-pending' : ''}`} onClick={() => setApprovalCenter(true)}><ShieldCheck size={16} /><span>权限确认</span><b>{snapshot.pending.length}</b></button><IconButton label="新建会话" disabled={!snapshot.sources.some(s => s.connected)} onClick={() => { setNewSource(snapshot.sources.find(s => s.connected && (sourceFilter === 'all' || s.id === sourceFilter))?.id || ''); setNewCwd(selected?.cwd || (project !== 'all' ? project : '')); setNewTask(true); }}><Plus size={19} /></IconButton><span className={`live-label ${connection}`}><span className="connection-dot" />{connection === 'online' ? '实时同步' : connection === 'connecting' ? '正在连接' : '连接中断'}</span><IconButton label="启用浏览器通知" onClick={() => { if ('Notification' in window) void Notification.requestPermission().then(p => setNotice(p === 'granted' ? '已启用待处理通知' : '浏览器未允许通知')); else setNotice('当前浏览器不支持通知'); }}><Bell size={18} /></IconButton></div></header>
      {snapshot.demo && <div className="demo-banner">演示模式 · 当前显示模拟任务，操作不会影响真实 Codex 会话。</div>}
      {connection === 'offline' && <div className="connection-banner"><Unplug size={16} />工作台连接已断开，正在重连。任务继续在 Codex 中运行，恢复连接后再操作。</div>}
      {snapshot.sources.filter(s => s.error || s.localWarning).map(s => <div className="connection-banner" key={s.id}><Unplug size={16} /><span>{s.name}：{s.error || s.localWarning}</span></div>)}
      {connection === 'online' && supportsRename === false && <div className="connection-banner" role="status"><RefreshCw size={15} />工作台后台版本较旧，需重启工作台服务后才能修改标题；仅刷新页面无效，Codex 无需重启。</div>}
      <section className="work-area">
        <section className="task-panel"><div className="panel-heading"><h2>任务列表 <span>{visibleThreads.length}</span></h2><label className="children-toggle" title="包含子代理会话"><input type="checkbox" checked={showChildren} onChange={e => setShowChildren(e.target.checked)} />子代理</label></div>
          <label className="search"><Search size={17} /><input aria-label="搜索任务或项目" placeholder="搜索任务、Session ID 或 CODEX_HOME…" value={search} onChange={e => setSearch(e.target.value)} /><kbd>⌕</kbd></label>
          <label className="source-filter"><span>来源</span><select aria-label="按 CODEX_HOME 筛选" value={sourceFilter} onChange={e => { setSourceFilter(e.target.value); setSelectedKey(null); }}>{[['all', '全部 CODEX_HOME'], ...snapshot.sources.map(s => [s.id, s.codexHome || s.name])].map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
          <div className="filter-tabs">{[['all', '全部'], ['active', '进行中'], ['waiting', '待处理'], ['history', '历史']].map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div>
          <div className="task-list"><TaskList nodes={tree} selectedKey={selectedKey} favorites={favoriteKeys} collapsed={collapsedKeys} expandAll={!!search.trim() || view === 'inbox' || filter === 'waiting'} sourceNames={sourceNames} now={now} onSelect={choose} onDelete={requestDelete} onToggle={toggleParent} deleteReason={deleteReason} />{visibleThreads.length === 0 && <div className="list-empty"><Search size={28} /><strong>{snapshot.sources.some(s => s.connected) ? '没有匹配的任务' : '等待 Codex 连接'}</strong><p>{snapshot.sources.some(s => s.connected) ? '试试其他筛选条件或新建一个会话。' : '请确认本机 Codex 服务正在运行。'}</p></div>}{snapshot.sources.some(s => s.syncing && s.hasMore) && <div className="loading loading-tasks"><LoaderCircle size={16} className="spin" />正在加载全部任务…</div>}</div>
          <div className="list-footer"><span className="connection-dot online" />{snapshot.sources.some(s => s.syncing && !s.lastSync) ? '正在同步全部任务…' : `已显示 ${visibleThreads.length} / ${snapshot.threads.length} 个任务`}</div>
        </section>
        <section className="detail-panel">{selected ? <><div className="detail-heading"><IconButton className="back-button" label="返回任务列表" onClick={() => setSelectedKey(null)}><ArrowLeft size={20} /></IconButton><div className="detail-title"><div className="detail-title-line"><h2>{selected.title}</h2><IconButton label="修改标题" hint={supportsRename ? '修改标题' : '请重启工作台服务以启用修改标题'} className="rename-thread" disabled={!connected || busy || !supportsRename} onClick={() => { setError(''); setNewTitle(selected.title); setRenameTarget(selected); }}><Pencil size={13} /></IconButton></div><div><Status state={selected.state} /><span title={selected.cwd}><Folder size={13} />{basename(selected.cwd)}</span>{selected.branch && <span><GitBranch size={13} />{selected.branch}</span>}</div></div><IconButton label={favorites.includes(selected.key) ? '取消收藏' : '收藏任务'} onClick={() => toggleStar(selected.key)}><Star size={18} fill={favorites.includes(selected.key) ? 'currentColor' : 'none'} /></IconButton><IconButton label="刷新会话" onClick={() => void refreshDetail(true, true)} disabled={loadingDetail}><RefreshCw size={17} className={loadingDetail ? 'spin' : ''} /></IconButton><IconButton label="删除对话" hint={deleteReason(selected) || '永久删除对话及其子对话'} className="delete-thread" disabled={!!deleteReason(selected)} onClick={() => requestDelete(selected)}><Trash2 size={17} /></IconButton><ActionMenu key={selected.key} label="会话操作" actions={[
            { label: '终端与面板交互', icon: <Terminal size={14} />, onClick: () => { setError(''); setConnectTarget(selected); } },
            {
              label: '退出面板连接', icon: <Unplug size={14} />,
              disabled: !connected || busy || running || !!selected.externalPid || selected.state === 'history' || selected.detached || !supportsDetach,
              hint: !supportsDetach ? '请重启工作台后台以启用退出操作' : selected.externalPid ? '请在原独立终端输入 /exit' : running ? '请先停止当前执行' : '取消面板订阅并暂停待发送消息，保留历史',
              onClick: () => setConfirm({ title: '退出这段会话的面板连接？', message: '将暂停待发送消息并取消面板订阅，历史记录保留。其他终端会继续运行；Codex 服务按自身空闲回收机制释放会话，并非立即关闭。', action: async () => { const thread = await api<ThreadSummary>(`${endpoint(selected)}/detach`, { confirm: true }); setSnapshot(current => ({ ...current, threads: current.threads.map(item => item.key === thread.key ? thread : item) })); setSelectedKey(null); setDetail(null); setText(''); setNotice('已退出面板连接，历史记录保留'); } }),
            },
            { label: '关闭当前对话', icon: <X size={14} />, onClick: () => setSelectedKey(null) },
          ]} /></div>
          <div className="detail-identity"><ThreadIdentity thread={selected} />{selected.externalPid && <p><Terminal size={14} />独立终端 · PID {selected.externalPid} · 自动同步进展</p>}</div>
          <div className="detail-tabs">{[['conversation', '对话与执行'], ['files', '文件变更'], ['activity', '操作记录']].map(([value, label]) => <button className={detailTab === value ? 'active' : ''} onClick={() => setDetailTab(value)} key={value}>{label}</button>)}<span className="model-label">{selected.model || '模型未提供'}</span></div>
          {(requests.length > 0 || ['approval', 'input'].includes(selected.state)) && <div className="approval-panel" aria-label="当前任务权限确认"><div className="approval-panel-title"><ShieldCheck size={15} />需要你确认</div>{requests.map(request => <RequestCard key={request.key} request={request} reply={reply} busy={busy || !connected} />)}{!requests.length && <div className="pending-hint"><CircleHelp size={16} /><span>Codex 正在等待确认，但当前连接没有收到请求内容。请在原终端处理。</span></div>}</div>}
          <div className="conversation" ref={conversationRef} onScroll={() => { const el = conversationRef.current; if (el) stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>
            {detailError && <div className="inline-error">{detailError}</div>}{detail?.warning && <div className="inline-error">{detail.warning}</div>}
            {loadingDetail && !detail && <div className="loading"><LoaderCircle className="spin" size={22} />正在读取会话…</div>}
            {detailTab !== 'activity' && <div className="history-navigation">{detail?.nextCursor && <button className="button" disabled={busy || loadingDetail} onClick={() => { stickBottom.current = false; void refreshDetail(true, false, [...historyCursors, detail.nextCursor!]); }}>更早一页</button>}{historyCursors.length > 0 && <><button className="button" disabled={busy || loadingDetail} onClick={() => void refreshDetail(true, false, historyCursors.slice(0, -1))}>较新一页</button><button className="button" disabled={busy || loadingDetail} onClick={() => { stickBottom.current = true; void refreshDetail(true, false, []); }}>回到最新</button><span>第 {historyCursors.length + 1} 页 · 历史浏览</span></>}</div>}
            {detailTab === 'activity' ? <div className="audit-list">{snapshot.audit.filter(a => a.sourceId === selected.sourceId && a.threadId === selected.id).map(a => <div className="audit-item" key={a.id}><span className={`audit-dot ${a.outcome}`} /><div><strong>{a.action}</strong><p>{a.message}</p></div><time>{time(a.at)}</time></div>)}{!snapshot.audit.some(a => a.sourceId === selected.sourceId && a.threadId === selected.id) && <div className="list-empty"><Clock3 size={28} /><p>从工作台发起的操作会记录在这里。</p></div>}</div> : detail?.items.filter(i => detailTab === 'files' ? i.type === 'fileChange' : true).map(item => <ConversationItem key={item.id} item={item} />)}
            {!loadingDetail && detailTab === 'files' && !detail?.items.some(i => i.type === 'fileChange') && <div className="list-empty"><Code2 size={28} /><p>已加载的记录中没有文件变更。</p></div>}
            {!loadingDetail && detail && detail.items.length === 0 && detailTab === 'conversation' && <div className="list-empty"><MessageSquare size={28} /><strong>会话已就绪</strong><p>在下方输入指令，开始一项工作。</p></div>}
            {activeTurn && <div className="turn-indicator"><LoaderCircle size={15} className="spin" /><span>{running ? 'Codex 正在处理' : '最近执行轮次尚未返回结束状态'}</span>{activeTurn.startedAt && <time>开始于 {time(activeTurn.startedAt)}</time>}</div>}
            {!activeTurn && detail?.turns[0] && <div className="turn-indicator"><CheckCheck size={16} /><span>{detail.turns[0].status === 'completed' ? '本轮已完成' : detail.turns[0].status === 'interrupted' ? '本轮已停止' : detail.turns[0].status === 'failed' ? '本轮执行失败' : detail.turns[0].status}</span><time>{time(detail.turns[0].completedAt)}</time>{detail.turns[0].error && <p>{detail.turns[0].error}</p>}</div>}
          </div>
          {queued.length > 0 && <div className="queue-list">{queued.map(q => <div key={q.id}><Clock3 size={15} /><span><b>{q.status === 'queued' ? '等待本轮结束' : q.status === 'sending' ? '正在发送' : q.status === 'uncertain' ? '发送结果待确认' : '发送已暂停'}</b><small title={q.text}>{q.error ? `${q.error} · ${q.text}` : q.text}</small></span><IconButton label="移除队列消息" disabled={busy || q.status === 'sending'} onClick={() => setConfirm({ title: '移除这条队列消息？', message: q.status === 'uncertain' ? '移除记录不会撤回可能已经送达 Codex 的消息，请先查看会话结果。' : '移除后，这条消息不会自动发送。', action: async () => { await api(`queue/${q.id}/cancel`, {}); } })}><X size={15} /></IconButton></div>)}</div>}
          {selected.detached ? <div className="resume-bar"><div><Unplug size={18} /><span>已退出面板连接 · 历史记录保留</span></div><button className="button primary" disabled={!connected || busy} onClick={() => void act(async () => { const thread = await api<ThreadSummary>(`${endpoint(selected)}/resume`, {}); setSnapshot(current => ({ ...current, threads: current.threads.map(item => item.key === thread.key ? thread : item) })); setNotice('已重新接入'); await refreshDetail(true, true); })}>重新接入</button></div> : selected.externalPid ? <div className="resume-bar external-session"><div><Terminal size={18} /><span>终端独立运行 · 接入后可在面板对话与确认权限</span></div><button className="button primary" disabled={!connected || busy} onClick={() => { setError(''); setConnectTarget(selected); }}>接入交互</button></div> : selected.state === 'history' ? <div className="resume-bar"><div><Clock3 size={18} /><span>历史会话 · 连接后可继续对话</span></div><button className="button primary" disabled={!connected || busy} onClick={() => setConfirm({ title: '连接这段历史会话？', message: '将在当前 Codex 服务中恢复上下文。若原独立终端仍在执行这段会话，请先停止原执行，避免两个服务同时写入。', action: async () => { await api(`${endpoint(selected)}/resume`, {}); setNotice('会话已连接'); await refreshDetail(true); } })}>连接会话</button></div> : <form className="composer" onSubmit={send}><textarea aria-label="给 Codex 发送指令" placeholder={connected ? running ? '补充说明，或安排下一步工作…' : '输入指令，继续这段会话…' : '连接恢复后即可发送指令'} value={text} onChange={e => setText(e.target.value)} disabled={!connected || busy} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(e); }} /><div className="composer-bottom"><div>{running && <select aria-label="指令发送方式" value={mode} onChange={e => setMode(e.target.value)}><option value="queue">本轮结束后发送</option><option value="steer">立即补充当前任务</option></select>}{!running && <span className="composer-hint">⌘ / Ctrl + Enter 发送</span>}</div><div className="composer-actions">{running && <button type="button" className="button stop" disabled={!connected || busy || !activeTurn} onClick={() => setConfirm({ title: '停止当前执行？', message: '会请求 Codex 中断当前轮次，同时暂停本会话的待发送队列。已完成的文件修改会保留。', action: async () => { await api(`${endpoint(selected)}/interrupt`, { turnId: activeTurn?.id }); setNotice('已请求停止，等待 Codex 确认'); await refreshDetail(); } })}><Square size={13} />停止</button>}<button className="button primary" type="submit" disabled={!connected || busy || !text.trim() || (running && mode === 'steer' && !activeTurn)}>{busy ? <LoaderCircle size={16} className="spin" /> : <Send size={15} />}{running && mode === 'queue' ? '加入队列' : '发送'}</button></div></div></form>}
        </> : <div className="detail-empty"><div className="empty-art"><Terminal size={32} /><span /><i /></div><div className="eyebrow">YOUR WORK, IN VIEW</div><h2>选一个任务，看看进展</h2><p>查看对话、执行记录和文件变更，<br />也可以直接回复确认或安排下一步工作。</p><div className="empty-features"><span><Activity size={15} />执行动态</span><span><ShieldCheck size={15} />待处理确认</span><span><MessageSquare size={15} />继续对话</span></div></div>}</section>
      </section>
    </main>
    {error && <div className="toast error" role="alert"><span>{error}</span><IconButton label="关闭错误提示" onClick={() => setError('')}><X size={16} /></IconButton></div>}{notice && <div className="toast" role="status"><Check size={17} /><span>{notice}</span></div>}
    {approvalCenter && <Modal title="权限确认" close={() => { if (!busy) setApprovalCenter(false); }}><div className="approval-center">{snapshot.pending.length ? snapshot.pending.map(request => { const thread = snapshot.threads.find(t => t.sourceId === request.sourceId && t.id === request.threadId); const source = snapshot.sources.find(s => s.id === request.sourceId); return <section className="approval-center-item" key={request.key}><div className="approval-context"><strong>{thread?.title || request.threadId || '当前请求'}</strong>{thread && <button className="button" onClick={() => { choose(thread); setShowChildren(true); setApprovalCenter(false); }}>查看任务</button>}<code>Session ID: {thread?.sessionId || request.threadId || '未提供'}</code><code>CODEX_HOME: {source?.codexHome || '未提供'}</code></div><RequestCard request={request} reply={reply} busy={busy || connection !== 'online' || !source?.connected} /></section>; }) : <div className="approval-empty"><ShieldCheck size={28} /><strong>当前没有可处理的权限请求</strong><p>收到命令执行、文件修改等确认后，会显示在这里。</p><p>独立终端会话可从任务详情的“接入交互”切换到共享服务，之后在这里处理确认。</p></div>}</div></Modal>}
    {target && <Modal title="终端与面板交互" close={() => { if (!busy) setConnectTarget(null); }}><div className="connect-session">{error && <div className="inline-error" role="alert">{error}</div>}<p><strong>{target.title}</strong></p><ThreadIdentity thread={target} />{target.externalPid ? <><p>这段会话当前运行在独立终端。接入共享服务后，终端与面板可以共同发送消息、回答问题和确认权限。</p><ol><li>在原终端完成或停止当前执行，然后输入 <code>/exit</code> 退出 Codex。</li><li>只在面板继续：点击下方“接入面板”。保留终端交互：退出后在终端执行下面的命令。</li></ol><p className="muted">保留原会话与记录。面板会检查原进程是否已退出；不会强制结束正在运行的任务。</p></> : <p>此命令在终端打开同一服务中的原会话，可与面板共同对话、处理权限确认。</p>}{targetCommand && <div className="terminal-command"><pre>{targetCommand}</pre><button className="button" disabled={busy} onClick={() => void act(async () => { await navigator.clipboard.writeText(targetCommand); setNotice('双端交互命令已复制'); })}>复制命令</button></div>}{!targetCommand && <p className="muted">当前来源未提供终端地址。</p>}<div className="modal-actions"><button className="button" disabled={busy} onClick={() => setConnectTarget(null)}>关闭</button>{(target.externalPid || target.state === 'history') && <button className="button primary" disabled={busy || connection !== 'online' || !targetSource?.connected} onClick={() => void act(async () => { const thread = await api<ThreadSummary>(`${endpoint(target)}/resume`, {}); setSnapshot(s => ({ ...s, threads: s.threads.map(t => t.key === thread.key ? thread : t) })); choose(thread); setConnectTarget(null); setNotice('已接入，可在面板继续对话'); await refreshDetail(true); })}>{busy ? '正在接入…' : '接入面板'}</button>}</div></div></Modal>}
    {renameTarget && <Modal title="修改对话标题" close={() => { if (!busy) setRenameTarget(null); }}>{error && <div className="inline-error" role="alert">{error}</div>}<form onSubmit={e => { e.preventDefault(); void act(async () => { const title = validateTitle(newTitle); const thread = await api<ThreadSummary>(`${endpoint(renameTarget)}/rename`, { title }); setSnapshot(s => ({ ...s, threads: s.threads.map(t => t.key === thread.key ? { ...t, title: thread.title } : t) })); setDetail(current => current?.thread.key === thread.key ? { ...current, thread: { ...current.thread, title: thread.title } } : current); setRenameTarget(null); setNotice('标题已保存'); }); }}><label className="form-field">对话标题<input autoFocus required maxLength={MAX_TITLE_LENGTH} value={newTitle} onFocus={e => e.target.select()} onChange={e => setNewTitle(e.target.value)} disabled={busy} /></label><p className="title-limit">{newTitle.length} / {MAX_TITLE_LENGTH}</p><div className="modal-actions"><button type="button" className="button" disabled={busy} onClick={() => setRenameTarget(null)}>取消</button><button type="submit" className="button primary" disabled={busy || !supportsRename || connection !== 'online' || !snapshot.sources.find(s => s.id === renameTarget.sourceId)?.connected || !snapshot.threads.some(t => t.key === renameTarget.key) || !newTitle.trim() || newTitle.trim() === renameTarget.title || newTitle.trim().length > MAX_TITLE_LENGTH}>{busy ? '正在保存…' : '保存标题'}</button></div></form></Modal>}
    {newTask && <Modal title="新建 Codex 会话" close={() => { if (!busy) setNewTask(false); }}>{error && <div className="inline-error" role="alert">{error}</div>}<form onSubmit={e => { e.preventDefault(); void act(async () => { const thread = await api<ThreadSummary>('threads', { sourceId: newSource, cwd: newCwd }); setSnapshot(s => ({ ...s, threads: [thread, ...s.threads.filter(t => t.key !== thread.key)] })); setSelectedKey(thread.key); setNewTask(false); }); }}><label className="form-field">连接来源<select value={newSource} onChange={e => setNewSource(e.target.value)} required>{snapshot.sources.filter(s => s.connected).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label className="form-field">项目目录<input autoFocus placeholder="例如 /Users/你的名字/Workspace/my-project" value={newCwd} onChange={e => setNewCwd(e.target.value)} list="project-paths" required /><datalist id="project-paths">{projects.map(path => <option key={path} value={path} />)}</datalist></label><p className="muted">沿用本机 Codex 的模型和权限配置。创建会话后再输入任务指令。</p><div className="modal-actions"><button type="button" className="button" onClick={() => setNewTask(false)} disabled={busy}>取消</button><button type="submit" className="button primary" disabled={busy || !newSource || !newCwd.trim()}>{busy ? '正在创建…' : '创建会话'}</button></div></form></Modal>}
    {confirm && <Modal title={confirm.title} close={() => { if (!busy) setConfirm(null); }}>{error && <div className="inline-error" role="alert">{error}</div>}<p className="confirm-text">{confirm.message}</p><div className="modal-actions"><button className="button" disabled={busy} onClick={() => setConfirm(null)}>取消</button><button className={`button ${confirm.danger ? 'danger' : 'primary'}`} disabled={busy} onClick={() => void act(async () => { await confirm.action(); setConfirm(null); })}>{busy ? '正在处理…' : confirm.danger ? '永久删除' : '确认'}</button></div></Modal>}
  </div>;
}
