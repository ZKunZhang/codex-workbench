interface Entry<T> { value?: T; pending?: Promise<T>; expires: number; valid: boolean; weight: number }

// Coalesce readers, bound retained pages, and never retain a read invalidated
// while it was in flight. Failed reads are retryable immediately.
export class ReadCache<T> {
  private entries = new Map<string, Entry<T>>();
  constructor(private limit = 16, private now = Date.now, private weight: (value: T) => number = () => 1, private maxWeight = limit) {}

  get(key: string, read: () => Promise<T>, ttl: (value: T) => number, fresh = false): Promise<T> {
    let entry = this.entries.get(key);
    if (entry?.pending) return entry.pending;
    if (entry && !fresh && entry.valid && entry.expires > this.now()) {
      this.entries.delete(key); this.entries.set(key, entry);
      return Promise.resolve(entry.value!);
    }
    entry = { expires: 0, valid: true, weight: 0 };
    this.entries.delete(key); this.entries.set(key, entry);
    const current = entry;
    current.pending = Promise.resolve().then(read).then(value => {
      if (current.valid && this.entries.get(key) === current) {
        current.value = value; current.weight = this.weight(value);
        current.expires = this.now() + ttl(value);
      }
      return value;
    }, error => {
      if (this.entries.get(key) === current) this.entries.delete(key);
      throw error;
    }).finally(() => {
      current.pending = undefined;
      if ((!current.valid || current.expires <= this.now()) && this.entries.get(key) === current) this.entries.delete(key);
      let weight = [...this.entries.values()].reduce((sum, value) => sum + value.weight, 0);
      for (const [candidate, value] of this.entries) {
        if (this.entries.size <= this.limit && weight <= this.maxWeight) break;
        if (!value.pending) { this.entries.delete(candidate); weight -= value.weight; }
      }
    });
    return current.pending;
  }

  invalidate(prefix: string) {
    for (const [key, entry] of this.entries) if (key.startsWith(prefix)) {
      if (entry.pending) { entry.valid = false; entry.expires = 0; }
      else this.entries.delete(key);
    }
  }

  clear() { this.entries.clear(); }
}
