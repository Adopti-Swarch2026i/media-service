/**
 * media-service entry point.
 *
 * Bootstraps Fastify with multipart support, CORS, Firebase auth,
 * and registers the media routes. Graceful shutdown closes Redis
 * and RabbitMQ connections.
 */

import Fastify from "fastify";
import multipart from "@fastify/multipart";
import cors from "@fastify/cors";

import { env } from "./config/env.js";
import { initFirebase } from "./config/firebase.js";
import { closeRedis } from "./config/redis.js";
import { closeRabbitMQ } from "./messaging/publisher.js";
import { mediaRoutes } from "./routes/media.routes.js";

async function main(): Promise<void> {
  // ── Firebase init ────────────────────────────────────
  initFirebase();

  // ── Fastify setup ────────────────────────────────────
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
      transport:
        env.NODE_ENV !== "production"
          ? { target: "pino-pretty", options: { colorize: true } }
          : undefined,
    },
  });

  // Multipart support (for file uploads)
  await app.register(multipart, {
    limits: {
      fileSize: env.MAX_FILE_SIZE_MB * 1024 * 1024,
      files: 1,
    },
  });

  // CORS — allow web + mobile clients
  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });

  // ── Routes ───────────────────────────────────────────
  await app.register(mediaRoutes);

  // ── Graceful shutdown ────────────────────────────────
  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal} — shutting down…`);
    await app.close();
    await closeRedis();
    await closeRabbitMQ();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // ── Start ────────────────────────────────────────────
  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`media-service listening on ${env.HOST}:${env.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
