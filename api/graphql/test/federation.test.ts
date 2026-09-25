import { afterEach, describe, expect, it } from "vitest";
import { graphql } from "graphql";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { typeDefs } from "../src/schema";
import { publishEventLogged, resetEvents, resolvers } from "../src/resolvers";

const schema = makeExecutableSchema({ typeDefs, resolvers });

afterEach(() => resetEvents());

describe("GraphQL federation", () => {
  it("exposes the Event key and service SDL", async () => {
    const result = await graphql({ schema, source: "{ _service { sdl } }" });
    expect(result.errors).toBeUndefined();
    expect(result.data?._service.sdl).toContain('type Event @key(fields: "id")');
  });

  it("resolves an Event representation through _entities", async () => {
    await publishEventLogged({
      id: "event-1",
      index: 1,
      timestamp: 1,
      event_type: "payment",
      submitter: "GABC",
      metadata: "invoice",
      event_hash: "a".repeat(64),
      prev_hash: "0".repeat(64),
    });

    const result = await graphql({
      schema,
      source: `query($representations: [_Any!]!) {
        _entities(representations: $representations) {
          ... on Event { id index event_type }
        }
      }`,
      variableValues: { representations: [{ __typename: "Event", id: "event-1" }] },
    });

    expect(result.errors).toBeUndefined();
    expect(result.data?._entities).toEqual([{ id: "event-1", index: 1, event_type: "payment" }]);
  });
});
