use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};

/// A single event in the system.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Event {
    pub id: String,
    pub category: String,
    pub payload: serde_json::Value,
    /// Groups events that belong to the same logical flow/transaction.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    /// The id of the event that directly caused this event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub causation_id: Option<String>,
}

impl Event {
    pub fn new(id: impl Into<String>, category: impl Into<String>, payload: serde_json::Value) -> Self {
        Self {
            id: id.into(),
            category: category.into(),
            payload,
            correlation_id: None,
            causation_id: None,
        }
    }

    /// Attach a correlation id, grouping this event with related events.
    pub fn with_correlation_id(mut self, correlation_id: impl Into<String>) -> Self {
        self.correlation_id = Some(correlation_id.into());
        self
    }

    /// Attach a causation id, recording the event that caused this one.
    pub fn with_causation_id(mut self, causation_id: impl Into<String>) -> Self {
        self.causation_id = Some(causation_id.into());
        self
    }
}

/// In-memory store supporting correlation/causation queries and graph building.
#[derive(Debug, Default, Clone)]
pub struct EventStore {
    events: Vec<Event>,
}

impl EventStore {
    pub fn new() -> Self {
        Self { events: Vec::new() }
    }

    pub fn append(&mut self, event: Event) {
        self.events.push(event);
    }

    pub fn all(&self) -> &[Event] {
        &self.events
    }

    /// Retrieve all events sharing the given correlation id.
    pub fn by_correlation_id(&self, correlation_id: &str) -> Vec<&Event> {
        self.events
            .iter()
            .filter(|e| e.correlation_id.as_deref() == Some(correlation_id))
            .collect()
    }

    /// Retrieve all events directly caused by the given event id.
    pub fn by_causation_id(&self, causation_id: &str) -> Vec<&Event> {
        self.events
            .iter()
            .filter(|e| e.causation_id.as_deref() == Some(causation_id))
            .collect()
    }

    /// Build the correlation/causation graph for a correlation id.
    pub fn correlation_graph(&self, correlation_id: &str) -> CorrelationGraph {
        let members = self.by_correlation_id(correlation_id);
        let ids: HashSet<&str> = members.iter().map(|e| e.id.as_str()).collect();

        let mut nodes: Vec<GraphNode> = members
            .iter()
            .map(|e| GraphNode {
                id: e.id.clone(),
                category: e.category.clone(),
            })
            .collect();
        nodes.sort_by(|a, b| a.id.cmp(&b.id));

        let mut edges: Vec<GraphEdge> = Vec::new();
        for event in &members {
            if let Some(cause) = &event.causation_id {
                // Only link within the same correlation group.
                if ids.contains(cause.as_str()) {
                    edges.push(GraphEdge {
                        from: cause.clone(),
                        to: event.id.clone(),
                    });
                }
            }
        }
        edges.sort_by(|a, b| (&a.from, &a.to).cmp(&(&b.from, &b.to)));

        CorrelationGraph {
            correlation_id: correlation_id.to_string(),
            nodes,
            edges,
        }
    }

    /// Detect anomalies within a correlation group and emit alerts.
    pub fn correlation_alerts(&self, correlation_id: &str) -> Vec<CorrelationAlert> {
        let members = self.by_correlation_id(correlation_id);
        let ids: HashSet<&str> = members.iter().map(|e| e.id.as_str()).collect();
        let mut alerts = Vec::new();

        for event in &members {
            if let Some(cause) = &event.causation_id {
                if !ids.contains(cause.as_str()) {
                    alerts.push(CorrelationAlert {
                        correlation_id: correlation_id.to_string(),
                        event_id: event.id.clone(),
                        kind: AlertKind::DanglingCausation,
                        message: format!(
                            "event '{}' references causation '{}' outside correlation group",
                            event.id, cause
                        ),
                    });
                }
            }
        }

        // Detect cycles in the causation graph.
        if let Some(cycle) = detect_cycle(&members) {
            alerts.push(CorrelationAlert {
                correlation_id: correlation_id.to_string(),
                event_id: cycle.clone(),
                kind: AlertKind::CausationCycle,
                message: format!("causation cycle detected involving event '{}'", cycle),
            });
        }

        alerts
    }
}

/// A node in the correlation graph.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GraphNode {
    pub id: String,
    pub category: String,
}

/// A directed edge from a cause to its effect.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
}

/// A correlation/causation graph suitable for visualization.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CorrelationGraph {
    pub correlation_id: String,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

impl CorrelationGraph {
    /// Render the graph as a Graphviz DOT document.
    pub fn to_dot(&self) -> String {
        let mut out = String::from("digraph correlation {\n");
        for node in &self.nodes {
            out.push_str(&format!(
                "  \"{}\" [label=\"{}\"];\n",
                node.id, node.category
            ));
        }
        for edge in &self.edges {
            out.push_str(&format!("  \"{}\" -> \"{}\";\n", edge.from, edge.to));
        }
        out.push_str("}\n");
        out
    }
}

/// The kind of anomaly detected in a correlation group.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum AlertKind {
    DanglingCausation,
    CausationCycle,
}

/// An alert raised for a correlation group.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CorrelationAlert {
    pub correlation_id: String,
    pub event_id: String,
    pub kind: AlertKind,
    pub message: String,
}

/// Returns the id of an event participating in a causation cycle, if any.
fn detect_cycle(events: &[&Event]) -> Option<String> {
    let mut adjacency: HashMap<&str, Vec<&str>> = HashMap::new();
    for event in events {
        if let Some(cause) = &event.causation_id {
            adjacency.entry(cause.as_str()).or_default().push(event.id.as_str());
        }
    }

    let mut visited: HashSet<&str> = HashSet::new();
    let mut in_stack: HashSet<&str> = HashSet::new();

    for event in events {
        if let Some(cycle) = dfs_cycle(event.id.as_str(), &adjacency, &mut visited, &mut in_stack) {
            return Some(cycle);
        }
    }
    None
}

fn dfs_cycle<'a>(
    node: &'a str,
    adjacency: &HashMap<&'a str, Vec<&'a str>>,
    visited: &mut HashSet<&'a str>,
    in_stack: &mut HashSet<&'a str>,
) -> Option<String> {
    if in_stack.contains(node) {
        return Some(node.to_string());
    }
    if visited.contains(node) {
        return None;
    }
    visited.insert(node);
    in_stack.insert(node);

    if let Some(neighbors) = adjacency.get(node) {
        for next in neighbors {
            if let Some(cycle) = dfs_cycle(next, adjacency, visited, in_stack) {
                return Some(cycle);
            }
        }
    }

    in_stack.remove(node);
    None
}
