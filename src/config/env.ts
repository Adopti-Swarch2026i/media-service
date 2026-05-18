/**
 * Centralised environment configuration.
 *
 * Every external knob is read here once and exported as a typed object.
 * The rest of the codebase imports `env` — never reads `process.env` directly.
 */

import "dotenv/config";

export const env = {
  // ── Server ──────────────────────────────────────────
  PORT: parseInt(process.env.PORT ?? "8084", 10),
  HOST: process.env.HOST ?? "0.0.0.0",
  NODE_ENV: process.env.NODE_ENV ?? "development",

  // ── Redis ───────────────────────────────────────────
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",

  // ── RabbitMQ ────────────────────────────────────────
  RABBITMQ_URL:
    process.env.RABBITMQ_URL ?? "amqps://adopti:__RABBITMQ_PASSWORD__@localhost:5671/",

  // ── Cloudinary ──────────────────────────────────────
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME ?? "",
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY ?? "",
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET ?? "",

  // ── Firebase ────────────────────────────────────────
  GOOGLE_APPLICATION_CREDENTIALS:
    process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "",

  // ── Limits ──────────────────────────────────────────
  MAX_FILE_SIZE_MB: parseInt(process.env.MAX_FILE_SIZE_MB ?? "5", 10),
  THUMBNAIL_WIDTH: parseInt(process.env.THUMBNAIL_WIDTH ?? "300", 10),
  REDIS_CACHE_TTL_DAYS: parseInt(process.env.REDIS_CACHE_TTL_DAYS ?? "30", 10),
} as const;

// Fail-fast en producción: si Cloudinary no está configurado, el primer
// upload daría 500 con un error opaco. Mejor cortar el boot con mensaje claro.
if (env.NODE_ENV === "production") {
  const missing: string[] = [];
  if (!env.CLOUDINARY_CLOUD_NAME) missing.push("CLOUDINARY_CLOUD_NAME");
  if (!env.CLOUDINARY_API_KEY) missing.push("CLOUDINARY_API_KEY");
  if (!env.CLOUDINARY_API_SECRET) missing.push("CLOUDINARY_API_SECRET");
  if (!env.GOOGLE_APPLICATION_CREDENTIALS) {
    missing.push("GOOGLE_APPLICATION_CREDENTIALS");
  }
  if (!env.RABBITMQ_URL || !env.RABBITMQ_URL.startsWith("amqps://")) {
    missing.push("RABBITMQ_URL must use amqps://");
  }
  if (missing.length > 0) {
    throw new Error(
      `[env] Missing required configuration in production: ${missing.join(", ")}`,
    );
  }
}
