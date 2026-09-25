import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  validateParams,
  validateQuery,
  validateResponse,
} from "../src/middleware/validation";
import {
  getRequestValidator,
  getResponseValidator,
  schemas,
  type EventIndexParams,
  type EventListQuery,
} from "../src/schema-registry";

const validEvent = {
  id: "0",
  index: 0,
  timestamp: 1,
  event_type: "payment",
  submitter: "GABC",
  metadata: "48656c6c6f",
  event_hash: "a".repeat(64),
  prev_hash: "0".repeat(64),
};

describe("JSON Schema registry", () => {
  it("compiles every registered schema", () => {
    for (const name of Object.keys(schemas)) {
      expect(getRequestValidator(name as keyof typeof schemas)).toBeTypeOf("function");
      expect(getResponseValidator(name as keyof typeof schemas)).toBeTypeOf("function");
    }
  });

  it("coerces and defaults event list query values", () => {
    const query = { limit: "25" };
    const validator = getRequestValidator("eventListQuery");

    expect(validator(query)).toBe(true);
    expect(query).toEqual({ limit: 25, offset: 0 });
  });

  it("rejects invalid event response data", () => {
    const validator = getResponseValidator("eventResponse");

    expect(validator({ data: validEvent })).toBe(true);
    expect(validator({ data: { ...validEvent, event_hash: "invalid" } })).toBe(false);
  });

  it("validates decoded event filters", () => {
    const validator = getRequestValidator("eventFilter");

    expect(validator({ type: "payment", startTime: 10 })).toBe(true);
    expect(validator({ startTime: -1 })).toBe(false);
    expect(validator({ unknown: true })).toBe(false);
  });
});

describe("JSON Schema middleware", () => {
  const testApp = express();

  testApp.get(
    "/events",
    validateQuery("eventListQuery"),
    validateResponse("eventListResponse"),
    (_req, res) => {
      const query = res.locals.validatedQuery as EventListQuery;
      res.json({ data: [], total: 0, limit: query.limit, offset: query.offset });
    }
  );

  testApp.get(
    "/events/:index",
    validateParams("eventIndexParams"),
    validateResponse("eventResponse"),
    (_req, res) => {
      const { index } = res.locals.validatedParams as EventIndexParams;
      res.json({ data: { ...validEvent, index, id: String(index) } });
    }
  );

  testApp.get("/broken", validateResponse("eventResponse"), (_req, res) => {
    res.json({ data: {} });
  });

  it("returns structured errors for invalid requests", async () => {
    const response = await request(testApp).get("/events").query({ limit: 0 });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Invalid query parameters",
    });
    expect(response.body.error.details[0].field).toBe("limit");
  });

  it("coerces validated path parameters", async () => {
    const response = await request(testApp).get("/events/7");

    expect(response.status).toBe(200);
    expect(response.body.data.index).toBe(7);
  });

  it("rejects invalid path parameters", async () => {
    const response = await request(testApp).get("/events/1.5");

    expect(response.status).toBe(400);
    expect(response.body.error.details[0].field).toBe("index");
  });

  it("blocks malformed success responses", async () => {
    const response = await request(testApp).get("/broken");

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("RESPONSE_VALIDATION_ERROR");
  });
});
