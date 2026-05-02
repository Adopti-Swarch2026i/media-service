/**
 * Firebase Admin SDK initialisation.
 *
 * The SDK picks up credentials automatically via
 * GOOGLE_APPLICATION_CREDENTIALS (path to service account JSON).
 *
 * Initialisation is idempotent — calling this multiple times is safe.
 */

import admin from "firebase-admin";

let initialised = false;

export function initFirebase(): void {
  if (initialised) return;

  // If GOOGLE_APPLICATION_CREDENTIALS is set, the SDK auto-loads credentials.
  // Otherwise try the ADC flow (works in GCP environments).
  if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
  }

  initialised = true;
  console.log("[Firebase] Admin SDK initialised");
}

export { admin };
