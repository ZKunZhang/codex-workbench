import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AuditEntry, QueueItem } from '../shared/types.ts';

interface Data { queue: QueueItem[]; audit: AuditEntry[]; detached?: string[] }
export class StateStore {
  data: Data = { queue: [], audit: [] };
  private writes: Promise<void> = Promise.resolve();
  constructor(private file: string) {}
  async load() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      if (!Array.isArray(data.queue) || !Array.isArray(data.audit)) throw new Error('工作台状态格式不正确');
      if (data.detached !== undefined && (!Array.isArray(data.detached) || data.detached.some((key: unknown) => typeof key !== 'string'))) throw new Error('工作台退出状态格式不正确');
      this.data = data;
      for (const item of this.data.queue) if (item.status === 'sending') { item.status = 'uncertain'; item.error = '服务重启，发送结果未知；请查看会话后再决定'; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  save() {
    const json = JSON.stringify(this.data);
    const write = this.writes.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      await writeFile(this.file + '.tmp', json, { mode: 0o600 });
      await rename(this.file + '.tmp', this.file);
    });
    this.writes = write;
    return write;
  }
  async audit(entry: AuditEntry) { this.data.audit = [entry, ...this.data.audit].slice(0, 200); await this.save(); }
}
