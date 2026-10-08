import { memo, useState } from 'react';
import { Check, ChevronDown, Code2, Terminal } from 'lucide-react';
import type { TimelineItem } from '../../shared/types.ts';
import { MessageMarkdown } from '../MessageMarkdown.tsx';
import { time } from '../format.ts';

export const ConversationItem = memo(function ConversationItem({ item }: { item: TimelineItem }) {
  const [open, setOpen] = useState(false);
  if (item.type === 'agentMessage' || item.type === 'userMessage') return <article className={`message ${item.type === 'userMessage' ? 'user' : 'assistant'}`}>
    <div className="message-avatar">{item.type === 'userMessage' ? '你' : <Terminal size={17} />}</div>
    <div className="message-content"><div className="message-meta"><strong>{item.title}</strong><time>{time(item.time)}</time></div><MessageMarkdown text={item.text} /></div>
  </article>;
  return <details className="tool-item" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><span className="tool-icon">{item.type === 'fileChange' ? <Code2 size={16} /> : <Terminal size={16} />}</span><span><b>{item.title}</b><code>{item.text.split('\n', 1)[0]}</code></span><span className={`tool-status ${item.status}`}>{item.status === 'failed' ? '失败' : item.status === 'inProgress' ? '执行中' : item.status === 'declined' ? '已拒绝' : item.status === 'completed' ? <Check size={15} /> : ''}</span><ChevronDown size={14} /></summary>
    {open && <pre>{item.text}{item.detail ? `\n\n${item.detail}` : ''}</pre>}
  </details>;
});
