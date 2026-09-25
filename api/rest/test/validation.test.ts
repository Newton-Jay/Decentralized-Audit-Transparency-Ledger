import { describe, it, expect } from "vitest";
import {
  PaginationSchema,
  EventFilterSchema,
  IndexParamSchema,
  EventTypeParamSchema,
  LogEventSchema,
} from "../src/validation";

describe("PaginationSchema", () => {
  it("defaults limit to 50 and offset to 0", () => {
    const result = PaginationSchema.parse({});
    expect(result).toEqual({ limit: 50, offset: 0 });
  });

  it("coerces string numbers", () => {
    const result = PaginationSchema.parse({ limit: "20", offset: "10" });
    expect(result).toEqual({ limit: 20, offset: 10 });
  });

  it("rejects limits above 1000", () => {
    expect(() => PaginationSchema.parse({ limit: 5000 })).toThrow();
  });

  it("rejects negative offset", () => {
    expect(() => PaginationSchema.parse({ offset: -1 })).toThrow();
  });

  it("rejects zero limit", () => {
    expect(() => PaginationSchema.parse({ limit: 0 })).toThrow();
  });
});

describe("EventFilterSchema", () => {
  it("returns null for undefined input", () => {
    const result = EventFilterSchema.parse(undefined);
    expect(result).toBeNull();
  });

  it("parses valid JSON filter", () => {
    const input = JSON.stringify({ type: "payment", submitter: "GABC" });
    const result = EventFilterSchema.parse(input);
    expect(result).toEqual({ type: "payment", submitter: "GABC" });
  });

  it("rejects invalid JSON", () => {
    expect(() => EventFilterSchema.parse("not-json")).toThrow();
  });

  it("strips unknown fields", () => {
    const input = JSON.stringify({ type: "payment", unknown: "field" });
    const result = EventFilterSchema.parse(input);
    expect(result).toEqual({ type: "payment" });
  });
});

describe("IndexParamSchema", () => {
  it("parses valid index", () => {
    const result = IndexParamSchema.parse({ index: "42" });
    expect(result.index).toBe(42);
  });

  it("rejects negative index", () => {
    expect(() => IndexParamSchema.parse({ index: "-1" })).toThrow();
  });

  it("rejects non-integer index", () => {
    expect(() => IndexParamSchema.parse({ index: "1.5" })).toThrow();
  });
});

describe("EventTypeParamSchema", () => {
  it("parses valid event type", () => {
    const result = EventTypeParamSchema.parse({ type: "payment" });
    expect(result.type).toBe("payment");
  });

  it("rejects empty type", () => {
    expect(() => EventTypeParamSchema.parse({ type: "" })).toThrow();
  });

  it("rejects type exceeding 32 chars", () => {
    expect(() => EventTypeParamSchema.parse({ type: "a".repeat(33) })).toThrow();
  });
});

describe("LogEventSchema", () => {
  const validEvent = {
    submitter: "G".padEnd(56, "A"),
    eventType: "payment",
    metadata: "48656c6c6f",
  };

  it("accepts valid event", () => {
    const result = LogEventSchema.parse(validEvent);
    expect(result).toEqual(validEvent);
  });

  it("rejects invalid submitter format", () => {
    expect(() =>
      LogEventSchema.parse({ ...validEvent, submitter: "invalid" })
    ).toThrow();
  });

  it("rejects eventType with special chars", () => {
    expect(() =>
      LogEventSchema.parse({ ...validEvent, eventType: "pay-ment" })
    ).toThrow();
  });

  it("rejects non-hex metadata", () => {
    expect(() =>
      LogEventSchema.parse({ ...validEvent, metadata: "not-hex!" })
    ).toThrow();
  });

  it("rejects metadata exceeding 1024 chars", () => {
    expect(() =>
      LogEventSchema.parse({ ...validEvent, metadata: "a".repeat(1025) })
    ).toThrow();
  });
});
