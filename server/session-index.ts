import { watch } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

const rollout = /^rollout-.*-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i;
const WATCH_RECONCILE_MS = 15 * 60_000;
const FALLBACK_RECONCILE_MS = 60_000;
interface Entry {
  root: string; files: Map<string, string>; dirty: Set<string>; full: boolean;
  lastFull: number; watching: boolean; close?: () => void; pending?: Promise<Set<string>>;
}
interface IndexIO {
  readDirectory: (path: string) => Promise<import('node:fs').Dirent[]>;
  metadata: typeof lstat;
  watchDirectory: (path: string, changed: (name: string | null) => void, failed: () => void) => () => void;
  now: () => number;
}
const defaultIO: IndexIO = {
  readDirectory: path => readdir(path, { withFileTypes: true }), metadata: lstat, now: Date.now,
  watchDirectory(path, changed, failed) {
    // Content appends do not change the inventory. Only directory entries matter.
    const watcher = watch(path, { recursive: true, persistent: false }, (event, name) => { if (event === 'rename') changed(name?.toString() || null); });
    watcher.on('error', () => { watcher.close(); failed(); });
    return () => watcher.close();
  },
};

export class SessionIndex {
  private entries = new Map<string, Entry>();
  private io: IndexIO;
  constructor(io: Partial<IndexIO> = {}) { this.io = { ...defaultIO, ...io }; }

  inventory(home: string, fresh = false): Promise<Set<string>> {
    const root = resolve(home, 'sessions');
    let entry = this.entries.get(root);
    if (!entry) {
      entry = { root, files: new Map(), dirty: new Set(), full: true, lastFull: 0, watching: false };
      this.entries.set(root, entry);
      this.startWatcher(entry);
    }
    if (entry.pending) { if (fresh) entry.full = true; return entry.pending; }
    if (fresh || this.io.now() - entry.lastFull >= (entry.watching ? WATCH_RECONCILE_MS : FALLBACK_RECONCILE_MS)) entry.full = true;
    if (!entry.full && !entry.dirty.size) return Promise.resolve(new Set(entry.files.values()));
    const current = entry;
    current.pending = this.refresh(current).finally(() => { current.pending = undefined; });
    return current.pending;
  }

  private startWatcher(entry: Entry) {
    if (entry.watching) return;
    try {
      entry.close = this.io.watchDirectory(entry.root, name => {
        if (!name || isAbsolute(name)) { entry.full = true; return; }
        const path = resolve(entry.root, name);
        if (!path.startsWith(entry.root + sep)) { entry.full = true; return; }
        entry.dirty.add(path);
        if (entry.dirty.size > 1000) { entry.dirty.clear(); entry.full = true; }
      }, () => { entry.watching = false; entry.full = true; });
      entry.watching = true;
    } catch { entry.watching = false; } // Unsupported watcher / missing sessions directory.
  }

  private async scan(directory: string, files: Map<string, string>) {
    const entries = await this.io.readDirectory(directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    for (const item of entries) {
      const path = join(directory, item.name);
      if (item.isDirectory()) await this.scan(path, files);
      else if (item.isFile()) { const match = rollout.exec(item.name); if (match) files.set(path, match[1]); }
    }
  }

  private async refresh(entry: Entry) {
    const full = entry.full;
    const changed = [...entry.dirty].sort();
    entry.full = false; entry.dirty.clear();
    const files = full ? new Map<string, string>() : new Map(entry.files);
    try {
      if (full) await this.scan(entry.root, files);
      else {
        const visited: string[] = [];
        for (const path of changed) {
          if (visited.some(parent => path.startsWith(parent + sep))) continue;
          visited.push(path);
          for (const file of files.keys()) if (file === path || file.startsWith(path + sep)) files.delete(file);
          const info = await this.io.metadata(path).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
          });
          if (info?.isDirectory()) await this.scan(path, files);
          else if (info?.isFile()) { const match = rollout.exec(path.slice(path.lastIndexOf(sep) + 1)); if (match) files.set(path, match[1]); }
        }
      }
      entry.files = files;
      if (full) entry.lastFull = this.io.now();
      if (this.entries.get(entry.root) === entry) this.startWatcher(entry);
      return new Set(files.values());
    } catch (error) { entry.full = true; throw error; }
  }

  close() { for (const entry of this.entries.values()) entry.close?.(); this.entries.clear(); }
}
