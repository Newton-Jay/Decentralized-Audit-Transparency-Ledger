import Ajv, { type AnySchema, type ValidateFunction } from "ajv";

const eventSchema = {
  type: "object",
  additionalProperties: true,
  required: [
    "id",
    "index",
    "timestamp",
    "event_type",
    "submitter",
    "metadata",
    "event_hash",
    "prev_hash",
  ],
  properties: {
    id: { type: "string", minLength: 1 },
    index: { type: "integer", minimum: 0 },
    timestamp: { type: "integer", minimum: 0 },
    event_type: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[a-z0-9_]+$",
    },
    submitter: { type: "string", minLength: 1, maxLength: 128 },
    metadata: { type: "string", maxLength: 1024 },
    event_hash: { type: "string", pattern: "^(0x)?[0-9a-fA-F]{64}$" },
    prev_hash: { type: "string", pattern: "^(0x)?[0-9a-fA-F]{64}$" },
  },
} satisfies AnySchema;

const paginationProperties = {
  limit: { type: "integer", minimum: 1, maximum: 1000, default: 50 },
  offset: { type: "integer", minimum: 0, default: 0 },
  cursor: { type: "string", minLength: 1 },
} satisfies AnySchema;

export const schemas = {
  event: eventSchema,
  eventResponse: {
    type: "object",
    additionalProperties: true,
    required: ["data"],
    properties: { data: eventSchema },
  },
  eventListResponse: {
    type: "object",
    additionalProperties: true,
    required: ["data"],
    properties: {
      data: { type: "array", items: eventSchema },
      total: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1 },
      offset: { type: "integer", minimum: 0 },
    },
  },
  eventListQuery: {
    type: "object",
    additionalProperties: false,
    properties: {
      ...paginationProperties,
      filter: { type: "string", maxLength: 4096 },
    },
  },
  eventTypeQuery: {
    type: "object",
    additionalProperties: false,
    properties: paginationProperties,
  },
  eventIndexParams: {
    type: "object",
    additionalProperties: false,
    required: ["index"],
    properties: {
      index: { type: "integer", minimum: 0 },
    },
  },
  eventTypeParams: {
    type: "object",
    additionalProperties: false,
    required: ["type"],
    properties: {
      type: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        pattern: "^[a-z0-9_]+$",
      },
    },
  },
  eventFilter: {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", minLength: 1, maxLength: 128 },
      submitter: { type: "string", minLength: 1, maxLength: 128 },
      metadata: { type: "string", minLength: 1, maxLength: 256 },
      startTime: { type: "integer", minimum: 0 },
      endTime: { type: "integer", minimum: 0 },
    },
  },
} satisfies Record<string, AnySchema>;

export type SchemaName = keyof typeof schemas;

export interface EventFilter {
  type?: string;
  submitter?: string;
  metadata?: string;
  startTime?: number;
  endTime?: number;
}

export interface EventListQuery {
  limit: number;
  offset: number;
  cursor?: string;
  filter?: string;
}

export interface EventTypeQuery {
  limit: number;
  offset: number;
  cursor?: string;
}

export interface EventIndexParams {
  index: number;
}

export interface EventTypeParams {
  type: string;
}

const requestAjv = new Ajv({ allErrors: true, coerceTypes: true, useDefaults: true });
const responseAjv = new Ajv({ allErrors: true });

function compileSchemas(ajv: Ajv): Record<SchemaName, ValidateFunction> {
  return Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [name, ajv.compile(schema)])
  ) as Record<SchemaName, ValidateFunction>;
}

const requestValidators = compileSchemas(requestAjv);
const responseValidators = compileSchemas(responseAjv);

export function getRequestValidator(name: SchemaName): ValidateFunction {
  return requestValidators[name];
}

export function getResponseValidator(name: SchemaName): ValidateFunction {
  return responseValidators[name];
}
