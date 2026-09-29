export const WEATHER_CACHE_TTL_MS = 10 * 60_000;

export function cleanCity(city: string): string {
  return city.trim().replace(/\s+/g, " ").replace(/\s*,\s*/g, ",");
}

export function normalizeCity(city: string): string {
  return cleanCity(city).toLocaleLowerCase("ru");
}

export class MemoryCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly clock: () => number = Date.now,
    private readonly maxEntries = 500
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.clock()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    for (const [storedKey, entry] of this.entries) {
      if (entry.expiresAt <= this.clock()) this.entries.delete(storedKey);
    }
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    this.entries.set(key, { value, expiresAt: this.clock() + this.ttlMs });
  }
}
