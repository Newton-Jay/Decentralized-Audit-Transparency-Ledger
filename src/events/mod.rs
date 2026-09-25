//! Event system module.
//!
//! Provides the core event types, the event bus used to publish and subscribe
//! to events, and data lineage / provenance tracking for events as they flow
//! through the pipeline.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};

/// A single event flowing through the system.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    pub id: String,
    pub kind: String,
    pub payload: Vec<u8>,
}

impl Event {
    pub fn new(id: impl Into<String>, kind: impl Into<String>, payload: Vec<u8>) -> Self {
        Self {
            id: id.into(),
            kind: kind.into(),
            payload,
        }
    }
}

/// Identifies the system or component that produced an event.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct EventOrigin {
    /// Source system that emitted the event (e.g. "contract-runtime").
    pub source_system: String,
    /// Actor responsible for the event (user, service, or contract id).
    pub actor: String,
    /// Wall-clock timestamp (millis since epoch) at which the event originated.
    pub timestamp_ms: u64,
    /// Stable identifiers associated with the origin (tx hash, block, etc.).
    pub identifiers: Vec<String>,
}

impl EventOrigin {
    pub fn new(
        source_system: impl Into<String>,
        actor: impl Into<String>,
        timestamp_ms: u64,
    ) -> Self {
        Self {
            source_system: source_system.into(),
            actor: actor.into(),
            timestamp_ms,
            identifiers: Vec::new(),
        }
    }

    pub fn with_identifier(mut self, id: impl Into<String>) -> Self {
        self.identifiers.push(id.into());
        self
    }
}

/// A transformation applied to an event as it flows through the pipeline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventTransformation {
    /// Name of the transformation stage (e.g. "normalize", "redact").
    pub stage: String,
    /// Component that performed the transformation.
    pub processor: String,
    /// Timestamp (millis since epoch) at which the transformation ran.
    pub timestamp_ms: u64,
    /// Optional human-readable description of what changed.
    pub description: String,
}

impl EventTransformation {
    pub fn new(
        stage: impl Into<String>,
        processor: impl Into<String>,
        timestamp_ms: u64,
    ) -> Self {
        Self {
            stage: stage.into(),
            processor: processor.into(),
            timestamp_ms,
            description: String::new(),
        }
    }

    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = description.into();
        self
    }
}

/// A downstream consumer that received an event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventConsumer {
    /// Identifier of the consuming system or component.
    pub consumer: String,
    /// Timestamp (millis since epoch) at which the event was consumed.
    pub timestamp_ms: u64,
}

impl EventConsumer {
    pub fn new(consumer: impl Into<String>, timestamp_ms: u64) -> Self {
        Self {
            consumer: consumer.into(),
            timestamp_ms,
        }
    }
}

/// Full lineage record for a single event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventLineage {
    pub event_id: String,
    pub origin: EventOrigin,
    pub transformations: Vec<EventTransformation>,
    pub consumers: Vec<EventConsumer>,
}

impl EventLineage {
    pub fn new(event_id: impl Into<String>, origin: EventOrigin) -> Self {
        Self {
            event_id: event_id.into(),
            origin,
            transformations: Vec::new(),
            consumers: Vec::new(),
        }
    }

    /// Record a transformation applied to the event.
    pub fn record_transformation(&mut self, transformation: EventTransformation) {
        self.transformations.push(transformation);
    }

    /// Record a downstream consumer of the event.
    pub fn record_consumer(&mut self, consumer: EventConsumer) {
        self.consumers.push(consumer);
    }
}

/// A node in the lineage graph.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum LineageNode {
    /// The origin of an event.
    Origin(String),
    /// A transformation stage applied to an event.
    Transformation(String),
    /// A downstream consumer of an event.
    Consumer(String),
}

/// A directed edge in the lineage graph.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct LineageEdge {
    pub from: LineageNode,
    pub to: LineageNode,
}

/// Graph representation connecting origins, transformations, and consumers.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LineageGraph {
    pub nodes: HashSet<LineageNode>,
    pub edges: HashSet<LineageEdge>,
}

impl LineageGraph {
    pub fn new() -> Self {
        Self::default()
    }

    fn add_edge(&mut self, from: LineageNode, to: LineageNode) {
        self.nodes.insert(from.clone());
        self.nodes.insert(to.clone());
        self.edges.insert(LineageEdge { from, to });
    }

    /// Build a lineage graph from a single event's lineage record.
    pub fn from_lineage(lineage: &EventLineage) -> Self {
        let mut graph = Self::new();
        let origin = LineageNode::Origin(lineage.origin.source_system.clone());
        graph.nodes.insert(origin.clone());

        let mut previous = origin;
        for transformation in &lineage.transformations {
            let node = LineageNode::Transformation(transformation.stage.clone());
            graph.add_edge(previous, node.clone());
            previous = node;
        }
        for consumer in &lineage.consumers {
            let node = LineageNode::Consumer(consumer.consumer.clone());
            graph.add_edge(previous.clone(), node);
        }
        graph
    }

    /// Compute the downstream consumers reachable from a given node.
    pub fn downstream_consumers(&self, from: &LineageNode) -> Vec<String> {
        let mut visited: HashSet<LineageNode> = HashSet::new();
        let mut queue: VecDeque<LineageNode> = VecDeque::new();
        let mut consumers: Vec<String> = Vec::new();
        queue.push_back(from.clone());
        visited.insert(from.clone());

        while let Some(node) = queue.pop_front() {
            if let LineageNode::Consumer(name) = &node {
                if !consumers.contains(name) {
                    consumers.push(name.clone());
                }
            }
            for edge in &self.edges {
                if &edge.from == &node && visited.insert(edge.to.clone()) {
                    queue.push_back(edge.to.clone());
                }
            }
        }
        consumers
    }
}

/// Impact analysis for an event: which consumers are affected by a change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImpactAnalysis {
    pub event_id: String,
    pub affected_consumers: Vec<String>,
    pub transformation_count: usize,
}

impl ImpactAnalysis {
    /// Analyze the impact of an event based on its lineage record.
    pub fn analyze(lineage: &EventLineage) -> Self {
        let graph = LineageGraph::from_lineage(lineage);
        let origin = LineageNode::Origin(lineage.origin.source_system.clone());
        Self {
            event_id: lineage.event_id.clone(),
            affected_consumers: graph.downstream_consumers(&origin),
            transformation_count: lineage.transformations.len(),
        }
    }
}

/// A compliance report summarizing lineage for a set of events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComplianceReport {
    pub total_events: usize,
    pub total_transformations: usize,
    pub total_consumers: usize,
    pub events: Vec<EventLineage>,
}

impl ComplianceReport {
    pub fn from_lineages(lineages: &[EventLineage]) -> Self {
        let total_transformations = lineages.iter().map(|l| l.transformations.len()).sum();
        let total_consumers = lineages.iter().map(|l| l.consumers.len()).sum();
        Self {
            total_events: lineages.len(),
            total_transformations,
            total_consumers,
            events: lineages.to_vec(),
        }
    }
}

/// Tracks lineage and provenance for events flowing through the pipeline.
#[derive(Debug, Default)]
pub struct LineageTracker {
    lineages: HashMap<String, EventLineage>,
}

impl LineageTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register the origin of an event, starting its lineage record.
    pub fn track_origin(&mut self, event_id: impl Into<String>, origin: EventOrigin) {
        let event_id = event_id.into();
        self.lineages
            .entry(event_id.clone())
            .or_insert_with(|| EventLineage::new(event_id, origin));
    }

    /// Record a transformation applied to an event.
    pub fn track_transformation(
        &mut self,
        event_id: &str,
        transformation: EventTransformation,
    ) {
        if let Some(lineage) = self.lineages.get_mut(event_id) {
            lineage.record_transformation(transformation);
        }
    }

    /// Record a downstream consumer of an event.
    pub fn track_consumer(&mut self, event_id: &str, consumer: EventConsumer) {
        if let Some(lineage) = self.lineages.get_mut(event_id) {
            lineage.record_consumer(consumer);
        }
    }

    /// Retrieve the lineage record for an event.
    pub fn lineage(&self, event_id: &str) -> Option<&EventLineage> {
        self.lineages.get(event_id)
    }

    /// Build the lineage graph for an event.
    pub fn graph(&self, event_id: &str) -> Option<LineageGraph> {
        self.lineages.get(event_id).map(LineageGraph::from_lineage)
    }

    /// Perform impact analysis for an event.
    pub fn impact(&self, event_id: &str) -> Option<ImpactAnalysis> {
        self.lineages.get(event_id).map(ImpactAnalysis::analyze)
    }

    /// Produce a compliance report across all tracked events.
    pub fn compliance_report(&self) -> ComplianceReport {
        let lineages: Vec<EventLineage> = self.lineages.values().cloned().collect();
        ComplianceReport::from_lineages(&lineages)
    }
}

/// Shared, thread-safe lineage tracker.
pub type SharedLineageTracker = Arc<Mutex<LineageTracker>>;

/// Create a new shared lineage tracker.
pub fn shared_lineage_tracker() -> SharedLineageTracker {
    Arc::new(Mutex::new(LineageTracker::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracks_origin_transformations_and_consumers() {
        let mut tracker = LineageTracker::new();
        tracker.track_origin(
            "evt-1",
            EventOrigin::new("contract-runtime", "alice", 1_000).with_identifier("tx-abc"),
        );
        tracker.track_transformation(
            "evt-1",
            EventTransformation::new("normalize", "pipeline", 1_010),
        );
        tracker.track_consumer("evt-1", EventConsumer::new("indexer", 1_020));

        let lineage = tracker.lineage("evt-1").expect("lineage exists");
        assert_eq!(lineage.origin.source_system, "contract-runtime");
        assert_eq!(lineage.transformations.len(), 1);
        assert_eq!(lineage.consumers.len(), 1);
    }

    #[test]
    fn builds_lineage_graph_and_impact() {
        let mut tracker = LineageTracker::new();
        tracker.track_origin("evt-2", EventOrigin::new("runtime", "bob", 2_000));
        tracker.track_transformation(
            "evt-2",
            EventTransformation::new("redact", "pipeline", 2_010),
        );
        tracker.track_consumer("evt-2", EventConsumer::new("audit", 2_020));

        let graph = tracker.graph("evt-2").expect("graph exists");
        assert!(graph.nodes.contains(&LineageNode::Origin("runtime".into())));
        assert!(graph
            .nodes
            .contains(&LineageNode::Transformation("redact".into())));

        let impact = tracker.impact("evt-2").expect("impact exists");
        assert_eq!(impact.affected_consumers, vec!["audit".to_string()]);
        assert_eq!(impact.transformation_count, 1);
    }

    #[test]
    fn produces_compliance_report() {
        let mut tracker = LineageTracker::new();
        tracker.track_origin("evt-3", EventOrigin::new("runtime", "carol", 3_000));
        tracker.track_consumer("evt-3", EventConsumer::new("warehouse", 3_010));

        let report = tracker.compliance_report();
        assert_eq!(report.total_events, 1);
        assert_eq!(report.total_consumers, 1);
    }
}
