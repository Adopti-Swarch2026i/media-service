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
const TTL_SECONDS = env.REDIS_CACHE_TTL_DAYS * 24 * 60 * 60;

function cacheKey(hash: string): string {
  return `${CACHE_PREFIX}${hash}`;
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
    petId?: string,
  ): Promise<UploadResult> {
    // 1. Validate
    validateImage(fileBuffer);

    // 2. Process
    const { original, thumbnail, hash } = await processImage(fileBuffer);

    // 3. Cache check
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

    // 4. Upload to Cloudinary
    const folder = `media/${userId}`;

    const [originalResult, thumbnailResult] = await Promise.all([
      this.uploadToCloudinary(original, folder, `${hash}_original`),
      this.uploadToCloudinary(thumbnail, folder, `${hash}_thumb`),
    ]);

    const result: UploadResult = {
      url: originalResult,
      thumbnailUrl: thumbnailResult,
      hash,
      cached: false,
    };

    // 5. Cache in Redis
    const cacheValue: CachedMedia = {
      url: result.url,
      thumbnailUrl: result.thumbnailUrl,
    };
    await redis.setex(cacheKey(hash), TTL_SECONDS, JSON.stringify(cacheValue));
    console.log(
      `[MediaService] Cached hash=${hash.slice(0, 12)}… (TTL=${env.REDIS_CACHE_TTL_DAYS}d)`,
    );

    // 6. Emit event
    await publishEvent("pet.image.uploaded", {
      userId,
      petId: petId ?? null,
      url: result.url,
      thumbnailUrl: result.thumbnailUrl,
      hash,
    });

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
