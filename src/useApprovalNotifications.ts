import { useCallback, useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../shared/types.ts';

type Permission = NotificationPermission | 'unsupported';
const preferenceKey = 'codex-workbench:notifications';
const permissionNow = (): Permission => typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;

export function useApprovalNotifications(snapshot: Snapshot, online: boolean, open: (requestKey?: string) => void) {
  const [permission, setPermission] = useState<Permission>(permissionNow);
  const [enabled, setEnabled] = useState(() => { try { return localStorage.getItem(preferenceKey) !== 'off'; } catch { return true; } });
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState('');
  const [retryVersion, setRetryVersion] = useState(0);
  const seen = useRef(new Set<string>());
  const active = useRef(new Map<string, Notification>());
  const latest = useRef({ snapshot, open });
  latest.current = { snapshot, open };
  const allowed = enabled && permission === 'granted';
  const connectedSources = JSON.stringify(snapshot.sources.filter(source => source.connected).map(source => source.id));
  const pendingCount = online ? snapshot.pending.filter(request => !request.answering && snapshot.sources.some(source => source.id === request.sourceId && source.connected)).length : 0;

  const close = useCallback((key: string) => {
    const notification = active.current.get(key);
    if (!notification) return;
    notification.onclick = notification.onerror = notification.onclose = null;
    notification.close(); active.current.delete(key);
  }, []);

  const show = useCallback((key: string, title: string, body: string, requestKey?: string) => {
    close(key);
    const notification = new Notification(title, { body, tag: `codex-workbench:${key}`, requireInteraction: true });
    active.current.set(key, notification);
    notification.onclick = event => {
      event.preventDefault();
      try { window.focus(); } catch { /* The browser may restrict focusing windows. */ }
      close(key);
      latest.current.open(requestKey);
    };
    notification.onclose = () => { if (active.current.get(key) === notification) active.current.delete(key); };
    notification.onerror = () => { close(key); seen.current.delete(key); setError('系统通知未能显示，请检查浏览器和系统的通知设置。'); };
  }, [close]);

  useEffect(() => {
    const refresh = () => setPermission(permissionNow());
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);

  useEffect(() => {
    const eligible = online ? snapshot.pending.filter(request => !request.answering && snapshot.sources.some(source => source.id === request.sourceId && source.connected)) : [];
    const keys = new Set(eligible.map(request => request.key));
    for (const key of active.current.keys()) if (!allowed || (key !== 'test' && !keys.has(key))) {
      close(key); seen.current.delete(key);
    }
    const pendingKeys = new Set(snapshot.pending.map(request => request.key));
    for (const key of seen.current) if (!pendingKeys.has(key)) seen.current.delete(key);
    if (!allowed) return;
    for (const request of eligible) {
      if (seen.current.has(request.key)) continue;
      const current = latest.current.snapshot;
      const thread = current.threads.find(thread => thread.sourceId === request.sourceId && thread.id === request.threadId);
      const source = current.sources.find(source => source.id === request.sourceId);
      try {
        show(request.key, request.kind === 'input' ? 'Codex 等待你回答' : 'Codex 等待确认', `${thread?.title || 'Codex 会话'}${source ? ` · ${source.name}` : ''}\n${request.title}`, request.key);
        seen.current.add(request.key);
      } catch { setError('系统通知未能显示，请检查浏览器和系统的通知设置。'); }
    }
  }, [snapshot.pending, connectedSources, online, allowed, retryVersion, close, show]);

  useEffect(() => {
    document.title = pendingCount ? `(${pendingCount} 待确认) Codex 工作台` : 'Codex 工作台';
  }, [pendingCount]);
  useEffect(() => () => {
    for (const key of active.current.keys()) close(key);
    seen.current.clear();
    document.title = 'Codex 工作台';
  }, [close]);

  const enable = async () => {
    if (requesting) return;
    setError(''); setRequesting(true);
    try {
      let next = permissionNow();
      // Permission prompts must run directly from the user's click, never a timer.
      if (next === 'default') next = await Notification.requestPermission();
      setPermission(next);
      if (next === 'granted') {
        seen.current.clear(); setEnabled(true);
        try { localStorage.setItem(preferenceKey, 'on'); } catch { /* Optional preference. */ }
      }
    } catch { setError('无法请求通知权限，请在浏览器的网站设置中开启通知。'); }
    finally { setRequesting(false); }
  };
  const disable = () => {
    setEnabled(false); setError('');
    try { localStorage.setItem(preferenceKey, 'off'); } catch { /* Optional preference. */ }
  };
  const test = () => {
    setError('');
    try { show('test', 'Codex 通知测试', '收到这条通知后，你可以切换到其他窗口。需要确认时会在这里提醒。'); }
    catch { setError('系统通知未能显示，请检查浏览器和系统的通知设置。'); }
  };
  const retry = () => { setError(''); setRetryVersion(value => value + 1); };
  return { permission, enabled, allowed, requesting, error, enable, disable, test, retry };
}
