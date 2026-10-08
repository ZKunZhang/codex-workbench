import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import type { SourceConfig } from '../shared/types.ts';

// Saved sources belong to this workbench, never to shared Codex configuration.
export async function loadSources(root: string, env: NodeJS.ProcessEnv = process.env): Promise<SourceConfig[]> {
  let inputs: unknown;
  if (env.CODEX_WORKBENCH_SOURCES) inputs = JSON.parse(env.CODEX_WORKBENCH_SOURCES);
  else {
    let extra: unknown = [];
    try { extra = JSON.parse(await readFile(resolve(root, '.workbench/sources.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!Array.isArray(extra)) throw new Error('sources.json 必须是连接来源数组');
    inputs = [{ id: 'local', name: '本机 Codex', codexHome: env.CODEX_HOME || resolve(homedir(), '.codex') }, ...extra];
  }
  if (!Array.isArray(inputs) || !inputs.length) throw new Error('请配置至少一个连接来源');
  const ids = new Set<string>();
  const endpoints = new Set<string>();
  const sources: SourceConfig[] = [];
  for (const input of inputs) {
    if (!input || typeof input !== 'object' || typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(input.id) || ids.has(input.id) || typeof input.name !== 'string' || !input.name.trim()) throw new Error('连接来源的 id 必须唯一且只含字母、数字、横线或下划线，并填写名称');
    ids.add(input.id);
    if ([input.codexHome, input.socket, input.url].filter(v => v !== undefined).length !== 1) throw new Error('每个连接来源必须填写 codexHome、socket 或 url 中的一项');
    const source: SourceConfig = { id: input.id, name: input.name.trim() };
    if (input.codexHome !== undefined) {
      if (typeof input.codexHome !== 'string' || !isAbsolute(input.codexHome)) throw new Error('codexHome 必须为绝对路径');
      source.codexHome = await realpath(resolve(input.codexHome)).catch(() => resolve(input.codexHome));
      source.socket = resolve(source.codexHome, 'app-server-control/app-server-control.sock');
    } else if (input.socket !== undefined) {
      if (typeof input.socket !== 'string' || !isAbsolute(input.socket)) throw new Error('socket 必须为绝对路径');
      source.socket = resolve(input.socket);
      if (basename(source.socket) === 'app-server-control.sock' && basename(dirname(source.socket)) === 'app-server-control') source.codexHome = dirname(dirname(source.socket));
      if (source.codexHome) source.codexHome = await realpath(source.codexHome).catch(() => source.codexHome!);
    } else {
      if (typeof input.url !== 'string') throw new Error('url 必须是本机 WebSocket 地址');
      const url = new URL(input.url);
      if (url.protocol !== 'ws:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('此版本只连接本机 WebSocket 服务');
      source.url = url.href;
    }
    const endpoint = source.socket ? await realpath(source.socket).catch(() => source.socket!) : source.url!;
    if (endpoints.has(endpoint)) continue;
    endpoints.add(endpoint); sources.push(source);
  }
  return sources;
}
