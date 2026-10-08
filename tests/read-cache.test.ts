import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadCache } from '../server/read-cache.ts';

test('concurrent readers share work, TTL and explicit refresh control rereads, and storage is bounded', async () => {
  let now = 1000, reads = 0;
  const cache = new ReadCache<number>(2, () => now);
  const read = async () => ++reads;
  const ttl = () => 100;
  assert.deepEqual(await Promise.all([cache.get('a', read, ttl), cache.get('a', read, ttl)]), [1, 1]);
  assert.equal(await cache.get('a', read, ttl), 1);
  now += 100;
  assert.equal(await cache.get('a', read, ttl), 2);
  assert.equal(await cache.get('a', read, ttl, true), 3);
  await cache.get('b', read, ttl); await cache.get('c', read, ttl);
  assert.equal(await cache.get('a', read, ttl), 6); // Oldest page was evicted.
});

test('invalidation during a read preserves coalescing but never caches its stale result', async () => {
  const cache = new ReadCache<number>();
  let finish!: (n: number) => void;
  const read = () => new Promise<number>(resolve => { finish = resolve; });
  const first = cache.get('source:thread:page', read, () => 60_000);
  await Promise.resolve();
  cache.invalidate('source:thread:');
  const second = cache.get('source:thread:page', read, () => 60_000);
  assert.equal(first, second);
  finish(1);
  assert.deepEqual(await Promise.all([first, second]), [1, 1]);
  assert.equal(await cache.get('source:thread:page', async () => 2, () => 60_000), 2);
});

test('failures retry immediately and invalidation stays within the requested source and thread', async () => {
  const cache = new ReadCache<number>();
  let reads = 0;
  const get = (key: string) => cache.get(key, async () => ++reads, () => 60_000);
  await assert.rejects(cache.get('one:id:', async () => { throw new Error('offline'); }, () => 60_000), /offline/);
  assert.equal(await get('one:id:'), 1);
  assert.equal(await get('two:id:'), 2);
  cache.invalidate('one:');
  assert.equal(await get('two:id:'), 2);
  assert.equal(await get('one:id:'), 3);
});

test('weighted cache evicts large pages and shutdown discards in-flight results', async () => {
  const cache = new ReadCache<string>(16, Date.now, value => value.length, 10);
  let reads = 0;
  const get = (key: string) => cache.get(key, async () => { reads++; return key.repeat(6); }, () => 60_000);
  await get('a'); await get('b'); await get('a');
  assert.equal(reads, 3);
  let finish!: (value: string) => void;
  const pending = cache.get('pending', () => new Promise<string>(resolve => { finish = resolve; }), () => 60_000);
  await Promise.resolve(); cache.clear(); finish('old'); await pending;
  assert.equal(await cache.get('pending', async () => 'new', () => 60_000), 'new');
});
