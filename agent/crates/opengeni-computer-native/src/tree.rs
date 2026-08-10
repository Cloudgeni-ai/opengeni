use std::collections::{BTreeMap, BTreeSet, VecDeque};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::Value;
use sha2::{Digest as _, Sha256};

use crate::{
    NativeAdapterError, NativeAdapterErrorCode, NativeAdapterResult, NativeLocator,
    NativeNodeMetadata, NativeNodeValue, NativeRect, NativeSemanticNode,
};

const MAX_SEMANTIC_NODES: usize = 10_000;

/// Adapter-private normalized node before opaque refs and a bounded tree are built.
#[derive(Debug, Clone, PartialEq)]
pub struct RawSemanticNode {
    /// Stable native object key retained only inside the helper.
    pub key: String,
    /// Parent object key.
    pub parent_key: Option<String>,
    /// Deterministic sibling order.
    pub index_in_parent: i32,
    /// Normalized role.
    pub role: String,
    /// Platform automation identifier.
    pub identifier: Option<String>,
    /// Accessible name.
    pub name: Option<String>,
    /// Accessible description.
    pub description: Option<String>,
    /// Visible/redacted value.
    pub value: Option<NativeNodeValue>,
    /// Normalized states.
    pub states: Vec<String>,
    /// Logical screen bounds.
    pub bounds: Option<NativeRect>,
    /// Normalized actions.
    pub actions: Vec<String>,
    /// Safe native metadata.
    pub native: Option<NativeNodeMetadata>,
}

/// One full observation plus its private ref→native-object resolution index.
#[derive(Debug, Clone)]
pub struct SemanticSnapshotIndex {
    observation_id: String,
    roots: Vec<NativeSemanticNode>,
    ref_to_key: BTreeMap<String, String>,
    flat: Vec<NativeSemanticNode>,
}

impl SemanticSnapshotIndex {
    /// Builds one bounded, cycle-safe tree rooted at `root_keys`.
    ///
    /// # Errors
    ///
    /// Returns a typed driver failure for duplicate native keys, opaque-ref
    /// collisions, or a tree larger than the protocol envelope.
    pub fn build(
        observation_id: impl Into<String>,
        root_keys: &[String],
        nodes: Vec<RawSemanticNode>,
    ) -> NativeAdapterResult<Self> {
        let observation_id = observation_id.into();
        let mut by_key = BTreeMap::new();
        for node in nodes {
            if by_key.insert(node.key.clone(), node).is_some() {
                return Err(NativeAdapterError::definite(
                    NativeAdapterErrorCode::DriverFailed,
                    "native accessibility snapshot contained a duplicate object",
                    true,
                ));
            }
        }
        let mut children = BTreeMap::<String, Vec<String>>::new();
        for node in by_key.values() {
            if let Some(parent) = &node.parent_key {
                children
                    .entry(parent.clone())
                    .or_default()
                    .push(node.key.clone());
            }
        }
        for siblings in children.values_mut() {
            siblings.sort_by(|left, right| {
                let left_node = &by_key[left];
                let right_node = &by_key[right];
                left_node
                    .index_in_parent
                    .cmp(&right_node.index_in_parent)
                    .then_with(|| left.cmp(right))
            });
        }

        let mut ref_to_key = BTreeMap::new();
        let mut visited = BTreeSet::new();
        let mut roots = Vec::new();
        for key in root_keys {
            if let Some(root) = build_node(
                key,
                &observation_id,
                &by_key,
                &children,
                &mut visited,
                &mut ref_to_key,
            )? {
                roots.push(root);
            }
        }
        if visited.len() > MAX_SEMANTIC_NODES {
            return Err(NativeAdapterError::definite(
                NativeAdapterErrorCode::DriverFailed,
                "native accessibility tree exceeds the semantic node envelope",
                true,
            ));
        }
        let mut flat = Vec::with_capacity(visited.len());
        let mut pending: VecDeque<&NativeSemanticNode> = roots.iter().collect();
        while let Some(node) = pending.pop_front() {
            flat.push(node.clone());
            pending.extend(node.children.iter());
        }
        Ok(Self {
            observation_id,
            roots,
            ref_to_key,
            flat,
        })
    }

    /// Observation id that owns every short ref.
    #[must_use]
    pub fn observation_id(&self) -> &str {
        &self.observation_id
    }

    /// Semantic roots.
    #[must_use]
    pub fn roots(&self) -> &[NativeSemanticNode] {
        &self.roots
    }

    /// Total nodes.
    #[must_use]
    pub fn node_count(&self) -> usize {
        self.flat.len()
    }

    /// Resolves a locator deterministically to one private native object key.
    ///
    /// # Errors
    ///
    /// Returns not-found/ambiguous instead of guessing.
    pub fn resolve(&self, locator: &NativeLocator) -> NativeAdapterResult<&str> {
        if let NativeLocator::Ref { r#ref } = locator {
            return self
                .ref_to_key
                .get(r#ref)
                .map(String::as_str)
                .ok_or_else(|| {
                    NativeAdapterError::definite(
                        NativeAdapterErrorCode::LocatorNotFound,
                        "semantic reference is absent from the expected observation",
                        true,
                    )
                });
        }

        let matches: Vec<&NativeSemanticNode> = self
            .flat
            .iter()
            .filter(|node| locator_matches(locator, node))
            .collect();
        match matches.as_slice() {
            [] => Err(NativeAdapterError::definite(
                NativeAdapterErrorCode::LocatorNotFound,
                "native locator matched no accessible element",
                true,
            )),
            [node] => self
                .ref_to_key
                .get(&node.r#ref)
                .map(String::as_str)
                .ok_or_else(|| {
                    NativeAdapterError::definite(
                        NativeAdapterErrorCode::DriverFailed,
                        "semantic index lost its native object binding",
                        false,
                    )
                }),
            _ => Err(NativeAdapterError::definite(
                NativeAdapterErrorCode::LocatorAmbiguous,
                "native locator matched multiple accessible elements",
                false,
            )),
        }
    }
}

/// Compares semantic content across observations while deliberately ignoring
/// observation-scoped short refs. Every user-visible/native field and child
/// position remains part of the comparison.
pub(crate) fn semantic_roots_equivalent(
    left: &[NativeSemanticNode],
    right: &[NativeSemanticNode],
) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .all(|(left, right)| semantic_node_equivalent(left, right))
}

fn semantic_node_equivalent(left: &NativeSemanticNode, right: &NativeSemanticNode) -> bool {
    left.role == right.role
        && left.identifier == right.identifier
        && left.name == right.name
        && left.description == right.description
        && left.value == right.value
        && left.states == right.states
        && left.bounds == right.bounds
        && left.actions == right.actions
        && left.native == right.native
        && semantic_roots_equivalent(&left.children, &right.children)
}

fn build_node(
    key: &str,
    observation_id: &str,
    by_key: &BTreeMap<String, RawSemanticNode>,
    children: &BTreeMap<String, Vec<String>>,
    visited: &mut BTreeSet<String>,
    ref_to_key: &mut BTreeMap<String, String>,
) -> NativeAdapterResult<Option<NativeSemanticNode>> {
    let Some(raw) = by_key.get(key) else {
        return Ok(None);
    };
    if visited.len() >= MAX_SEMANTIC_NODES {
        return Err(NativeAdapterError::definite(
            NativeAdapterErrorCode::DriverFailed,
            "native accessibility tree exceeds the semantic node envelope",
            true,
        ));
    }
    if !visited.insert(key.to_string()) {
        return Ok(None);
    }
    let node_ref = short_ref(observation_id, key);
    if let Some(existing) = ref_to_key.insert(node_ref.clone(), key.to_string()) {
        if existing != key {
            return Err(NativeAdapterError::definite(
                NativeAdapterErrorCode::DriverFailed,
                "native accessibility reference collision",
                false,
            ));
        }
    }
    let mut child_nodes = Vec::new();
    for child in children.get(key).into_iter().flatten() {
        if let Some(node) =
            build_node(child, observation_id, by_key, children, visited, ref_to_key)?
        {
            child_nodes.push(node);
        }
    }
    Ok(Some(NativeSemanticNode {
        r#ref: node_ref,
        role: bounded(&raw.role, 256),
        identifier: raw.identifier.as_deref().map(|value| bounded(value, 2_048)),
        name: raw.name.as_deref().map(|value| bounded(value, 8_192)),
        description: raw
            .description
            .as_deref()
            .map(|value| bounded(value, 8_192)),
        value: raw.value.clone().map(bound_value),
        states: bounded_unique(&raw.states, 64, 128),
        bounds: raw.bounds,
        actions: bounded_unique(&raw.actions, 64, 128),
        children: child_nodes,
        native: raw.native.clone().map(bound_metadata),
    }))
}

fn short_ref(observation_id: &str, key: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(observation_id.as_bytes());
    digest.update([0]);
    digest.update(key.as_bytes());
    let bytes = digest.finalize();
    format!("e_{}", URL_SAFE_NO_PAD.encode(&bytes[..12]))
}

fn locator_matches(locator: &NativeLocator, node: &NativeSemanticNode) -> bool {
    match locator {
        NativeLocator::Ref { .. } => false,
        NativeLocator::Identifier { value } => node.identifier.as_deref() == Some(value),
        NativeLocator::Role { role, name, exact } => {
            node.role.eq_ignore_ascii_case(role)
                && name.as_ref().is_none_or(|query| {
                    node.name
                        .as_ref()
                        .is_some_and(|value| text_matches(value, query, exact.unwrap_or(false)))
                })
        }
        NativeLocator::Label { text, exact } => node
            .name
            .as_ref()
            .is_some_and(|value| text_matches(value, text, exact.unwrap_or(false))),
        NativeLocator::Text { text, exact } => {
            let exact = exact.unwrap_or(false);
            node.name
                .as_ref()
                .is_some_and(|value| text_matches(value, text, exact))
                || node
                    .description
                    .as_ref()
                    .is_some_and(|value| text_matches(value, text, exact))
                || matches!(&node.value, Some(NativeNodeValue::Text(value)) if text_matches(value, text, exact))
        }
    }
}

fn text_matches(value: &str, query: &str, exact: bool) -> bool {
    if exact {
        value == query
    } else {
        value.to_lowercase().contains(&query.to_lowercase())
    }
}

fn bounded(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn bounded_unique(values: &[String], max_items: usize, max_chars: usize) -> Vec<String> {
    values
        .iter()
        .map(|value| bounded(value, max_chars))
        .filter(|value| !value.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .take(max_items)
        .collect()
}

fn bound_value(value: NativeNodeValue) -> NativeNodeValue {
    match value {
        NativeNodeValue::Text(value) => NativeNodeValue::Text(bounded(&value, 32_768)),
        redacted @ NativeNodeValue::Redacted(_) => redacted,
    }
}

fn bound_metadata(metadata: NativeNodeMetadata) -> NativeNodeMetadata {
    let encoded = serde_json::to_vec(&metadata.data).unwrap_or_default();
    if encoded.len() <= 8_192 {
        return metadata;
    }
    NativeNodeMetadata {
        platform: metadata.platform,
        data: Value::String("native metadata exceeded its byte envelope".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{NativeNodeMetadata, NativeSemanticPlatform};

    fn node(
        key: &str,
        parent: Option<&str>,
        index: i32,
        role: &str,
        name: &str,
    ) -> RawSemanticNode {
        RawSemanticNode {
            key: key.to_string(),
            parent_key: parent.map(str::to_string),
            index_in_parent: index,
            role: role.to_string(),
            identifier: None,
            name: Some(name.to_string()),
            description: None,
            value: None,
            states: vec!["enabled".to_string()],
            bounds: None,
            actions: vec!["invoke".to_string()],
            native: Some(NativeNodeMetadata {
                platform: NativeSemanticPlatform::AtSpi,
                data: serde_json::json!({ "interface": "Action" }),
            }),
        }
    }

    #[test]
    fn builds_deterministic_tree_and_resolves_without_guessing() {
        let snapshot = SemanticSnapshotIndex::build(
            "observation-1",
            &["root".to_string()],
            vec![
                node("second", Some("root"), 2, "button", "Save"),
                node("root", None, 0, "window", "Fixture"),
                node("first", Some("root"), 1, "button", "Cancel"),
            ],
        )
        .expect("snapshot");
        assert_eq!(snapshot.node_count(), 3);
        assert_eq!(
            snapshot.roots()[0].children[0].name.as_deref(),
            Some("Cancel")
        );
        assert_eq!(
            snapshot
                .resolve(&NativeLocator::Label {
                    text: "Save".to_string(),
                    exact: Some(true),
                })
                .expect("unique label"),
            "second"
        );
        let element_ref = snapshot.roots()[0].children[1].r#ref.clone();
        assert_eq!(
            snapshot
                .resolve(&NativeLocator::Ref { r#ref: element_ref })
                .expect("observation ref"),
            "second"
        );
    }

    #[test]
    fn rejects_ambiguous_locators_and_breaks_cycles() {
        let snapshot = SemanticSnapshotIndex::build(
            "observation-1",
            &["root".to_string()],
            vec![
                node("root", Some("loop"), 0, "window", "Fixture"),
                node("loop", Some("root"), 0, "group", "Loop"),
                node("a", Some("root"), 1, "button", "Save"),
                node("b", Some("root"), 2, "button", "Save"),
            ],
        )
        .expect("cycle-safe snapshot");
        let error = snapshot
            .resolve(&NativeLocator::Label {
                text: "Save".to_string(),
                exact: None,
            })
            .expect_err("ambiguous");
        assert_eq!(error.code, NativeAdapterErrorCode::LocatorAmbiguous);
        assert_eq!(snapshot.node_count(), 4);
    }

    #[test]
    fn semantic_equivalence_ignores_only_observation_refs() {
        let first = SemanticSnapshotIndex::build(
            "observation-1",
            &["root".to_string()],
            vec![node("root", None, 0, "button", "Save")],
        )
        .expect("first");
        let second = SemanticSnapshotIndex::build(
            "observation-2",
            &["root".to_string()],
            vec![node("root", None, 0, "button", "Save")],
        )
        .expect("second");
        assert_ne!(first.roots(), second.roots());
        assert!(semantic_roots_equivalent(first.roots(), second.roots()));

        let changed = SemanticSnapshotIndex::build(
            "observation-3",
            &["root".to_string()],
            vec![node("root", None, 0, "button", "Delete")],
        )
        .expect("changed");
        assert!(!semantic_roots_equivalent(first.roots(), changed.roots()));
    }
}
