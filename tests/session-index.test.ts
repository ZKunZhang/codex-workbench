import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, lstat, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionIndex } from '../server/session-index.ts';
import type { Dirent } from 'node:fs';

const id = '01a1194b-230b-74c0-a7b1-a32f7f932a2a';
const second = '01a0bcd6-9e39-7d01-bfcb-b38ae5ad6185';
const filename = (value: string) => `rollout-time-${value}.jsonl`;

test('unchanged inventories do no disk reads; file events update only affected entries', async t => {
  const home = await mkdtemp(join(tmpdir(), 'workbench-index-'));
  const root = join(home, 'sessions');
  await mkdir(join(root, 'old/year'), { recursive: true });
  await mkdir(join(root, 'today'));
  await writeFile(join(root, 'today', filename(id)), '{}');
  let directories = 0, metadata = 0, closed = 0, now = 1000;
  let changed!: (name: string | null) => void;
  const index = new SessionIndex({
    now: () => now,
    readDirectory: path => { directories++; return readdir(path, { withFileTypes: true }); },
    metadata: (async path => { metadata++; return lstat(path); }) as typeof lstat,
    watchDirectory: (_path, onChange) => { changed = onChange; return () => { closed++; }; },
  });
  t.after(() => index.close());
  assert.deepEqual([...await index.inventory(home)], [id]);
  const initial = directories;
  for (let i = 0; i < 20; i++) assert.deepEqual([...await index.inventory(home)], [id]);
  assert.equal(directories, initial); assert.equal(metadata, 0);
  await writeFile(join(root, 'today', filename(second)), '{}');
  changed(join('today', filename(second)));
  assert.deepEqual(await index.inventory(home), new Set([id, second]));
  assert.equal(directories, initial); assert.equal(metadata, 1);
  await unlink(join(root, 'today', filename(id)));
  changed(join('today', filename(id)));
  assert.deepEqual([...await index.inventory(home)], [second]);
  assert.equal(directories, initial); assert.equal(metadata, 2);
  // A new directory needs only its own subtree, never unrelated years.
  await mkdir(join(root, 'tomorrow'));
  await writeFile(join(root, 'tomorrow', filename(id)), '{}');
  changed('tomorrow'); changed(join('tomorrow', filename(id)));
  assert.deepEqual(await index.inventory(home), new Set([id, second]));
  assert.equal(directories, initial + 1); assert.equal(metadata, 3);
  now += 15 * 60_000;
  await index.inventory(home); assert(directories > initial + 1);
  const reconciled = directories;
  await index.inventory(home, true); assert(directories > reconciled);
  index.close(); assert.equal(closed, 1);
});

test('missing watcher support uses a slow fallback and failed scans are retried', async t => {
  let now = 1000, reads = 0, fail = false;
  const index = new SessionIndex({
    now: () => now,
    watchDirectory: () => { throw new Error('unsupported'); },
    readDirectory: async () => { reads++; if (fail) throw new Error('read failed'); return []; },
  });
  t.after(() => index.close());
  await index.inventory('/virtual/home');
  now += 59_000; await index.inventory('/virtual/home'); assert.equal(reads, 1);
  now += 1000; await index.inventory('/virtual/home'); assert.equal(reads, 2);
  fail = true; await assert.rejects(index.inventory('/virtual/home', true), /read failed/);
  fail = false; await index.inventory('/virtual/home'); assert.equal(reads, 4);
});

test('coalesced scans retain events arriving mid-read and stopping does not reopen watchers', async () => {
  let finish!: (entries: Dirent[]) => void;
  let changed!: (name: string | null) => void;
  let watches = 0, closed = 0, reads = 0;
  const index = new SessionIndex({
    watchDirectory: (_path, onChange) => { watches++; changed = onChange; return () => { closed++; }; },
    readDirectory: async () => { reads++; if (reads > 1) return []; return new Promise(resolve => { finish = resolve; }); },
  });
  const first = index.inventory('/virtual/home');
  const second = index.inventory('/virtual/home');
  assert.equal(first, second);
  changed(null); finish([]); await first;
  await index.inventory('/virtual/home'); assert.equal(reads, 2);
  const pending = index.inventory('/virtual/home', true);
  index.close(); await pending;
  assert.equal(watches, 1); assert.equal(closed, 1);
});
