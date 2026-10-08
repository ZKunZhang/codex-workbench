import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { Workbench } from './workbench.ts';

const MAX_BODY = 64 * 1024;
export function trustedRequest(req: Pick<IncomingMessage, 'headers'>, port: number) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const host = req.headers.host;
  if (!host || !hosts.has(host)) return false;
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  return true;
}
function tokenMatches(value: unknown, token: string) {
  if (typeof value !== 'string') return false;
  const received = Buffer.from(value); const expected = Buffer.from(token);
  return received.length === expected.length && timingSafeEqual(received, expected);
}
async function jsonBody(req: IncomingMessage): Promise<any> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('请求必须为 JSON');
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw new Error('请求内容过长'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new Error('JSON 格式不正确'); }
}
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body));
}
export async function createWorkbenchServer(workbench: Workbench, options: { port: number; root: string; dev?: boolean }) {
  const token = randomBytes(32).toString('hex');
  const vite = options.dev ? await (await import('vite')).createServer({ root: options.root, server: { middlewareMode: true, hmr: false }, appType: 'spa' }) : null;
  const staticRoot = resolve(options.root, 'dist');
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    if (!options.dev) res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (!trustedRequest(req, options.port)) return json(res, 403, { error: '仅允许本机同源访问' });
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (parts[0] === 'api') {
        if (req.method === 'GET' && parts[1] === 'session') return json(res, 200, { token, snapshot: workbench.snapshot(), capabilities: { renameThread: true, detachThread: true } });
        if (req.method === 'GET' && parts[1] === 'threads' && parts.length === 4) return json(res, 200, await workbench.detail(parts[2], parts[3], url.searchParams.get('cursor') || undefined, url.searchParams.get('refresh') === '1'));
        if (req.method !== 'POST') return json(res, 404, { error: '接口不存在' });
        if (!tokenMatches(req.headers['x-workbench-token'], token)) return json(res, 403, { error: '页面连接已过期，请刷新' });
        const body = await jsonBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求格式不正确');
        if (parts[1] === 'threads' && parts.length === 2) {
          if (typeof body.sourceId !== 'string' || typeof body.cwd !== 'string') throw new Error('请选择连接来源并填写项目目录');
          return json(res, 200, await workbench.create(body.sourceId, body.cwd.trim()));
        }
        if (parts[1] === 'threads' && parts.length === 5) {
          const [, , source, id, action] = parts;
          if (action === 'rename') return json(res, 200, await workbench.rename(source, id, body.title));
          if (action === 'resume') return json(res, 200, await workbench.resume(source, id));
          if (action === 'detach') {
            if (body.confirm !== true) throw new Error('请确认退出面板连接并暂停待发送消息');
            return json(res, 200, await workbench.detach(source, id));
          }
          if (action === 'delete') {
            if (body.confirm !== true) throw new Error('请确认永久删除此对话及其子对话');
            return json(res, 200, await workbench.deleteThread(source, id));
          }
          if (action === 'message') {
            if (typeof body.text !== 'string' || typeof body.mode !== 'string' || typeof body.requestId !== 'string') throw new Error('消息参数不正确');
            await workbench.message(source, id, body.text, body.mode, body.requestId, body.turnId);
          } else if (action === 'interrupt') {
            if (typeof body.turnId !== 'string') throw new Error('缺少执行轮次');
            await workbench.interrupt(source, id, body.turnId);
          } else return json(res, 404, { error: '操作不存在' });
          return json(res, 200, { ok: true });
        }
        if (parts[1] === 'requests' && parts.length === 3) { await workbench.reply(parts[2], body); return json(res, 200, { ok: true }); }
        if (parts[1] === 'queue' && parts.length === 4 && parts[3] === 'cancel') { await workbench.cancelQueue(parts[2]); return json(res, 200, { ok: true }); }
        if (parts[1] === 'sources' && parts.length === 4 && parts[3] === 'older') { await workbench.older(parts[2]); return json(res, 200, { ok: true }); }
        return json(res, 404, { error: '接口不存在' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: '不支持此方法' });
      if (vite) return vite.middlewares(req, res);
      let file = resolve(staticRoot, '.' + decodeURIComponent(url.pathname));
      if (file !== staticRoot && !file.startsWith(staticRoot + sep)) return json(res, 403, { error: '路径无效' });
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) {
        if (extname(url.pathname)) return json(res, 404, { error: '文件不存在' });
        file = resolve(staticRoot, 'index.html');
      }
      const content = await readFile(file);
      const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
      res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) { if (!res.headersSent) json(res, 400, { error: (error as Error).message }); else res.end(); }
  });
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 1024, handleProtocols: protocols => protocols.has('workbench') ? 'workbench' : false });
  server.on('upgrade', (req, socket, head) => {
    const protocols = req.headers['sec-websocket-protocol']?.split(',').map(v => v.trim()) || [];
    if (req.url !== '/events' || !trustedRequest(req, options.port) || !tokenMatches(protocols[1], token)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    websocket.handleUpgrade(req, socket, head, ws => { ws.send(JSON.stringify(workbench.snapshot())); });
  });
  const broadcast = (snapshot: unknown) => {
    if (!websocket.clients.size) return;
    const data = JSON.stringify(snapshot);
    for (const client of websocket.clients) {
      if (client.bufferedAmount > 2 * 1024 * 1024) client.terminate();
      else if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  };
  workbench.on('change', broadcast);
  return { server, close: async () => { workbench.off('change', broadcast); for (const client of websocket.clients) client.close(); websocket.close(); await vite?.close(); server.close(); } };
}
