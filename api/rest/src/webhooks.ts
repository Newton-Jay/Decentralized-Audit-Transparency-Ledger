import { createHmac, timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";

export interface WebhookRegistration {
  id: string;
  url: string;
  secret: string;
  eventTypes: string[];
  active: boolean;
  createdAt: number;
}

export interface WebhookDelivery {
  id: string;
  registrationId: string;
  eventId: string;
  status: "delivered" | "failed";
  attempts: number;
  responseStatus?: number;
  error?: string;
  deliveredAt: number;
}

export interface WebhookEvent {
  id: string;
  event_type: string;
  timestamp?: number;
}

const DEFAULT_REPLAY_WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const registrations = new Map<string, WebhookRegistration>();
const deliveries = new Map<string, WebhookDelivery>();
const seenEvents = new Map<string, number>();
const deliveredEvents = new Map<string, WebhookDelivery>();

export function registerWebhook(input: {
  url: string;
  secret: string;
  eventTypes?: string[];
}): WebhookRegistration {
  const url = new URL(input.url);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Webhook URL must use http or https");
  if (!input.secret || input.secret.length < 16) throw new Error("Webhook secret must be at least 16 characters");
  const registration: WebhookRegistration = {
    id: randomUUID(),
    url: url.toString(),
    secret: input.secret,
    eventTypes: input.eventTypes?.length ? input.eventTypes : ["*"],
    active: true,
    createdAt: Date.now(),
  };
  registrations.set(registration.id, registration);
  return registration;
}

export function getWebhook(id: string): WebhookRegistration | undefined {
  return registrations.get(id);
}

export function listWebhooks(): Array<Omit<WebhookRegistration, "secret">> {
  return [...registrations.values()].map(({ secret: _secret, ...publicRegistration }) => publicRegistration);
}

export function removeWebhook(id: string): boolean {
  return registrations.delete(id);
}

export function clearWebhooks(): void {
  registrations.clear();
  deliveries.clear();
  seenEvents.clear();
  deliveredEvents.clear();
}

export function signPayload(secret: string, body: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function verifySignature(input: {
  secret: string;
  body: string;
  signature: string;
  timestamp: number;
  now?: number;
}): { valid: boolean; reason?: "malformed" | "stale" | "replayed" | "invalid" } {
  const now = input.now ?? Date.now();
  if (!Number.isInteger(input.timestamp) || Math.abs(now - input.timestamp) > DEFAULT_REPLAY_WINDOW_MS) {
    return { valid: false, reason: "stale" };
  }
  if (!/^[0-9a-f]{64}$/i.test(input.signature)) return { valid: false, reason: "malformed" };
  const expected = signPayload(input.secret, input.body, input.timestamp);
  const actualBytes = Buffer.from(input.signature, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    return { valid: false, reason: "invalid" };
  }
  const replayKey = `${input.timestamp}.${input.signature}`;
  const previous = seenEvents.get(replayKey);
  if (previous !== undefined && now - previous <= DEFAULT_REPLAY_WINDOW_MS) {
    return { valid: false, reason: "replayed" };
  }
  seenEvents.set(replayKey, now);
  for (const [key, seenAt] of seenEvents) {
    if (now - seenAt > DEFAULT_REPLAY_WINDOW_MS) seenEvents.delete(key);
  }
  return { valid: true };
}

export function getWebhookDeliveries(): WebhookDelivery[] {
  return [...deliveries.values()];
}

export async function deliverWebhook(
  registration: WebhookRegistration,
  event: WebhookEvent,
  transport: typeof fetch = fetch,
): Promise<WebhookDelivery> {
  const idempotencyKey = `${registration.id}:${event.id}`;
  const existing = deliveredEvents.get(idempotencyKey);
  if (existing) return existing;
  const body = JSON.stringify(event);
  const timestamp = Date.now();
  const signature = signPayload(registration.secret, body, timestamp);
  let lastError = "delivery failed";
  let lastStatus: number | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await transport(registration.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-audit-event-id": event.id,
          "x-idempotency-key": idempotencyKey,
          "x-audit-event-signature": `sha256=${signature}`,
          "x-audit-event-timestamp": String(timestamp),
        },
        body,
      });
      lastStatus = response.status;
      if (response.ok) {
        const delivery: WebhookDelivery = {
          id: randomUUID(),
          registrationId: registration.id,
          eventId: event.id,
          status: "delivered",
          attempts: attempt,
          responseStatus: response.status,
          deliveredAt: Date.now(),
        };
        deliveries.set(delivery.id, delivery);
        deliveredEvents.set(idempotencyKey, delivery);
        return delivery;
      }
      lastError = `endpoint returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  const delivery: WebhookDelivery = {
    id: randomUUID(),
    registrationId: registration.id,
    eventId: event.id,
    status: "failed",
    attempts: MAX_ATTEMPTS,
    responseStatus: lastStatus,
    error: lastError,
    deliveredAt: Date.now(),
  };
  deliveries.set(delivery.id, delivery);
  deliveredEvents.set(idempotencyKey, delivery);
  return delivery;
}

export async function deliverEvent(event: WebhookEvent, transport: typeof fetch = fetch): Promise<WebhookDelivery[]> {
  return Promise.all(
    [...registrations.values()].filter((registration) => registration.active && (registration.eventTypes.includes("*") || registration.eventTypes.includes(event.event_type)))
      .map((registration) => deliverWebhook(registration, event, transport)),
  );
}
