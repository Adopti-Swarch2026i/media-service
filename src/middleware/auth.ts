/**
 * Firebase Auth middleware for Fastify.
 *
 * Validates the `Authorization: Bearer <idToken>` header against
 * Firebase Admin SDK and decorates the request with `userId`.
 */

import type { FastifyRequest, FastifyReply } from "fastify";
import { admin } from "../config/firebase.js";

/** Extend Fastify request to carry the verified user id. */
declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

export async function authGuard(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return reply
      .status(401)
      .send({ error: "Missing or invalid Authorization header" });
  }

  const idToken = authHeader.slice(7);

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    request.userId = decoded.uid;
  } catch (err) {
    return reply
      .status(401)
      .send({ error: "Invalid or expired token" });
  }
}
