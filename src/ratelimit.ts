import type { Request, Response, NextFunction } from "express";

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Lightweight in-memory fixed-window rate limiter keyed by client IP.
 * No external dependencies. Behind a reverse proxy (nginx), it reads the real
 * client IP from the X-Forwarded-For header (make sure nginx sets it).
 */
export function rateLimit(opts: {
  windowMs: number;
  max: number;
  message?: string;
}) {
  const buckets = new Map<string, Bucket>();

  // Periodically drop stale buckets so memory stays bounded.
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of buckets) {
      if (now > b.resetAt) buckets.delete(ip);
    }
  }, opts.windowMs);
  cleanup.unref?.();

  return (req: Request, res: Response, next: NextFunction) => {
    const fwd = (req.headers["x-forwarded-for"] as string | undefined)
      ?.split(",")[0]
      ?.trim();
    const ip = fwd || req.socket.remoteAddress || "unknown";

    const now = Date.now();
    let bucket = buckets.get(ip);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(ip, bucket);
    }
    bucket.count++;

    if (bucket.count > opts.max) {
      res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
      res
        .status(429)
        .json({ error: opts.message ?? "Too many requests. Please slow down." });
      return;
    }
    next();
  };
}
