import { Children, isValidElement, memo, useEffect, useRef, useState, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from 'lucide-react';

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children).find(child => isValidElement(child));
  const language = isValidElement<{ className?: string }>(code) ? code.props.className?.match(/language-([\w+-]+)/)?.[1] : undefined;
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 2000); return () => clearTimeout(timer); }, [copied]);
  return <div className="code-block"><div className="code-block-head"><span>{language || '代码'}</span><button type="button" aria-label="复制代码" onClick={async () => {
    try { await navigator.clipboard.writeText(ref.current?.textContent || ''); setCopied(true); setError(false); }
    catch { setError(true); }
  }}>{copied ? <Check size={12} /> : <Copy size={12} />}{copied ? '已复制' : error ? '复制失败，请手动选择' : '复制'}</button></div><pre ref={ref}>{children}</pre></div>;
}

const components: Components = {
  pre: CodeBlock,
  a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
  img: ({ src, alt }) => src ? <a href={src} target="_blank" rel="noopener noreferrer">{alt || '查看图片'}</a> : <span>{alt}</span>,
  table: ({ children }) => <div className="markdown-table"><table>{children}</table></div>,
};

// Large highlighted blocks can create thousands of span nodes. Preserve their
// complete text and copy action, while limiting syntax highlighting work.
function boundedHighlighting() {
  type Node = { tagName?: string; value?: string; children?: Node[]; properties?: { className?: string[] } };
  return (tree: Node) => {
    const visit = (node: Node) => {
      if (node.tagName === 'code' && (node.children || []).reduce((size, child) => size + (child.value?.length || 0), 0) > 4000) {
        node.properties ||= {}; node.properties.className = [...(node.properties.className || []), 'no-highlight'];
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

export const MessageMarkdown = memo(function MessageMarkdown({ text }: { text: string }) {
  // Keep raw HTML escaped and the default safe URL transform. Highlighting
  // operates on code text; it never executes code or HTML from a conversation.
  return <div className="message-text markdown"><Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[boundedHighlighting, [rehypeHighlight, { detect: false }]]} components={components}>{text}</Markdown></div>;
});
