import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Ellipsis, X } from 'lucide-react';
import type { RuntimeState, ThreadSummary } from '../../shared/types.ts';
import { stateLabels } from '../format.ts';

export function ThreadIdentity({ thread }: { thread: ThreadSummary }) {
  return <div className="thread-identity">
    <div><span>Session ID</span><code>{thread.sessionId || thread.id}</code></div>
    {thread.sessionId && thread.sessionId !== thread.id && <div><span>Thread ID</span><code>{thread.id}</code></div>}
    <div><span>CODEX_HOME</span><code>{thread.codexHome || '当前来源未提供'}</code></div>
  </div>;
}

export function Status({ state }: { state: RuntimeState }) {
  return <span className={`status ${state}`}><i />{stateLabels[state]}</span>;
}

export function IconButton({ children, label, hint = label, onClick, disabled = false, className = '' }: {
  children: ReactNode; label: string; hint?: string; onClick: () => void; disabled?: boolean; className?: string;
}) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={hint} onClick={onClick} disabled={disabled}>{children}</button>;
}

export function ActionMenu({ label, actions }: {
  label: string;
  actions: { label: string; icon: ReactNode; onClick: () => void; disabled?: boolean; hint?: string }[];
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('focusin', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('focusin', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  return <div className="action-menu" ref={ref}>
    <button type="button" ref={trigger} className="icon-button" aria-label={label} title={label} aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}><Ellipsis size={18} /></button>
    {open && <div className="action-menu-panel" id={id} role="group" aria-label={label}>{actions.map(action => <button type="button" key={action.label} disabled={action.disabled} title={action.hint} onClick={() => {
      setOpen(false);
      trigger.current?.focus();
      action.onClick();
    }}>{action.icon}{action.label}</button>)}</div>}
  </div>;
}

export function Modal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} className="modal" onCancel={e => { e.preventDefault(); close(); }} onClick={e => { if (e.target === ref.current) close(); }}>
    <div className="modal-head"><h2>{title}</h2><IconButton label="关闭弹窗" onClick={close}><X size={20} /></IconButton></div>
    {children}
  </dialog>;
}
