import type { SourceConfig } from './types.ts';

// The copied command is evaluated by the user's shell; every dynamic value is
// quoted, including paths containing quotes, dollars, backticks or whitespace.
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function terminalCommand(source: Pick<SourceConfig, 'codexHome' | 'socket' | 'url'>, threadId?: string): string | null {
  const address = source.socket ? `unix://${source.socket}` : source.url;
  if (!address) return null;
  return [source.codexHome ? `CODEX_HOME=${quote(source.codexHome)}` : '', 'codex', '--remote', quote(address), ...(threadId ? ['resume', quote(threadId)] : [])].filter(Boolean).join(' ');
}
