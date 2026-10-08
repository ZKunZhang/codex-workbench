import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { SessionIndex } from './session-index.ts';

const exec = promisify(execFile);
const uuid = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const lockPattern = new RegExp(`^(.*)/thread-writer-locks/(${uuid})\\.lock$`, 'i');

export interface LocalInspector {
  inventory(codexHome: string, fresh?: boolean): Promise<Set<string>>;
  owners(codexHome: string, fresh?: boolean): Promise<Map<string, number>>;
  homes?(): Promise<string[]>;
  close?(): void;
}

// Only open writer-lock file descriptors establish a live owner. An old lock
// filename or a recently modified rollout does not prove a process is running.
export function parseSessionOwners(output: string): Map<string, Map<string, number>> {
  const homes = new Map<string, Map<string, number>>();
  let pid = 0;
  let command = '';
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) { pid = Number(line.slice(1)); command = ''; }
    else if (line.startsWith('c')) command = line.slice(1);
    else if (line.startsWith('n') && command === 'codex' && pid > 0) {
      const match = lockPattern.exec(line.slice(1));
      if (!match) continue;
      const home = resolve(match[1]);
      if (!homes.has(home)) homes.set(home, new Map());
      homes.get(home)!.set(match[2], pid);
    }
  }
  return homes;
}

export class LocalSessions implements LocalInspector {
  private processCache?: { at: number; result: Promise<Map<string, Map<string, number>>> };
  private index = new SessionIndex();
  constructor(private run: () => Promise<string> = async () => {
    const uid = process.getuid?.();
    const args = ['-nP', '-a', ...(uid === undefined ? [] : ['-u', String(uid)]), '-c', 'codex', '-F', 'pcn'];
    try { return (await exec('lsof', args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })).stdout; }
    catch (error) {
      const e = error as Error & { code?: number; stdout?: string; stderr?: string };
      if (e.code === 1 && !e.stdout && !e.stderr) return ''; // No matching process.
      throw new Error(`无法识别独立终端会话：${e.message}`);
    }
  }) {}

  async owners(codexHome: string, fresh = false) {
    return (await this.processes(fresh)).get(resolve(codexHome)) || new Map<string, number>();
  }

  async homes() { return [...(await this.processes()).keys()]; }

  private async processes(fresh = false) {
    if (fresh || !this.processCache || Date.now() - this.processCache.at > 10_000) {
      const result = this.run().then(parseSessionOwners);
      this.processCache = { at: Date.now(), result };
    }
    return this.processCache.result;
  }

  inventory(codexHome: string, fresh = false) { return this.index.inventory(codexHome, fresh); }
  close() { this.index.close(); }
}
