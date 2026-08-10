use std::cmp::Reverse;
use std::collections::BinaryHeap;

use crate::StableId;

use super::{NodeKindTag, PresentationError, Rect, SceneNode, SceneOwner, MAX_VIEWPORT_RESULTS};

#[derive(Clone, Debug, Eq, PartialEq)]
struct SpatialEntry {
    id: StableId,
    parent: Option<StableId>,
    kind: NodeKindTag,
    bounds: Rect,
    paint_order: u32,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct SpatialIndex {
    entries: Vec<SpatialEntry>,
    prefix_max_right: Vec<i64>,
}

impl SpatialIndex {
    pub(crate) fn rebuild<'a>(
        owner: SceneOwner,
        nodes: impl Iterator<Item = &'a SceneNode>,
    ) -> Result<Self, PresentationError> {
        let mut entries = Vec::new();
        for (paint_order, node) in nodes.enumerate() {
            if node.owner != owner {
                return Err(PresentationError::InvalidOwner);
            }
            entries.push(SpatialEntry {
                id: node.id,
                parent: node.parent,
                kind: node.kind.tag(),
                bounds: node.bounds,
                paint_order: u32::try_from(paint_order)
                    .map_err(|_| PresentationError::LimitExceeded("scene paint order"))?,
            });
        }
        entries.sort_unstable_by_key(|entry| (entry.bounds.x.raw(), entry.id));
        let mut prefix_max_right = Vec::with_capacity(entries.len());
        let mut maximum = i64::MIN;
        for entry in &entries {
            maximum = maximum.max(entry.bounds.right()?.raw());
            prefix_max_right.push(maximum);
        }
        Ok(Self {
            entries,
            prefix_max_right,
        })
    }

    pub(crate) fn project(
        &self,
        owner: SceneOwner,
        revision: u64,
        viewport: Rect,
        limit: usize,
        front_to_back: bool,
    ) -> Result<ViewportProjection, PresentationError> {
        if limit == 0 || limit > MAX_VIEWPORT_RESULTS {
            return Err(PresentationError::LimitExceeded("viewport result count"));
        }
        let left = viewport.x.raw();
        let right = viewport.right()?.raw();
        let start = self
            .prefix_max_right
            .partition_point(|maximum| *maximum <= left);
        let end = self
            .entries
            .partition_point(|entry| entry.bounds.x.raw() < right);
        let candidate_indexes = start..end;
        let mut intersection_count = 0usize;
        let mut selected = if front_to_back {
            let mut heap = BinaryHeap::with_capacity(limit.saturating_add(1));
            for index in candidate_indexes {
                let entry = &self.entries[index];
                if !entry.bounds.intersects(viewport) {
                    continue;
                }
                intersection_count = intersection_count.saturating_add(1);
                heap.push(Reverse((entry.paint_order, entry.id, index)));
                if heap.len() > limit {
                    heap.pop();
                }
            }
            heap.into_iter()
                .map(|Reverse((_, _, index))| &self.entries[index])
                .collect::<Vec<_>>()
        } else {
            let mut heap = BinaryHeap::with_capacity(limit.saturating_add(1));
            for index in candidate_indexes {
                let entry = &self.entries[index];
                if !entry.bounds.intersects(viewport) {
                    continue;
                }
                intersection_count = intersection_count.saturating_add(1);
                heap.push((entry.paint_order, entry.id, index));
                if heap.len() > limit {
                    heap.pop();
                }
            }
            heap.into_iter()
                .map(|(_, _, index)| &self.entries[index])
                .collect::<Vec<_>>()
        };
        if front_to_back {
            selected.sort_unstable_by_key(|entry| Reverse((entry.paint_order, entry.id)));
        } else {
            selected.sort_unstable_by_key(|entry| (entry.paint_order, entry.id));
        }
        Ok(ViewportProjection {
            owner,
            revision,
            viewport,
            nodes: selected
                .into_iter()
                .map(|entry| ProjectedSceneNode {
                    id: entry.id,
                    owner,
                    parent: entry.parent,
                    kind: entry.kind,
                    bounds: entry.bounds,
                    paint_order: entry.paint_order,
                })
                .collect(),
            truncated: intersection_count > limit,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectedSceneNode {
    pub id: StableId,
    pub owner: SceneOwner,
    pub parent: Option<StableId>,
    pub kind: NodeKindTag,
    pub bounds: Rect,
    /// Stable scene-graph traversal position. This is presentation order, not an id sort.
    pub paint_order: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ViewportProjection {
    pub owner: SceneOwner,
    pub revision: u64,
    pub viewport: Rect,
    pub nodes: Vec<ProjectedSceneNode>,
    pub truncated: bool,
}
