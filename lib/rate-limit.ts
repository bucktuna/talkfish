import { HttpError } from "@/lib/http/errors";

type Limit = { limit: number; windowMs: number };

const buckets = new Map<string, number[]>();

export const LIMITS: Record<string, Limit> = {
  signup: { limit: 5, windowMs: 60 * 60 * 1000 },
  login: { limit: 20, windowMs: 60 * 60 * 1000 },
  contribution: { limit: 20, windowMs: 60 * 60 * 1000 },
  vote: { limit: 60, windowMs: 60 * 60 * 1000 },
  report: { limit: 8, windowMs: 60 * 60 * 1000 },
  coach: { limit: 60, windowMs: 10 * 60 * 1000 },
  review: { limit: 8, windowMs: 10 * 60 * 1000 },
};

const overrides = new Map<string, Limit>();

export function setLimitForTests(name: string, limit: Limit): void {
  overrides.set(name, limit);
}

export function resetRateLimitsForTests(): void {
  buckets.clear();
  overrides.clear();
}

export function clearRateLimitBucketsForTests(): void {
  buckets.clear();
}

export function enforceLimit(name: string, key: string): void {
  const rule = overrides.get(name) ?? LIMITS[name];
  if (!rule) return;
  const now = Date.now();
  const recent = (buckets.get(`${name}:${key}`) ?? []).filter((stamp) => now - stamp < rule.windowMs);
  if (recent.length >= rule.limit) {
    buckets.set(`${name}:${key}`, recent);
    const retry = Math.max(1, Math.ceil((recent[0] + rule.windowMs - now) / 1000));
    throw new HttpError(429, `Too many requests. Try again in about ${retry}s.`);
  }
  recent.push(now);
  buckets.set(`${name}:${key}`, recent);
}

export function clientKey(req: Request): string {
  if (process.env.ALLOW_TEST_CLIENT_KEY === "1") {
    const key = req.headers.get("x-talkfish-client");
    if (key && /^[A-Za-z0-9_-]{1,40}$/.test(key)) return key;
  }
  if (process.env.TRUST_PROXY === "1") {
    const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return `ip:${forwarded.slice(0, 64)}`;
  }
  return "local";
}
