/**
 * Rate limiting + anti-farm pair cooldowns.
 * Redis-backed when REDIS_URL is set (multi-node safe), in-memory otherwise.
 */
import Redis from "ioredis";

export interface HitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

export interface Limiter {
  kind: "redis" | "memory";
  hit(key: string, windowMs: number, max: number): Promise<HitResult>;
  setPair(a: string, b: string, ttlMs: number): Promise<void>;
  hasPair(a: string, b: string): Promise<boolean>;
  incDailyPair(a: string, b: string): Promise<number>;
  close(): void;
}

const pairKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);

class MemLimiter implements Limiter {
  kind = "memory" as const;
  private counters = new Map<string, { count: number; reset: number }>();
  private pairs = new Map<string, number>();
  private daily = new Map<string, { count: number; day: string }>();

  async hit(key: string, windowMs: number, max: number): Promise<HitResult> {
    const now = Date.now();
    const cur = this.counters.get(key);
    if (!cur || cur.reset <= now) {
      this.counters.set(key, { count: 1, reset: now + windowMs });
      if (this.counters.size > 20000) {
        for (const [k, v] of this.counters) if (v.reset <= now) this.counters.delete(k);
      }
      return { allowed: max >= 1, remaining: Math.max(0, max - 1), resetMs: windowMs };
    }
    cur.count++;
    return { allowed: cur.count <= max, remaining: Math.max(0, max - cur.count), resetMs: cur.reset - now };
  }

  async setPair(a: string, b: string, ttlMs: number) {
    this.pairs.set(pairKey(a, b), Date.now() + ttlMs);
    if (this.pairs.size > 20000) {
      const now = Date.now();
      for (const [k, v] of this.pairs) if (v <= now) this.pairs.delete(k);
    }
  }

  async hasPair(a: string, b: string) {
    const exp = this.pairs.get(pairKey(a, b));
    return !!exp && exp > Date.now();
  }

  async incDailyPair(a: string, b: string) {
    const day = new Date().toISOString().slice(0, 10);
    const k = pairKey(a, b);
    const cur = this.daily.get(k);
    if (!cur || cur.day !== day) {
      this.daily.set(k, { count: 1, day });
      return 1;
    }
    cur.count++;
    return cur.count;
  }

  close() {}
}

class RedisLimiter implements Limiter {
  kind = "redis" as const;
  constructor(private redis: Redis) {}

  async hit(key: string, windowMs: number, max: number): Promise<HitResult> {
    const k = `mb:rl:${key}`;
    const n = await this.redis.incr(k);
    if (n === 1) await this.redis.pexpire(k, windowMs);
    const ttl = await this.redis.pttl(k);
    return { allowed: n <= max, remaining: Math.max(0, max - n), resetMs: Math.max(0, ttl) };
  }

  async setPair(a: string, b: string, ttlMs: number) {
    await this.redis.set(`mb:pair:${pairKey(a, b)}`, "1", "PX", ttlMs);
  }

  async hasPair(a: string, b: string) {
    return (await this.redis.exists(`mb:pair:${pairKey(a, b)}`)) === 1;
  }

  async incDailyPair(a: string, b: string) {
    const day = new Date().toISOString().slice(0, 10);
    const k = `mb:pairday:${day}:${pairKey(a, b)}`;
    const n = await this.redis.incr(k);
    if (n === 1) await this.redis.expire(k, 90000);
    return n;
  }

  close() {
    this.redis.disconnect();
  }
}

/** globalThis slot — see store.ts for why (route chunks share one process). */
const G = globalThis as unknown as { __mogbattle_limiter?: Limiter };

export function getLimiter(): Limiter {
  if (!G.__mogbattle_limiter) {
    if (process.env.REDIS_URL) {
      const redis = new Redis(process.env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 });
      redis.on("error", () => {
        /* fall back silently; operations degrade to failures handled by callers */
      });
      G.__mogbattle_limiter = new RedisLimiter(redis);
      // eslint-disable-next-line no-console
      console.log("[mogbattle] limiter: Redis");
    } else {
      G.__mogbattle_limiter = new MemLimiter();
      // eslint-disable-next-line no-console
      console.log("[mogbattle] limiter: in-memory (set REDIS_URL for Redis)");
    }
  }
  return G.__mogbattle_limiter;
}
