# Contract Event Streaming Integration Guide

This guide describes how to stream contract events to and from external systems
using Apache Kafka and Apache Pulsar, with exactly-once delivery and schema
registry integration.

## Overview

The event streaming layer is built around two connector roles:

- **Source connectors** publish contract events (emitted by the contract event
  system) to a Kafka topic or Pulsar topic.
- **Sink connectors** consume contract events from a Kafka topic or Pulsar topic
  and forward them to external systems (databases, webhooks, analytics, etc.).

Both roles share the same event envelope and schema handling so that a stream
produced by a source connector can be consumed by any sink connector.

## Event Envelope

Every streamed record carries the contract event payload plus routing metadata:

| Field            | Description                                              |
| ---------------- | -------------------------------------------------------- |
| `event_id`       | Unique identifier of the contract event                  |
| `event_type`     | Contract event type (e.g. `contract.created`)            |
| `contract_id`    | Identifier of the contract the event belongs to          |
| `occurred_at`    | Timestamp when the event occurred                        |
| `schema_id`      | Schema registry subject/version used to encode the body  |
| `payload`        | Serialized contract event body                           |

## Source Connectors

Source connectors bridge the contract event system to a message broker.

### Kafka source

- Topic: configured per deployment (default `contract-events`).
- Key: `contract_id` so that all events for a contract land on the same
  partition and preserve per-contract ordering.
- Value: the event envelope encoded with the schema registry serializer.
- Producer settings for exactly-once:
  - `enable.idempotence=true`
  - `acks=all`
  - `max.in.flight.requests.per.connection=5`
  - `transactional.id` set to a stable connector identity

### Pulsar source

- Topic: configured per deployment (default `persistent://public/default/contract-events`).
- Key: `contract_id` for per-contract ordering.
- Value: the event envelope encoded with the schema registry serializer.
- Producer settings for exactly-once:
  - `producerName` set to a stable connector identity
  - `sendTimeout` configured to fail fast on broker issues
  - deduplication enabled on the topic

## Sink Connectors

Sink connectors consume contract events and forward them to external systems.

- Subscribe to the configured topic using the connector's consumer group.
- Deserialize the envelope using the schema registry deserializer.
- Dispatch the payload to the configured external target.
- Commit offsets only after the external system acknowledges the write, so that
  a failure results in redelivery rather than data loss.

### Exactly-once semantics

Exactly-once delivery is achieved by combining broker-side transactions with
idempotent external writes:

1. The source connector writes events inside a broker transaction.
2. The sink connector reads events and performs the external write.
3. The sink commits the consumer offset in the same transaction as the external
   write (Kafka) or relies on broker deduplication plus idempotent writes
   (Pulsar).
4. On failure, the transaction is aborted and the event is redelivered; the
   idempotent external write makes redelivery safe.

External targets should key writes by `event_id` so that duplicate deliveries
are collapsed.

## Schema Registry Integration

Contract event schemas are managed through a schema registry so that producers
and consumers agree on the wire format.

- Each `event_type` maps to a schema registry subject.
- Source connectors register the schema on first use and embed the resulting
  `schema_id` in the envelope.
- Sink connectors resolve `schema_id` through the registry before deserializing.
- Schema evolution follows the registry's compatibility policy (backward
  compatible by default).

### Supported registries

- Confluent Schema Registry (Kafka)
- Apicurio Registry (Kafka and Pulsar)
- Pulsar built-in schema registry

## Configuration

Connectors are configured through the standard event streaming configuration
surface. A minimal Kafka source configuration looks like:

```yaml
streaming:
  broker: kafka
  role: source
  topic: contract-events
  schema_registry:
    url: http://schema-registry:8081
    compatibility: BACKWARD
  exactly_once: true
```

A minimal Pulsar sink configuration looks like:

```yaml
streaming:
  broker: pulsar
  role: sink
  topic: persistent://public/default/contract-events
  subscription: contract-events-sink
  schema_registry:
    url: http://schema-registry:8081
    compatibility: BACKWARD
  exactly_once: true
```

## Operational Notes

- Monitor consumer lag per connector to detect stalled sinks.
- Alert on schema registry registration failures, which block new event types.
- Use stable `transactional.id` / `producerName` values so that connector
  restarts do not create duplicate producers.
- When changing schemas, roll out consumers before producers to stay within the
  backward compatibility policy.
