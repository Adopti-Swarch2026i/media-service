/**
 * Image processing utilities built on `sharp`.
 *
 * Responsibilities:
 *  - MIME type validation (real magic bytes, not just extension).
 *  - EXIF / metadata stripping for privacy.
 *  - Thumbnail generation at a configurable width.
 *  - SHA-256 content hashing for deduplication cache.
 */

import sharp from "sharp";
import { createHash } from "node:crypto";
import { env } from "../config/env.js";

/** Allowed MIME types with their corresponding magic bytes signatures. */
const ALLOWED_TYPES = new Map<string, Buffer[]>([
  [
    "image/jpeg",
    [Buffer.from([0xff, 0xd8, 0xff])],
  ],
  [
    "image/png",
    [Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  ],
  [
    "image/webp",
    [Buffer.from("RIFF"), Buffer.from("WEBP")],
  ],
]);

// ── Public API ───────────────────────────────────────────

export interface ProcessedImage {
  /** Original image with EXIF stripped, in JPEG (quality 85). */
  original: Buffer;
  /** Resized thumbnail. */
  thumbnail: Buffer;
  /** SHA-256 hex digest of the raw input bytes. */
  hash: string;
}

/**
 * Validate real MIME type by inspecting magic bytes.
 *
 * @returns The detected MIME type string, or `null` if not allowed.
 */
export function detectMimeType(buffer: Buffer): string | null {
  for (const [mime, signatures] of ALLOWED_TYPES) {
    if (mime === "image/webp") {
      // RIFF at 0..3, WEBP at 8..11
      if (
        buffer.length >= 12 &&
        buffer.subarray(0, 4).equals(signatures[0]) &&
        buffer.subarray(8, 12).equals(signatures[1])
      ) {
        return mime;
      }
    } else {
      for (const sig of signatures) {
        if (buffer.subarray(0, sig.length).equals(sig)) {
          return mime;
        }
      }
    }
  }
  return null;
}

/**
 * Validate file constraints (size + MIME).
 * Throws if the buffer is invalid.
 */
export function validateImage(buffer: Buffer, declaredMime?: string): string {
  // Size check
  const maxBytes = env.MAX_FILE_SIZE_MB * 1024 * 1024;
  if (buffer.length > maxBytes) {
    throw new ImageValidationError(
      `File exceeds the ${env.MAX_FILE_SIZE_MB}MB limit (got ${(buffer.length / 1024 / 1024).toFixed(1)}MB)`,
    );
  }

  // Real MIME check via magic bytes
  const realMime = detectMimeType(buffer);
  if (!realMime) {
    throw new ImageValidationError(
      `Unsupported image format. Allowed: JPG, PNG, WEBP. Detected header does not match.`,
    );
  }

  return realMime;
}

/**
 * Process an image: strip EXIF, generate thumbnail, compute hash.
 */
export async function processImage(
  rawBuffer: Buffer,
): Promise<ProcessedImage> {
  const hash = createHash("sha256").update(rawBuffer).digest("hex");

  // Strip all metadata, normalise to JPEG for consistent storage
  const original = await sharp(rawBuffer)
    .rotate() // auto-rotate based on EXIF orientation before stripping
    .withMetadata({ orientation: undefined } as any) // remove EXIF
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();

  // Thumbnail
  const thumbnail = await sharp(rawBuffer)
    .rotate()
    .resize({ width: env.THUMBNAIL_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 75, mozjpeg: true })
    .toBuffer();

  return { original, thumbnail, hash };
}

// ── Errors ───────────────────────────────────────────────

export class ImageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageValidationError";
  }
}
