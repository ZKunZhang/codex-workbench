import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { SourceConfig } from '../shared/types.ts';

export class RpcError extends Error {
  constructor(message: string, public code: number | string = 'RPC_ERROR', public uncertain = false) { super(message); }
}
export interface RpcConnection extends EventEmitter {
  connected: boolean;
  start(): void;
  close(): void;
  call<T = any>(method: string, params?: unknown): Promise<T>;
  respond(id: string | number, result: unknown): void;
}

export class CodexConnection extends EventEmitter implements RpcConnection {
  connected = false;
  private socket?: WebSocket;
  private stopped = false;
  private reconnectTimer?: NodeJS.Timeout;
  private attempts = 0;
  private sequence = 0;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private config: SourceConfig) { super(); }
  start() { this.connect(); }
  private connect() {
    if (this.stopped) return;
    const url = this.config.socket ? `ws+unix://${this.config.socket}:/` : this.config.url!;
    const socket = this.socket = new WebSocket(url, { handshakeTimeout: 5000, maxPayload: 32 * 1024 * 1024 });
    let reason = 'Codex 连接已断开';
    socket.on('open', async () => {
      try {
        const info = await this.call('initialize', { clientInfo: { name: 'codex_workbench', title: 'Codex 工作台', version: '0.1.0' }, capabilities: { experimentalApi: true } });
        socket.send(JSON.stringify({ method: 'initialized' }));
        this.connected = true;
        this.attempts = 0;
        this.emit('connected', info);
      } catch (error) { reason = (error as Error).message; socket.close(); }
    });
    socket.on('message', data => {
      let message: any;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (message.method) {
        this.emit(message.id !== undefined ? 'request' : 'notification', message);
      } else {
        const pending = this.pending.get(String(message.id));
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(String(message.id));
        if (message.error) pending.reject(new RpcError(message.error.message, message.error.code));
        else pending.resolve(message.result);
      }
    });
    socket.on('error', error => { reason = error.message; });
    socket.on('close', () => {
      this.connected = false;
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new RpcError('连接中断，操作结果需重新确认', 'DISCONNECTED', true)); }
      this.pending.clear();
      this.emit('disconnected', reason);
      if (!this.stopped) this.reconnectTimer = setTimeout(() => this.connect(), Math.min(15000, 1000 * 2 ** this.attempts++));
    });
  }
  call<T = any>(method: string, params: unknown = {}): Promise<T> {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new RpcError('Codex 服务未连接', 'OFFLINE'));
    const id = `workbench:${++this.sequence}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RpcError('Codex 响应超时，操作可能已送达，请先查看任务', 'TIMEOUT', true)); }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ id, method, params }), error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(new RpcError(error.message, 'WRITE_FAILED', true)); }
      });
    });
  }
  respond(id: string | number, result: unknown) {
    if (!this.connected || this.socket?.readyState !== WebSocket.OPEN) throw new RpcError('连接已失效，请等待重新同步', 'OFFLINE');
    this.socket.send(JSON.stringify({ id, result }));
  }
  close() { this.stopped = true; clearTimeout(this.reconnectTimer); this.socket?.close(); }
}
