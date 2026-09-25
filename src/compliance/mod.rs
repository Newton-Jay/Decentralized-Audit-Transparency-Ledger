//! Event data lineage and provenance tracking.
//!
//! This module records the origin, transformations, and downstream consumers of
//! contract events so that operators can answer provenance questions, perform
//! impact analysis, and produce compliance reports.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

/// Identifies the system or component that produced an event.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EventOrigin {
    /// Source system that emitted the event (e.g. "contract", "indexer").
    pub source_system: String,
    /// Actor responsible for the event, if known.
    pub actor: Option<String>,
    /// Unix timestamp (seconds) at which the event originated.
    pub timestamp: u64,
    /// Stable identifiers associated with the event (tx hash, ledger seq, ...).
    pub identifiers: BTreeMap<String, String>,
}

impl EventOrigin {
    pub fn new(source_system: impl Into<String>, timestamp: u64) -> Self {
        Self {
            source_system: source_system.into(),
            actor: None,
            timestamp,
            identifiers: BTreeMap::new(),
        }
    }

    pub fn with_actor(mut self, actor: impl Into<String>) -> Self {
        self.actor = Some(actor.into());
        self
    }

    pub fn with_identifier(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.identifiers.insert(key.into(), value.into());
        self
    }
}

/// A single transformation applied to an event as it flows through the pipeline.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Transformation {
    /// Name of the transformation stage (e.g. "normalize", "redact").
    pub name: String,
    /// Component that performed the transformation.
    pub performed_by: String,
    /// Unix timestamp (seconds) at which the transformation ran.
    pub timestamp: u64,
    /// Optional free-form description of what changed.
    pub description: Option<String>,
}

impl Transformation {
    pub fn new(name: impl Into<String>, performed_by: impl Into<String>, timestamp: u64) -> Self {
        Self {
            name: name.into(),
            performed_by: performed_by.into(),
            timestamp,
            description: None,
        }
    }

    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }
}

/// A downstream consumer that observed an event.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Consumer {
    /// Identifier of the consuming system or service.
    pub name: String,
    /// Unix timestamp (seconds) at which the event was consumed.
    pub timestamp: u64,
}

impl Consumer {
    pub fn new(name: impl Into<String>, timestamp: u64) -> Self {
        Self {
            name: name.into(),
            timestamp,
        }
    }
}

/// Full lineage record for a single event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventLineage {
    /// Unique identifier of the event this lineage describes.
    pub event_id: String,
    /// Where the event originated.
    pub origin: EventOrigin,
    /// Ordered transformations applied to the event.
    pub transformations: Vec<Transformation>,
    /// Downstream consumers of the event.
    pub consumers: Vec<Consumer>,
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
    pub fn record_transformation(&mut self, transformation: Transformation) {
        self.transformations.push(transformation);
    }

    /// Record a downstream consumer of the event.
    pub fn record_consumer(&mut self, consumer: Consumer) {
        self.consumers.push(consumer);
    }
}

/// A node in the lineage graph.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum LineageNode {
    /// The origin of an event.
    Origin { event_id: String, source_system: String },
    /// A transformation stage.
    Transformation { event_id: String, name: String },
    /// A downstream consumer.
    Consumer { event_id: String, name: String },
}

/// A directed edge in the lineage graph.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct LineageEdge {
    pub from: LineageNode,
    pub to: LineageNode,
}

/// Graph representation connecting origins, transformations, and consumers.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LineageGraph {
    nodes: BTreeSet<LineageNode>,
    edges: BTreeSet<LineageEdge>,
}

impl LineageGraph {
    pub fn new() -> Self {
        Self::default()
    }

    /// Build a lineage graph from a set of event lineage records.
    pub fn from_lineages(lineages: &[EventLineage]) -> Self {
        let mut graph = Self::new();
        for lineage in lineages {
            graph.add_lineage(lineage);
        }
        graph
    }

    /// Add a single event lineage record to the graph.
    pub fn add_lineage(&mut self, lineage: &EventLineage) {
        let origin = LineageNode::Origin {
            event_id: lineage.event_id.clone(),
            source_system: lineage.origin.source_system.clone(),
        };
        self.nodes.insert(origin.clone());

        let mut previous = origin;
        for transformation in &lineage.transformations {
            let node = LineageNode::Transformation {
                event_id: lineage.event_id.clone(),
                name: transformation.name.clone(),
            };
            self.nodes.insert(node.clone());
            self.edges.insert(LineageEdge {
                from: previous.clone(),
                to: node.clone(),
            });
            previous = node;
        }

        for consumer in &lineage.consumers {
            let node = LineageNode::Consumer {
                event_id: lineage.event_id.clone(),
                name: consumer.name.clone(),
            };
            self.nodes.insert(node.clone());
            self.edges.insert(LineageEdge {
                from: previous.clone(),
                to: node.clone(),
            });
        }
    }

    pub fn nodes(&self) -> impl Iterator<Item = &LineageNode> {
        self.nodes.iter()
    }

    pub fn edges(&self) -> impl Iterator<Item = &LineageEdge> {
        self.edges.iter()
    }

    /// Compute the downstream impact of a node: every node reachable from it.
    pub fn impact_analysis(&self, start: &LineageNode) -> BTreeSet<LineageNode> {
        let mut visited = BTreeSet::new();
        let mut queue = VecDeque::new();
        queue.push_back(start.clone());

        while let Some(current) = queue.pop_front() {
            for edge in self.edges.iter().filter(|e| e.from == current) {
                if visited.insert(edge.to.clone()) {
                    queue.push_back(edge.to.clone());
                }
            }
        }

        visited
    }

    /// Produce a compliance report summarizing lineage coverage.
    pub fn compliance_report(&self, lineages: &[EventLineage]) -> ComplianceReport {
        let mut report = ComplianceReport {
            total_events: lineages.len(),
            ..ComplianceReport::default()
        };

        for lineage in lineages {
            if lineage.origin.actor.is_none() {
                report.events_missing_actor.push(lineage.event_id.clone());
            }
            if lineage.origin.identifiers.is_empty() {
                report.events_missing_identifiers.push(lineage.event_id.clone());
            }
            if lineage.consumers.is_empty() {
                report.events_without_consumers.push(lineage.event_id.clone());
            }
            for consumer in &lineage.consumers {
                report
                    .consumer_counts
                    .entry(consumer.name.clone())
                    .and_modify(|c| *c += 1)
                    .or_insert(1);
            }
        }

        report
    }
}

/// Summary of lineage coverage used for compliance reporting.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ComplianceReport {
    pub total_events: usize,
    pub events_missing_actor: Vec<String>,
    pub events_missing_identifiers: Vec<String>,
    pub events_without_consumers: Vec<String>,
    pub consumer_counts: BTreeMap<String, usize>,
}

impl ComplianceReport {
    /// Whether every tracked event has complete provenance metadata.
    pub fn is_compliant(&self) -> bool {
        self.events_missing_actor.is_empty()
            && self.events_missing_identifiers.is_empty()
            && self.events_without_consumers.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_lineage() -> EventLineage {
        let origin = EventOrigin::new("contract", 1_700_000_000)
            .with_actor("GABC")
            .with_identifier("tx", "deadbeef");
        let mut lineage = EventLineage::new("evt-1", origin);
        lineage.record_transformation(Transformation::new("normalize", "pipeline", 1_700_000_001));
        lineage.record_consumer(Consumer::new("indexer", 1_700_000_002));
        lineage
    }

    #[test]
    fn graph_connects_origin_transformation_and_consumer() {
        let lineage = sample_lineage();
        let graph = LineageGraph::from_lineages(&[lineage]);
        assert_eq!(graph.nodes().count(), 3);
        assert_eq!(graph.edges().count(), 2);
    }

    #[test]
    fn impact_analysis_reaches_consumers() {
        let lineage = sample_lineage();
        let graph = LineageGraph::from_lineages(&[lineage.clone()]);
        let origin = LineageNode::Origin {
            event_id: lineage.event_id.clone(),
            source_system: lineage.origin.source_system.clone(),
        };
        let impacted = graph.impact_analysis(&origin);
        assert_eq!(impacted.len(), 2);
    }

    #[test]
    fn compliance_report_flags_incomplete_lineage() {
        let mut lineage = EventLineage::new("evt-2", EventOrigin::new("contract", 1));
        lineage.record_consumer(Consumer::new("indexer", 2));
        let graph = LineageGraph::from_lineages(&[lineage.clone()]);
        let report = graph.compliance_report(&[lineage]);
        assert!(!report.is_compliant());
        assert_eq!(report.events_missing_actor, vec!["evt-2".to_string()]);
    }
}
