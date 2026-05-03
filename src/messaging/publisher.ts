/**
 * RabbitMQ event publisher for media-service.
 *
 * Mirrors the pattern in pets-service (pika / EventPublisher) but uses
 * amqplib for Node.js. Publishes to the shared `adopti.events` topic exchange.
 *
 * Convention (section 7.3 of p2_plan.md):
 *   - The message body is the event payload (no envelope wrapper).
 *   - `eventId` (UUID v4) and `eventTimestamp` (ISO 8601) travel in
 *     AMQP message headers, not in the body.
 */

import amqplib from "amqplib";
import { v4 as uuidv4 } from "uuid";
import { env } from "../config/env.js";

const EXCHANGE_NAME = "adopti.events";

let connection: amqplib.ChannelModel | null = null;
let channel: amqplib.Channel | null = null;

/**
 * Open (or reuse) a connection + channel and declare the exchange.
 */
async function ensureChannel(): Promise<amqplib.Channel | null> {
  if (channel) return channel;

  try {
    connection = await amqplib.connect(env.RABBITMQ_URL);
    channel = await connection.createChannel();

    await channel.assertExchange(EXCHANGE_NAME, "topic", { durable: true });

    connection.on("error", (err) => {
      console.error("[RabbitMQ] Connection error:", err.message);
      channel = null;
      connection = null;
    });

    connection.on("close", () => {
      console.warn("[RabbitMQ] Connection closed");
      channel = null;
      connection = null;
    });

    console.log(
      `[RabbitMQ] Connected — exchange '${EXCHANGE_NAME}' declared`,
    );
    return channel;
  } catch (err) {
    console.error("[RabbitMQ] Failed to connect:", (err as Error).message);
    channel = null;
    connection = null;
    return null;
  }
}

/**
 * Publish a domain event to RabbitMQ.
 *
 * @param routingKey - e.g. `pet.image.uploaded`
 * @param payload    - JSON-serialisable event data
 */
export async function publishEvent(
  routingKey: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const ch = await ensureChannel();
  if (!ch) {
    console.warn(
      `[RabbitMQ] Unavailable — dropping event ${routingKey}`,
    );
    return;
  }

  const eventId = uuidv4();
  const eventTimestamp = new Date().toISOString();

  try {
    ch.publish(
      EXCHANGE_NAME,
      routingKey,
      Buffer.from(JSON.stringify(payload)),
      {
        // events.md §2 exige delivery_mode=2 explícito (persistent:true es
        // equivalente, pero el spec menciona el número del frame AMQP).
        deliveryMode: 2,
        persistent: true,
        contentType: "application/json",
        contentEncoding: "utf-8",
        messageId: eventId,
        timestamp: Math.floor(Date.now() / 1000),
        headers: {
          eventId,
          eventTimestamp,
        },
      },
    );
    console.log(`[RabbitMQ] Published ${routingKey} (id=${eventId})`);
  } catch (err) {
    console.error(
      `[RabbitMQ] Failed to publish ${routingKey}:`,
      (err as Error).message,
    );
    channel = null;
    connection = null;
  }
}

/**
 * Gracefully close the RabbitMQ connection.
 */
export async function closeRabbitMQ(): Promise<void> {
  try {
    if (channel) await channel.close();
    if (connection) await connection.close();
  } catch {
    // swallow — shutting down anyway
  } finally {
    channel = null;
    connection = null;
    console.log("[RabbitMQ] Connection closed");
  }
}
