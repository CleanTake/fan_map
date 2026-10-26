type Window = { count: number; expiresAt: number };

export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly capacity: number;

  constructor(limit: number, windowMs: number, capacity = 10000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.capacity = capacity;
  }

  consume(key: string, now = Date.now()): boolean {
    const existing = this.windows.get(key);
    if (existing && existing.expiresAt > now) {
      if (existing.count >= this.limit) return false;
      existing.count += 1;
      return true;
    }
    if (this.windows.size >= this.capacity) {
      for (const [storedKey, window] of this.windows) {
        if (window.expiresAt <= now) this.windows.delete(storedKey);
      }
      if (!existing && this.windows.size >= this.capacity) return false;
    }
    this.windows.set(key, { count: 1, expiresAt: now + this.windowMs });
    return true;
  }
}

export type AuthLimits = { global: RateLimiter; email: RateLimiter };

export function createAuthLimits(): AuthLimits {
  return {
    global: new RateLimiter(60, 60 * 1000, 1),
    email: new RateLimiter(8, 10 * 60 * 1000),
  };
}

const shared = globalThis as typeof globalThis & { fanmapAuthLimits?: AuthLimits };
export const authLimits = shared.fanmapAuthLimits ??= createAuthLimits();
