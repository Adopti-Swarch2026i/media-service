/**
 * Redis client (ioredis) — singleton.
 *
 * Used for:
 *  1. Image hash → URL cache (avoids duplicate Cloudinary uploads).
 *  2. Future: BullMQ backing store for async job processing.
 */

import Redis from "ioredis";
import { env } from "./env.js";

let redis: Redis | null = null;

export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        const delay = Math.min(times * 200, 5000);
        return delay;
      },
      lazyConnect: false,
    });

    redis.on("connect", () => {
      console.log("[Redis] Connected");
    });

    redis.on("error", (err) => {
      const sanitized = err.message.replace(
        /(:\/\/)([^:]+):([^@]+)@/g,
        "$1$2:***REDACTED***@",
      );
      console.error("[Redis] Connection error:", sanitized);
    });
  }
  return redis;
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
    console.log("[Redis] Connection closed");
  }
}
