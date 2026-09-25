import * as path from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

type EventRecord = {
  index: number;
  timestamp: number;
  event_type: string;
  category?: string;
  submitter: string;
  metadata: unknown;
  event_hash: string;
  prev_hash: string;
  version: number;
  parent_event_id?: string | null;
};

type StreamState = {
  active: boolean;
  cursor: number;
  type?: string;
  submitter?: string;
};

type ProtoEvent = {
  index: number;
  timestamp: number;
  eventType: string;
  category: string;
  submitter: string;
  metadata: Buffer;
  eventHash: string;
  prevHash: string;
  version: number;
  parentEventId: string;
};

type GetEventRequest = { index: number };
type StreamEventsRequest = { afterIndex: number; replayAll: boolean; type?: string; submitter?: string };
type SubscribeRequest = { afterIndex: number; replayAll: boolean; type?: string; submitter?: string };
type StreamRequest = {
  subscriptionId?: string;
  subscribe?: SubscribeRequest;
  ack?: { messageId: string };
  unsubscribe?: { subscriptionId: string };
};

const PORT = Number(process.env.GRPC_PORT ?? 50051);
const API_URL = (process.env.LEDGER_API_URL ?? "http://localhost:3002/v1").replace(/\/$/, "");
const POLL_INTERVAL_MS = Number(process.env.GRPC_POLL_INTERVAL_MS ?? 2000);
const PROTO_PATH = path.resolve(__dirname, "../proto/audit_ledger.v1.proto");

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const loaded = grpc.loadPackageDefinition(packageDefinition) as unknown as {
  auditledger: { v1: { AuditLedger: { service: grpc.ServiceClientConstructor } } };
};
const serviceDefinition = loaded.auditledger.v1.AuditLedger.service;

function serviceError(code: grpc.status, message: string): grpc.ServiceError {
  return { code, message, details: message, metadata: new grpc.Metadata() } as grpc.ServiceError;
}

function toProtoEvent(event: EventRecord): ProtoEvent {
  const metadata = typeof event.metadata === "string" ? event.metadata : JSON.stringify(event.metadata ?? "");
  return {
    index: event.index,
    timestamp: event.timestamp,
    eventType: event.event_type,
    category: event.category ?? "general",
    submitter: event.submitter,
    metadata: Buffer.from(metadata, "utf8"),
    eventHash: event.event_hash,
    prevHash: event.prev_hash,
    version: event.version ?? 1,
    parentEventId: event.parent_event_id ?? "",
  };
}

async function fetchEvents(): Promise<EventRecord[]> {
  const response = await fetch(`${API_URL}/events?limit=1000`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`ledger API returned HTTP ${response.status}`);
  const body = (await response.json()) as { data?: EventRecord[] };
  return body.data ?? [];
}

function matches(state: StreamState, event: EventRecord): boolean {
  if (state.type !== undefined && state.type !== "" && event.event_type !== state.type) return false;
  if (state.submitter !== undefined && state.submitter !== "" && !event.submitter.includes(state.submitter)) return false;
  return true;
}

function startPolling(state: StreamState, emit: (event: EventRecord) => void): () => void {
  let polling = false;
  const poll = async (): Promise<void> => {
    if (!state.active || polling) return;
    polling = true;
    try {
      const events = await fetchEvents();
      for (const event of events) {
        if (event.index <= state.cursor) continue;
        state.cursor = event.index;
        if (matches(state, event)) emit(event);
      }
    } finally {
      polling = false;
    }
  };
  const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
  void poll();
  return () => clearInterval(timer);
}

function getEvent(
  call: grpc.ServerUnaryCall<GetEventRequest, ProtoEvent>,
  callback: grpc.sendUnaryData<ProtoEvent>,
): void {
  void fetchEvents()
    .then((events) => {
      const event = events.find((candidate) => candidate.index === call.request.index);
      if (!event) {
        callback(serviceError(grpc.status.NOT_FOUND, `event ${call.request.index} not found`), null);
        return;
      }
      callback(null, toProtoEvent(event));
    })
    .catch((error: unknown) => {
      callback(serviceError(grpc.status.UNAVAILABLE, error instanceof Error ? error.message : "ledger unavailable"), null);
    });
}

function streamEvents(call: grpc.ServerWritableStream<StreamEventsRequest, ProtoEvent>): void {
  const request = call.request;
  const state: StreamState = {
    active: true,
    cursor: request.replayAll ? -1 : request.afterIndex,
    type: request.type,
    submitter: request.submitter,
  };
  const stop = startPolling(state, (event) => call.write(toProtoEvent(event)));
  call.on("cancelled", stop);
  call.on("close", stop);
  call.on("error", stop);
}

function exchangeEvents(call: grpc.ServerDuplexStream<StreamRequest, { event?: ProtoEvent; ack?: { subscriptionId: string; messageId: string; action: string }; error?: { subscriptionId: string; code: string; message: string } }>): void {
  let subscriptionId = "default";
  const state: StreamState = { active: false, cursor: 0 };
  const stop = startPolling(state, (event) => {
    if (state.active) call.write({ event: toProtoEvent(event) });
  });

  call.on("data", (request: StreamRequest) => {
    if (request.subscriptionId) subscriptionId = request.subscriptionId;
    if (request.subscribe) {
      state.active = true;
      state.cursor = request.subscribe.replayAll ? -1 : request.subscribe.afterIndex;
      state.type = request.subscribe.type;
      state.submitter = request.subscribe.submitter;
      call.write({ ack: { subscriptionId, messageId: "", action: "subscribed" } });
      return;
    }
    if (request.ack) {
      call.write({ ack: { subscriptionId, messageId: request.ack.messageId, action: "acknowledged" } });
      return;
    }
    if (request.unsubscribe) {
      state.active = false;
      call.write({ ack: { subscriptionId, messageId: "", action: "unsubscribed" } });
      return;
    }
    call.write({ error: { subscriptionId, code: "UNKNOWN_ACTION", message: "unsupported stream action" } });
  });
  call.on("cancelled", stop);
  call.on("close", stop);
  call.on("error", stop);
}

export function createServer(): grpc.Server {
  const server = new grpc.Server();
  server.addService(serviceDefinition as unknown as grpc.ServiceDefinition, { GetEvent: getEvent, StreamEvents: streamEvents, ExchangeEvents: exchangeEvents });
  return server;
}

if (require.main === module) {
  const server = createServer();
  server.bindAsync(`0.0.0.0:${PORT}`, grpc.ServerCredentials.createInsecure(), (error, boundPort) => {
    if (error) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    console.log(`gRPC API listening on port ${boundPort}`);
  });
}
