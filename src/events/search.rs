//! Full-text search over contract event metadata with fuzzy matching.
//!
//! Provides an inverted index over event metadata fields, stemming of both
//! indexed and query terms, ranked retrieval, and highlighted snippets.

use std::collections::{BTreeMap, HashMap, HashSet};

/// Metadata fields that participate in full-text search.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EventField {
    ContractId,
    EventName,
    Topic,
    Data,
}

impl EventField {
    fn all() -> [EventField; 4] {
        [
            EventField::ContractId,
            EventField::EventName,
            EventField::Topic,
            EventField::Data,
        ]
    }
}

/// A single contract event to be indexed and searched.
#[derive(Debug, Clone, Default)]
pub struct EventMetadata {
    pub contract_id: String,
    pub event_name: String,
    pub topic: String,
    pub data: String,
}

impl EventMetadata {
    fn field(&self, field: EventField) -> &str {
        match field {
            EventField::ContractId => &self.contract_id,
            EventField::EventName => &self.event_name,
            EventField::Topic => &self.topic,
            EventField::Data => &self.data,
        }
    }
}

/// A ranked search hit with highlighted snippets.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
    pub event_id: u64,
    pub score: f64,
    pub highlights: Vec<Highlight>,
}

/// A highlighted fragment of a matched field.
#[derive(Debug, Clone, PartialEq)]
pub struct Highlight {
    pub field: EventField,
    pub snippet: String,
}

/// Inverted index over event metadata with stemming and fuzzy matching.
#[derive(Debug, Default)]
pub struct EventSearchIndex {
    /// term -> event_id -> accumulated term frequency
    postings: HashMap<String, HashMap<u64, u32>>,
    /// event_id -> metadata (kept for highlighting)
    documents: HashMap<u64, EventMetadata>,
    /// event_id -> field -> token count (for length normalization)
    lengths: HashMap<u64, usize>,
    /// total number of indexed documents
    doc_count: usize,
}

impl EventSearchIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Index (or re-index) an event's metadata.
    pub fn index(&mut self, event_id: u64, metadata: EventMetadata) {
        if self.documents.contains_key(&event_id) {
            self.remove(event_id);
        }

        let mut token_count = 0usize;
        for field in EventField::all() {
            for token in tokenize(metadata.field(field)) {
                let stem = stem(&token);
                if stem.is_empty() {
                    continue;
                }
                *self
                    .postings
                    .entry(stem)
                    .or_default()
                    .entry(event_id)
                    .or_insert(0) += 1;
                token_count += 1;
            }
        }

        self.lengths.insert(event_id, token_count.max(1));
        self.documents.insert(event_id, metadata);
        self.doc_count += 1;
    }

    /// Remove an event from the index.
    pub fn remove(&mut self, event_id: u64) {
        if self.documents.remove(&event_id).is_none() {
            return;
        }
        self.lengths.remove(&event_id);
        self.doc_count = self.doc_count.saturating_sub(1);
        self.postings.retain(|_, docs| {
            docs.remove(&event_id);
            !docs.is_empty()
        });
    }

    /// Full-text search with fuzzy matching, ranking, and highlighting.
    pub fn search(&self, query: &str) -> Vec<SearchHit> {
        let query_terms: Vec<String> = tokenize(query)
            .into_iter()
            .map(|t| stem(&t))
            .filter(|t| !t.is_empty())
            .collect();

        if query_terms.is_empty() || self.doc_count == 0 {
            return Vec::new();
        }

        let avg_len = self.average_length();
        let mut scores: HashMap<u64, f64> = HashMap::new();

        for term in &query_terms {
            let matched = self.match_terms(term);
            for (matched_term, fuzzy_weight) in matched {
                let Some(docs) = self.postings.get(&matched_term) else {
                    continue;
                };
                let df = docs.len() as f64;
                let idf = ((self.doc_count as f64 + 1.0) / (df + 1.0)).ln() + 1.0;
                for (&event_id, &tf) in docs {
                    let doc_len = *self.lengths.get(&event_id).unwrap_or(&1) as f64;
                    let norm = 1.2 * (1.0 - 0.75 + 0.75 * doc_len / avg_len);
                    let tf_norm = (tf as f64 * 2.2) / (tf as f64 + norm);
                    *scores.entry(event_id).or_insert(0.0) += idf * tf_norm * fuzzy_weight;
                }
            }
        }

        let mut hits: Vec<SearchHit> = scores
            .into_iter()
            .map(|(event_id, score)| SearchHit {
                event_id,
                score,
                highlights: self.highlight(event_id, &query_terms),
            })
            .collect();

        hits.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.event_id.cmp(&b.event_id))
        });
        hits
    }

    /// Resolve a query term to indexed terms, allowing approximate matches.
    fn match_terms(&self, term: &str) -> Vec<(String, f64)> {
        if self.postings.contains_key(term) {
            return vec![(term.to_string(), 1.0)];
        }

        let max_distance = if term.len() <= 4 { 1 } else { 2 };
        let mut matches: Vec<(String, f64)> = self
            .postings
            .keys()
            .filter_map(|candidate| {
                let distance = levenshtein(term, candidate);
                if distance <= max_distance {
                    let weight = 1.0 - (distance as f64 / (max_distance as f64 + 1.0));
                    Some((candidate.clone(), weight))
                } else {
                    None
                }
            })
            .collect();

        matches.sort_by(|a, b| {
            b.1.partial_cmp(&a.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.0.cmp(&b.0))
        });
        matches.truncate(8);
        matches
    }

    fn average_length(&self) -> f64 {
        if self.doc_count == 0 {
            return 1.0;
        }
        let total: usize = self.lengths.values().sum();
        (total as f64 / self.doc_count as f64).max(1.0)
    }

    /// Build highlighted snippets for the fields that matched the query.
    fn highlight(&self, event_id: u64, query_terms: &[String]) -> Vec<Highlight> {
        let Some(metadata) = self.documents.get(&event_id) else {
            return Vec::new();
        };

        let mut highlights = Vec::new();
        for field in EventField::all() {
            let text = metadata.field(field);
            if text.is_empty() {
                continue;
            }
            let mut matched = false;
            let mut snippet = String::new();
            for (i, raw) in text.split_whitespace().enumerate() {
                if i > 0 {
                    snippet.push(' ');
                }
                let stemmed = stem(&raw.to_lowercase());
                let is_match = query_terms.iter().any(|q| {
                    q == &stemmed
                        || levenshtein(q, &stemmed)
                            <= if q.len() <= 4 { 1 } else { 2 }
                });
                if is_match {
                    matched = true;
                    snippet.push('[');
                    snippet.push_str(raw);
                    snippet.push(']');
                } else {
                    snippet.push_str(raw);
                }
            }
            if matched {
                highlights.push(Highlight { field, snippet });
            }
        }
        highlights
    }
}

/// Split text into lowercase alphanumeric tokens.
fn tokenize(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_lowercase())
        .collect()
}

/// Lightweight English stemmer (suffix stripping) applied to indexed and query terms.
fn stem(term: &str) -> String {
    let term = term.to_lowercase();
    if term.len() <= 3 {
        return term;
    }
    for suffix in ["ingly", "edly", "ing", "ies", "ied", "es", "ed", "s"] {
        if let Some(base) = term.strip_suffix(suffix) {
            if base.len() >= 3 {
                return base.to_string();
            }
        }
    }
    term
}

/// Levenshtein edit distance for fuzzy matching.
fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }

    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut curr = vec![0usize; b.len() + 1];

    for (i, ca) in a.iter().enumerate() {
        curr[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = if ca == cb { 0 } else { 1 };
            curr[j + 1] = (prev[j + 1] + 1)
                .min(curr[j] + 1)
                .min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> EventSearchIndex {
        let mut index = EventSearchIndex::new();
        index.index(
            1,
            EventMetadata {
                contract_id: "CABC123".into(),
                event_name: "transfer".into(),
                topic: "token transfer".into(),
                data: "amount 100".into(),
            },
        );
        index.index(
            2,
            EventMetadata {
                contract_id: "CXYZ789".into(),
                event_name: "mint".into(),
                topic: "token minting".into(),
                data: "amount 50".into(),
            },
        );
        index
    }

    #[test]
    fn full_text_search_ranks_matches() {
        let index = sample();
        let hits = index.search("token transfer");
        assert_eq!(hits.first().map(|h| h.event_id), Some(1));
    }

    #[test]
    fn stemming_matches_inflected_terms() {
        let index = sample();
        let hits = index.search("minting");
        assert!(hits.iter().any(|h| h.event_id == 2));
    }

    #[test]
    fn fuzzy_matching_tolerates_typos() {
        let index = sample();
        let hits = index.search("transfir");
        assert!(hits.iter().any(|h| h.event_id == 1));
    }

    #[test]
    fn highlights_matched_fields() {
        let index = sample();
        let hits = index.search("transfer");
        let hit = hits.iter().find(|h| h.event_id == 1).unwrap();
        assert!(hit.highlights.iter().any(|h| h.snippet.contains("[transfer]")));
    }

    #[test]
    fn remove_drops_document() {
        let mut index = sample();
        index.remove(1);
        assert!(index.search("transfer").iter().all(|h| h.event_id != 1));
    }
}
