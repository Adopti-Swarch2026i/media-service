/**
 * MediaService — core business logic.
 *
 * Orchestrates:
 *  1. Image validation & processing (sharp).
 *  2. Redis cache lookup / write (deduplication by SHA-256 hash).
 *  3. Cloudinary upload (original + thumbnail).
 *  4. RabbitMQ event emission (`pet.image.uploaded`).
 */

import { cloudinary } from "../config/cloudinary.js";
import { getRedis } from "../config/redis.js";
import { publishEvent } from "../messaging/publisher.js";
import {
  validateImage,
  processImage,
  ImageValidationError,
} from "../utils/image.js";
import { env } from "../config/env.js";

// ── Types ────────────────────────────────────────────────

export interface UploadResult {
  url: string;
  thumbnailUrl: string;
  hash: string;
  cached: boolean;
}

export interface CachedMedia {
  url: string;
  thumbnailUrl: string;
}

// ── Redis key helpers ────────────────────────────────────

const CACHE_PREFIX = "media:hash:";
const LOCK_PREFIX = "media:lock:";
const TTL_SECONDS = env.REDIS_CACHE_TTL_DAYS * 24 * 60 * 60;
// Lock TTL: ventana razonable para subir 1 archivo a Cloudinary (más
// generoso que el típico ~3-5s) sin que un crash deje el lock atascado.
const LOCK_TTL_SECONDS = 60;
const LOCK_POLL_INTERVAL_MS = 200;
const LOCK_MAX_WAIT_MS = 30_000;

function cacheKey(hash: string): string {
  return `${CACHE_PREFIX}${hash}`;
}

function lockKey(hash: string): string {
  return `${LOCK_PREFIX}${hash}`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ── Service ──────────────────────────────────────────────

export class MediaService {
  /**
   * Upload an image with full processing pipeline.
   *
   * Flow:
   *  1. Validate size + MIME (magic bytes).
   *  2. Process (strip EXIF, thumbnail, hash).
   *  3. Check Redis cache — return early if hit.
   *  4. Upload original + thumbnail to Cloudinary.
   *  5. Cache the result in Redis.
   *  6. Emit `pet.image.uploaded` event to RabbitMQ.
   */
  async upload(
    fileBuffer: Buffer,
    userId: string,
    petId: number | null = null,
  ): Promise<UploadResult> {
    // 1. Validate
    validateImage(fileBuffer);

    // 2. Process
    const { original, thumbnail, hash } = await processImage(fileBuffer);

    // 3. Cache check (rápido, sin lock)
    const redis = getRedis();
    const cached = await redis.get(cacheKey(hash));
    if (cached) {
      const parsed: CachedMedia = JSON.parse(cached);
      console.log(`[MediaService] Cache HIT for hash=${hash.slice(0, 12)}…`);
      return {
        url: parsed.url,
        thumbnailUrl: parsed.thumbnailUrl,
        hash,
        cached: true,
      };
    }

    // 4. Lock por hash con SET NX EX. Si ya hay un upload en vuelo del
    //    mismo archivo, esperamos al cache final en lugar de subir doble
    //    (evita doble billing en Cloudinary y doble evento en RabbitMQ).
    const lockId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const acquired = await redis.set(
      lockKey(hash),
      lockId,
      "EX",
      LOCK_TTL_SECONDS,
      "NX",
    );

    if (!acquired) {
      // Otro request está procesando el mismo hash. Polling al cache.
      const waited = Date.now();
      while (Date.now() - waited < LOCK_MAX_WAIT_MS) {
        await sleep(LOCK_POLL_INTERVAL_MS);
        const c = await redis.get(cacheKey(hash));
        if (c) {
          const parsed: CachedMedia = JSON.parse(c);
          console.log(
            `[MediaService] Cache HIT after wait for hash=${hash.slice(0, 12)}…`,
          );
          return {
            url: parsed.url,
            thumbnailUrl: parsed.thumbnailUrl,
            hash,
            cached: true,
          };
        }
      }
      // El holder anterior no terminó (crashed o lento). Tomamos el lock
      // por TTL y procedemos: el otro request ya devolvió 500 al cliente.
      console.warn(
        `[MediaService] Timeout esperando lock hash=${hash.slice(0, 12)}…, retomando`,
      );
    }

    let result: UploadResult;
    try {
      // 5. Upload to Cloudinary
      const folder = `media/${userId}`;

      const [originalResult, thumbnailResult] = await Promise.all([
        this.uploadToCloudinary(original, folder, `${hash}_original`),
        this.uploadToCloudinary(thumbnail, folder, `${hash}_thumb`),
      ]);

      result = {
        url: originalResult,
        thumbnailUrl: thumbnailResult,
        hash,
        cached: false,
      };

      // 6. Cache in Redis
      const cacheValue: CachedMedia = {
        url: result.url,
        thumbnailUrl: result.thumbnailUrl,
      };
      await redis.setex(
        cacheKey(hash),
        TTL_SECONDS,
        JSON.stringify(cacheValue),
      );
      console.log(
        `[MediaService] Cached hash=${hash.slice(0, 12)}… (TTL=${env.REDIS_CACHE_TTL_DAYS}d)`,
      );

      // 7. Emit event
      await publishEvent("pet.image.uploaded", {
        userId,
        petId,
        url: result.url,
        thumbnailUrl: result.thumbnailUrl,
        hash,
      });
    } finally {
      // Release lock solo si seguimos siendo el holder (compare-and-delete
      // via Lua script). Evita borrar un lock que tomó otro proceso por TTL.
      try {
        await redis.eval(
          "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
          1,
          lockKey(hash),
          lockId,
        );
      } catch (err) {
        console.warn(
          "[MediaService] Failed to release lock:",
          (err as Error).message,
        );
      }
    }

    return result;
  }

  /**
   * Retrieve cached media URLs by hash.
   */
  async getByHash(hash: string): Promise<CachedMedia | null> {
    const redis = getRedis();
    const raw = await redis.get(cacheKey(hash));
    if (!raw) return null;
    return JSON.parse(raw) as CachedMedia;
  }

  // ── Private helpers ─────────────────────────────────

  private async uploadToCloudinary(
    buffer: Buffer,
    folder: string,
    publicId: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder,
          public_id: publicId,
          resource_type: "image",
          overwrite: true,
          format: "jpg",
        },
        (error, result) => {
          if (error) return reject(error);
          if (!result) return reject(new Error("Cloudinary returned no result"));
          resolve(result.secure_url);
        },
      );
      stream.end(buffer);
    });
  }
}
