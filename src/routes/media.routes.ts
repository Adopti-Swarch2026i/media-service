/**
 * Media routes — Fastify plugin.
 *
 * Endpoints:
 *  POST /api/media/upload   — Upload a new image (multipart, auth required)
 *  GET  /api/media/:hash    — Retrieve cached URLs by content hash
 *  GET  /api/media/health   — Health check
 */

import type { FastifyInstance } from "fastify";
import { authGuard } from "../middleware/auth.js";
import { MediaService } from "../services/media.service.js";
import { ImageValidationError } from "../utils/image.js";

const mediaService = new MediaService();

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  // ── Health ─────────────────────────────────────────
  app.get("/api/media/health", async (_req, reply) => {
    return reply.send({
      status: "ok",
      service: "media-service",
      timestamp: new Date().toISOString(),
    });
  });

  // ── Upload ─────────────────────────────────────────
  app.post(
    "/api/media/upload",
    { preHandler: authGuard },
    async (request, reply) => {
      try {
        const data = await request.file();

        if (!data) {
          return reply.status(400).send({ error: "No file provided" });
        }

        // Consume the stream into a buffer
        const chunks: Buffer[] = [];
        for await (const chunk of data.file) {
          chunks.push(chunk as Buffer);
        }
        const fileBuffer = Buffer.concat(chunks);

        if (fileBuffer.length === 0) {
          return reply.status(400).send({ error: "Empty file" });
        }

        // Optional petId from form fields
        const petId =
          (data.fields as Record<string, any>)?.petId?.value as
            | string
            | undefined;

        const result = await mediaService.upload(
          fileBuffer,
          request.userId!,
          petId,
        );

        const statusCode = result.cached ? 200 : 201;

        return reply.status(statusCode).send({
          url: result.url,
          thumbnailUrl: result.thumbnailUrl,
          hash: result.hash,
          cached: result.cached,
        });
      } catch (err) {
        if (err instanceof ImageValidationError) {
          return reply.status(400).send({ error: err.message });
        }
        console.error("[Upload] Unexpected error:", err);
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );

  // ── Get by hash ────────────────────────────────────
  app.get<{ Params: { hash: string } }>(
    "/api/media/:hash",
    async (request, reply) => {
      const { hash } = request.params;

      if (!/^[a-f0-9]{64}$/.test(hash)) {
        return reply
          .status(400)
          .send({ error: "Invalid hash format — expected SHA-256 hex (64 chars)" });
      }

      const media = await mediaService.getByHash(hash);

      if (!media) {
        return reply.status(404).send({ error: "Media not found" });
      }

      return reply.send({
        url: media.url,
        thumbnailUrl: media.thumbnailUrl,
        hash,
      });
    },
  );
}
