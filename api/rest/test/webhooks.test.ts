import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearWebhooks,
  deliverEvent,
  registerWebhook,
  signPayload,
  verifySignature,
} from "../src/webhooks";

beforeEach(() => clearWebhooks());

describe("webhook signatures", () => {
  it("accepts a valid signature and rejects a replay", () => {
    const timestamp = Date.now();
    const body = JSON.stringify({ id: "event-1", event_type: "payment" });
    const signature = signPayload("a-secure-test-secret", body, timestamp);

    expect(verifySignature({ secret: "a-secure-test-secret", body, signature, timestamp })).toEqual({ valid: true });
    expect(verifySignature({ secret: "a-secure-test-secret", body, signature, timestamp })).toEqual({
      valid: false,
      reason: "replayed",
    });
  });

  it("rejects stale and modified payloads", () => {
    const timestamp = 1_000;
    const body = JSON.stringify({ id: "event-1" });
    const signature = signPayload("a-secure-test-secret", body, timestamp);

    expect(verifySignature({ secret: "a-secure-test-secret", body, signature, timestamp, now: 400_000 })).toEqual({
      valid: false,
      reason: "stale",
    });
    expect(verifySignature({ secret: "a-secure-test-secret", body: `${body} `, signature, timestamp, now: 1_000 })).toEqual({
      valid: false,
      reason: "invalid",
    });
  });
});

describe("webhook delivery", () => {
  it("retries failures and de-duplicates an event", async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    const webhook = registerWebhook({
      url: "https://example.com/events",
      secret: "a-secure-test-secret",
      eventTypes: ["payment"],
    });
    const event = { id: "event-1", event_type: "payment" };

    const first = await deliverEvent(event, transport);
    const second = await deliverEvent(event, transport);

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ status: "delivered", attempts: 2, responseStatus: 200 });
    expect(second[0]).toEqual(first[0]);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[0][1]?.headers).toMatchObject({ "x-idempotency-key": `${webhook.id}:event-1` });
    expect(webhook.eventTypes).toEqual(["payment"]);
  });

  it("does not deliver to subscriptions for other event types", async () => {
    const transport = vi.fn();
    registerWebhook({
      url: "https://example.com/events",
      secret: "a-secure-test-secret",
      eventTypes: ["payment"],
    });

    await expect(deliverEvent({ id: "event-2", event_type: "audit" }, transport)).resolves.toEqual([]);
    expect(transport).not.toHaveBeenCalled();
  });
});
