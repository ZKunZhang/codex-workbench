import { ChevronDown, ChevronRight, Folder, Star, Trash2 } from 'lucide-react';
import type { ThreadSummary } from '../../shared/types.ts';
import type { TaskNode } from '../task-tree.ts';
import { basename, relative } from '../format.ts';
import { IconButton, Status } from './ui.tsx';
import { memo } from 'react';

interface TaskListProps {
  nodes: TaskNode[];
  selectedKey: string | null;
  favorites: Set<string>;
  collapsed: Set<string>;
  expandAll: boolean;
  sourceNames: Map<string, string>;
  now: number;
  onSelect: (thread: ThreadSummary) => void;
  onDelete: (thread: ThreadSummary) => void;
  onToggle: (key: string) => void;
  deleteReason: (thread: ThreadSummary) => string | undefined;
}

export const TaskList = memo(function TaskList(props: TaskListProps) {
  return props.nodes.map(node => <TaskBranch key={node.key} node={node} depth={0} options={props} />);
});

function TaskBranch({ node, depth, options }: { node: TaskNode; depth: number; options: TaskListProps }) {
  const { selectedKey, favorites, collapsed, expandAll, sourceNames, now, onSelect, onDelete, onToggle, deleteReason } = options;
  const thread = node.thread;
  const expanded = expandAll || !collapsed.has(node.key);
  const title = thread?.title || node.parentId;
  const reason = thread ? deleteReason(thread) : undefined;

  return <div className={`task-node ${depth ? 'child-node' : 'root-node'}`}>
    {thread ? <TaskEntry thread={thread} selected={thread.key === selectedKey} favorite={favorites.has(thread.key)} sourceName={sourceNames.size > 1 ? sourceNames.get(thread.sourceId) : undefined} age={relative(thread.lastActivity || thread.updatedAt, now)} reason={reason} onSelect={onSelect} onDelete={onDelete} /> : <div className="missing-parent">所属任务未加载<code>{node.parentId}</code></div>}
    {node.children.length > 0 && <>
      <button type="button" className="child-toggle" aria-expanded={expanded} aria-label={`${expanded ? '收起' : '展开'} ${title} 的子代理`} onClick={() => onToggle(node.key)}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<span>{node.count} 个子代理</span></button>
      {expanded && <div className="task-children" role="group" aria-label={`${thread?.title || '未加载任务'}的子代理`}>{node.children.map(child => <TaskBranch key={child.key} node={child} depth={depth + 1} options={options} />)}</div>}
    </>}
  </div>;
}

// Only rows whose visible data changes need to render, even when a running
// task causes the tree to be rebuilt or moves to a different sort position.
const TaskEntry = memo(function TaskEntry({ thread, selected, favorite, sourceName, age, reason, onSelect, onDelete }: {
  thread: ThreadSummary; selected: boolean; favorite: boolean; sourceName?: string; age: string; reason?: string;
  onSelect: (thread: ThreadSummary) => void; onDelete: (thread: ThreadSummary) => void;
}) {
  return <div className={`task-entry ${selected ? 'selected' : ''}`}>
      <button type="button" className={`task-row ${selected ? 'selected' : ''}`} data-thread-id={thread.id} onClick={() => onSelect(thread)}>
        <div className="task-row-top"><Status state={thread.state} />{thread.externalPid && <span className="external-tag">独立终端</span>}<span>{age}</span></div>
        <h3 title={thread.title}>{thread.parentId && <span className="child-tag">子代理</span>}{thread.title}</h3>
        <div className="task-row-bottom"><span title={thread.cwd}><Folder size={11} />{basename(thread.cwd)}</span>{sourceName !== undefined && <span className="task-source" title={sourceName}>{sourceName}</span>}{favorite && <Star size={11} fill="currentColor" />}</div>
      </button>
      <IconButton className="task-delete delete-thread" label={`删除对话：${thread.title}`} hint={reason || `删除“${thread.title}”及其子对话`} disabled={!!reason} onClick={() => onDelete(thread)}><Trash2 size={13} /></IconButton>
    </div>;
});
