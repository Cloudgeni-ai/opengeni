use std::collections::{BTreeMap, BTreeSet};

use crate::{IdError, IdGenerator, StableId};

use super::spatial::{SpatialIndex, ViewportProjection};
use super::{
    Chart, Emu, Layout, Master, NewSceneNode, NodeKind, PresentationBatch, PresentationBatchError,
    PresentationBatchReceipt, PresentationCommand, PresentationError, RichText, Scene, SceneNode,
    SceneOwner, Slide, MAX_CHART_POINTS, MAX_CHART_SERIES, MAX_GROUP_CHILDREN, MAX_GROUP_DEPTH,
    MAX_MEDIA_TYPE_BYTES, MAX_NAME_BYTES, MAX_PRESENTATION_LAYOUTS, MAX_PRESENTATION_MASTERS,
    MAX_PRESENTATION_NODES, MAX_PRESENTATION_ROOTS, MAX_PRESENTATION_SLIDES, MAX_TABLE_CELLS,
    MAX_TABLE_COLUMNS, MAX_TABLE_ROWS, MAX_TEXT_BYTES, MAX_TEXT_PARAGRAPHS, MAX_TEXT_RUNS,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SlideSize {
    pub width: super::Emu,
    pub height: super::Emu,
}

impl SlideSize {
    pub fn new(width: i64, height: i64) -> Result<Self, PresentationError> {
        let rect = super::Rect::new(0, 0, width, height)?;
        Ok(Self {
            width: rect.width,
            height: rect.height,
        })
    }

    /// 13.333 × 7.5 inches, matching the TypeScript 1280 × 720 CSS-pixel default.
    pub fn widescreen() -> Self {
        Self::new(
            1_280 * super::EMU_PER_CSS_PIXEL,
            720 * super::EMU_PER_CSS_PIXEL,
        )
        .expect("fixed default slide size must be valid")
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Presentation {
    pub(crate) id: StableId,
    pub(crate) revision: u64,
    pub(crate) ids: IdGenerator,
    pub(crate) slide_size: SlideSize,
    pub(crate) master_order: Vec<StableId>,
    pub(crate) masters: BTreeMap<StableId, Master>,
    pub(crate) layout_order: Vec<StableId>,
    pub(crate) layouts: BTreeMap<StableId, Layout>,
    pub(crate) slide_order: Vec<StableId>,
    pub(crate) slides: BTreeMap<StableId, Slide>,
    pub(crate) nodes: BTreeMap<StableId, SceneNode>,
    pub(crate) spatial: BTreeMap<SceneOwner, SpatialIndex>,
}

impl Presentation {
    pub fn new(namespace: u64, slide_size: SlideSize) -> Result<Self, PresentationError> {
        let mut ids = IdGenerator::new(namespace);
        let id = ids.next_id().map_err(map_id_error)?;
        Ok(Self {
            id,
            revision: 0,
            ids,
            slide_size,
            master_order: Vec::new(),
            masters: BTreeMap::new(),
            layout_order: Vec::new(),
            layouts: BTreeMap::new(),
            slide_order: Vec::new(),
            slides: BTreeMap::new(),
            nodes: BTreeMap::new(),
            spatial: BTreeMap::new(),
        })
    }

    #[must_use]
    pub const fn id(&self) -> StableId {
        self.id
    }

    #[must_use]
    pub const fn revision(&self) -> u64 {
        self.revision
    }

    #[must_use]
    pub const fn slide_size(&self) -> SlideSize {
        self.slide_size
    }

    pub fn allocate_id(&mut self) -> Result<StableId, PresentationError> {
        self.ids.next_id().map_err(map_id_error)
    }

    #[must_use]
    pub fn master(&self, id: StableId) -> Option<&Master> {
        self.masters.get(&id)
    }

    #[must_use]
    pub fn layout(&self, id: StableId) -> Option<&Layout> {
        self.layouts.get(&id)
    }

    #[must_use]
    pub fn slide(&self, id: StableId) -> Option<&Slide> {
        self.slides.get(&id)
    }

    #[must_use]
    pub fn node(&self, id: StableId) -> Option<&SceneNode> {
        self.nodes.get(&id)
    }

    /// Returns the canonical zero-based sibling order retained by the source
    /// scene graph. Resolved projections use this with `SceneNode::parent` to
    /// reconstruct hierarchy without decoding a snapshot outside the kernel.
    pub fn node_sibling_order(&self, id: StableId) -> Result<usize, PresentationError> {
        let node = self
            .nodes
            .get(&id)
            .ok_or(PresentationError::UnknownNode(id))?;
        self.position_in_parent(node.owner, node.parent, id)
    }

    pub fn masters(&self) -> impl Iterator<Item = &Master> {
        self.master_order
            .iter()
            .filter_map(|id| self.masters.get(id))
    }

    pub fn layouts(&self) -> impl Iterator<Item = &Layout> {
        self.layout_order
            .iter()
            .filter_map(|id| self.layouts.get(id))
    }

    pub fn slides(&self) -> impl Iterator<Item = &Slide> {
        self.slide_order.iter().filter_map(|id| self.slides.get(id))
    }

    pub fn viewport_projection(
        &self,
        owner: SceneOwner,
        viewport: super::Rect,
        limit: usize,
    ) -> Result<ViewportProjection, PresentationError> {
        if limit == 0 || limit > super::MAX_VIEWPORT_RESULTS {
            return Err(PresentationError::LimitExceeded("viewport result count"));
        }
        self.scene(owner)?;
        let empty = SpatialIndex::default();
        let index = self.spatial.get(&owner).unwrap_or(&empty);
        index.project(owner, self.revision, viewport, limit, false)
    }

    /// Resolves master → layout → slide scene inheritance without flattening
    /// the authoritative graphs. A local placeholder replaces the inherited
    /// placeholder with the same `(kind, index)`; every other node retains its
    /// layer and stable identity.
    pub fn resolved_slide_scene(
        &self,
        slide_id: StableId,
    ) -> Result<ResolvedSlideScene, PresentationError> {
        let slide = self
            .slides
            .get(&slide_id)
            .ok_or(PresentationError::UnknownSlide(slide_id))?;
        let mut layers = Vec::with_capacity(3);
        if let Some(layout_id) = slide.layout_id {
            let layout = self
                .layouts
                .get(&layout_id)
                .ok_or(PresentationError::UnknownLayout(layout_id))?;
            if let Some(master_id) = layout.master_id {
                layers.push(SceneOwner::Master(master_id));
            }
            layers.push(SceneOwner::Layout(layout_id));
        }
        layers.push(SceneOwner::Slide(slide_id));

        let mut layer_nodes = Vec::with_capacity(layers.len());
        for owner in layers {
            layer_nodes.push((owner, self.scene_paint_order(owner)?));
        }
        let mut placeholder_winners = BTreeMap::new();
        for (_, node_ids) in &layer_nodes {
            for node_id in node_ids {
                let node = self
                    .nodes
                    .get(node_id)
                    .ok_or(PresentationError::UnknownNode(*node_id))?;
                if let NodeKind::Shape(shape) = &node.kind {
                    if let Some(placeholder) = &shape.placeholder {
                        placeholder_winners
                            .insert((placeholder.kind.clone(), placeholder.index), *node_id);
                    }
                }
            }
        }

        let mut nodes = Vec::new();
        for (owner, node_ids) in layer_nodes {
            for node_id in node_ids {
                let node = self
                    .nodes
                    .get(&node_id)
                    .ok_or(PresentationError::UnknownNode(node_id))?;
                let placeholder_key = match &node.kind {
                    NodeKind::Shape(shape) => shape
                        .placeholder
                        .as_ref()
                        .map(|value| (value.kind.clone(), value.index)),
                    _ => None,
                };
                if placeholder_key
                    .as_ref()
                    .is_some_and(|key| placeholder_winners.get(key).copied() != Some(node_id))
                {
                    continue;
                }
                nodes.push(ResolvedSceneNode {
                    id: node_id,
                    source: owner,
                    inherited: owner != SceneOwner::Slide(slide_id),
                });
            }
        }
        Ok(ResolvedSlideScene { slide_id, nodes })
    }

    /// Returns intersecting nodes from front to back for deterministic hit testing.
    pub fn hit_test(
        &self,
        owner: SceneOwner,
        x: super::Emu,
        y: super::Emu,
        limit: usize,
    ) -> Result<Vec<super::ProjectedSceneNode>, PresentationError> {
        Ok(self.hit_test_projection(owner, x, y, limit)?.nodes)
    }

    /// Returns a bounded front-to-back hit-test projection, including whether
    /// additional intersecting nodes were omitted by the caller's limit.
    pub fn hit_test_projection(
        &self,
        owner: SceneOwner,
        x: super::Emu,
        y: super::Emu,
        limit: usize,
    ) -> Result<ViewportProjection, PresentationError> {
        self.scene(owner)?;
        let viewport = super::Rect::new(x.raw(), y.raw(), 1, 1)?;
        let empty = SpatialIndex::default();
        let index = self.spatial.get(&owner).unwrap_or(&empty);
        index.project(owner, self.revision, viewport, limit, true)
    }

    /// Applies an ordered pure-modality command batch atomically. This method
    /// neither accepts nor creates artifact, actor, transaction, or causal ids.
    pub fn apply_batch(
        &mut self,
        batch: &PresentationBatch,
    ) -> Result<PresentationBatchReceipt, PresentationBatchError> {
        self.begin_batch(batch)
            .map(PresentationBatchTransaction::commit)
    }

    /// Applies a batch behind an automatic rollback guard. Callers may encode
    /// and size-check the exact post-edit snapshot, then commit; dropping the
    /// guard restores ids, revision, scene order/content, and spatial indexes.
    pub fn begin_batch<'a>(
        &'a mut self,
        batch: &PresentationBatch,
    ) -> Result<PresentationBatchTransaction<'a>, PresentationBatchError> {
        let next_revision = if batch.is_empty() {
            self.revision
        } else {
            self.revision.checked_add(1).ok_or(PresentationBatchError {
                command_index: 0,
                kind: PresentationError::RevisionExhausted,
            })?
        };
        let previous_revision = self.revision;
        let previous_ids = self.ids.clone();
        let mut undo = Vec::with_capacity(batch.commands().len());
        let mut affected_owners = BTreeSet::new();
        for (command_index, command) in batch.commands().iter().enumerate() {
            match self.apply_one(command, &mut affected_owners) {
                Ok(entry) => undo.push(entry),
                Err(kind) => {
                    for entry in undo.into_iter().rev() {
                        self.rollback(entry);
                    }
                    self.ids = previous_ids;
                    return Err(PresentationBatchError {
                        command_index,
                        kind,
                    });
                }
            }
        }
        let mut rebuilt = Vec::with_capacity(affected_owners.len());
        for owner in affected_owners {
            let index = match self.rebuild_spatial_index(owner) {
                Ok(index) => index,
                Err(kind) => {
                    for entry in undo.into_iter().rev() {
                        self.rollback(entry);
                    }
                    self.ids = previous_ids;
                    return Err(PresentationBatchError {
                        command_index: batch.commands().len() - 1,
                        kind,
                    });
                }
            };
            rebuilt.push((owner, index));
        }
        let mut previous_spatial = Vec::with_capacity(rebuilt.len());
        for (owner, index) in rebuilt {
            previous_spatial.push((owner, self.spatial.get(&owner).cloned()));
            if index == SpatialIndex::default() {
                self.spatial.remove(&owner);
            } else {
                self.spatial.insert(owner, index);
            }
        }
        self.revision = next_revision;
        Ok(PresentationBatchTransaction {
            presentation: self,
            receipt: PresentationBatchReceipt {
                revision: next_revision,
                command_count: batch.commands().len(),
            },
            undo: Some(undo),
            previous_ids,
            previous_revision,
            previous_spatial,
        })
    }

    fn apply_one(
        &mut self,
        command: &PresentationCommand,
        affected: &mut BTreeSet<SceneOwner>,
    ) -> Result<Undo, PresentationError> {
        match command {
            PresentationCommand::SetPresentationSize { size } => {
                let size = SlideSize::new(size.width.raw(), size.height.raw())?;
                let previous = core::mem::replace(&mut self.slide_size, size);
                Ok(Undo::SetPresentationSize { previous })
            }
            PresentationCommand::CreateMaster {
                id,
                name,
                background,
            } => {
                self.validate_new_catalog_id(*id)?;
                validate_name(name)?;
                if self.masters.len() == MAX_PRESENTATION_MASTERS {
                    return Err(PresentationError::LimitExceeded("masters"));
                }
                self.ids.observe(*id).map_err(map_id_error)?;
                self.master_order.push(*id);
                self.masters.insert(
                    *id,
                    Master {
                        id: *id,
                        name: name.clone(),
                        background: *background,
                        scene: Scene::new(),
                    },
                );
                Ok(Undo::DeleteMaster(*id))
            }
            PresentationCommand::CreateLayout {
                id,
                name,
                master_id,
                background,
            } => {
                self.validate_new_catalog_id(*id)?;
                validate_name(name)?;
                if self.layouts.len() == MAX_PRESENTATION_LAYOUTS {
                    return Err(PresentationError::LimitExceeded("layouts"));
                }
                if let Some(master_id) = master_id {
                    if !self.masters.contains_key(master_id) {
                        return Err(PresentationError::UnknownMaster(*master_id));
                    }
                }
                self.ids.observe(*id).map_err(map_id_error)?;
                self.layout_order.push(*id);
                self.layouts.insert(
                    *id,
                    Layout {
                        id: *id,
                        name: name.clone(),
                        master_id: *master_id,
                        background: *background,
                        scene: Scene::new(),
                    },
                );
                Ok(Undo::DeleteLayout(*id))
            }
            PresentationCommand::CreateSlide {
                id,
                index,
                title,
                layout_id,
                background,
            } => {
                self.validate_new_catalog_id(*id)?;
                validate_name_or_empty(title)?;
                if self.slides.len() == MAX_PRESENTATION_SLIDES {
                    return Err(PresentationError::LimitExceeded("slides"));
                }
                if *index > self.slide_order.len() {
                    return Err(PresentationError::InvalidOrderIndex);
                }
                if let Some(layout_id) = layout_id {
                    if !self.layouts.contains_key(layout_id) {
                        return Err(PresentationError::UnknownLayout(*layout_id));
                    }
                }
                self.ids.observe(*id).map_err(map_id_error)?;
                self.slide_order.insert(*index, *id);
                self.slides.insert(
                    *id,
                    Slide {
                        id: *id,
                        title: title.clone(),
                        layout_id: *layout_id,
                        background: *background,
                        notes: RichText::plain(""),
                        scene: Scene::new(),
                    },
                );
                Ok(Undo::DeleteSlide(*id))
            }
            PresentationCommand::DeleteMaster { id } => {
                let master = self
                    .masters
                    .get(id)
                    .ok_or(PresentationError::UnknownMaster(*id))?;
                if !master.scene.roots.is_empty() {
                    return Err(PresentationError::NonEmptyScene);
                }
                if self
                    .layouts
                    .values()
                    .any(|layout| layout.master_id == Some(*id))
                {
                    return Err(PresentationError::ReferencedObject);
                }
                let index = order_index(&self.master_order, *id)?;
                let master = self.masters.remove(id).expect("validated master exists");
                self.master_order.remove(index);
                Ok(Undo::RestoreMaster { index, master })
            }
            PresentationCommand::DeleteLayout { id } => {
                let layout = self
                    .layouts
                    .get(id)
                    .ok_or(PresentationError::UnknownLayout(*id))?;
                if !layout.scene.roots.is_empty() {
                    return Err(PresentationError::NonEmptyScene);
                }
                if self
                    .slides
                    .values()
                    .any(|slide| slide.layout_id == Some(*id))
                {
                    return Err(PresentationError::ReferencedObject);
                }
                let index = order_index(&self.layout_order, *id)?;
                let layout = self.layouts.remove(id).expect("validated layout exists");
                self.layout_order.remove(index);
                Ok(Undo::RestoreLayout { index, layout })
            }
            PresentationCommand::DeleteSlide { id } => {
                let slide = self
                    .slides
                    .get(id)
                    .ok_or(PresentationError::UnknownSlide(*id))?;
                if !slide.scene.roots.is_empty() {
                    return Err(PresentationError::NonEmptyScene);
                }
                let index = order_index(&self.slide_order, *id)?;
                let slide = self.slides.remove(id).expect("validated slide exists");
                self.slide_order.remove(index);
                self.spatial.remove(&SceneOwner::Slide(*id));
                Ok(Undo::RestoreSlide { index, slide })
            }
            PresentationCommand::SetSlideTitle { id, title } => {
                validate_name_or_empty(title)?;
                let slide = self
                    .slides
                    .get_mut(id)
                    .ok_or(PresentationError::UnknownSlide(*id))?;
                let previous = core::mem::replace(&mut slide.title, title.clone());
                Ok(Undo::SetSlideTitle { id: *id, previous })
            }
            PresentationCommand::SetSlideLayout { id, layout_id } => {
                if let Some(layout_id) = layout_id {
                    if !self.layouts.contains_key(layout_id) {
                        return Err(PresentationError::UnknownLayout(*layout_id));
                    }
                }
                let slide = self
                    .slides
                    .get_mut(id)
                    .ok_or(PresentationError::UnknownSlide(*id))?;
                let previous = core::mem::replace(&mut slide.layout_id, *layout_id);
                Ok(Undo::SetSlideLayout { id: *id, previous })
            }
            PresentationCommand::SetSlideNotes { id, notes } => {
                validate_rich_text(notes)?;
                let slide = self
                    .slides
                    .get_mut(id)
                    .ok_or(PresentationError::UnknownSlide(*id))?;
                let previous = core::mem::replace(&mut slide.notes, notes.clone());
                Ok(Undo::SetSlideNotes { id: *id, previous })
            }
            PresentationCommand::InsertNode {
                owner,
                parent,
                index,
                node,
            } => {
                self.scene(*owner)?;
                self.validate_new_catalog_id(node.id)?;
                if self.nodes.len() == MAX_PRESENTATION_NODES {
                    return Err(PresentationError::LimitExceeded("scene nodes"));
                }
                validate_node(node, true)?;
                self.validate_node_references(*owner, node.id, &node.kind)?;
                self.validate_destination(*owner, *parent, *index, None)?;
                if let Some(parent_id) = parent {
                    if self.node_depth(*parent_id)?.saturating_add(1) > MAX_GROUP_DEPTH {
                        return Err(PresentationError::LimitExceeded("group depth"));
                    }
                }
                self.ids.observe(node.id).map_err(map_id_error)?;
                let scene_node = SceneNode {
                    id: node.id,
                    owner: *owner,
                    parent: *parent,
                    name: node.name.clone(),
                    bounds: node.bounds,
                    transform: node.transform,
                    kind: node.kind.clone(),
                };
                self.nodes.insert(node.id, scene_node);
                self.insert_into_parent(*owner, *parent, *index, node.id);
                affected.insert(*owner);
                Ok(Undo::DeleteNode(node.id))
            }
            PresentationCommand::DeleteNode { id } => {
                let node = self
                    .nodes
                    .get(id)
                    .ok_or(PresentationError::UnknownNode(*id))?;
                if matches!(&node.kind, NodeKind::Group(group) if !group.children.is_empty()) {
                    return Err(PresentationError::NonEmptyScene);
                }
                if self.nodes.values().any(|candidate| {
                    matches!(&candidate.kind, NodeKind::Connector(connector)
                        if connector.start.node_id == Some(*id) || connector.end.node_id == Some(*id))
                }) {
                    return Err(PresentationError::ReferencedObject);
                }
                let owner = node.owner;
                let parent = node.parent;
                let index = self.position_in_parent(owner, parent, *id)?;
                self.remove_from_parent(owner, parent, index);
                let node = self.nodes.remove(id).expect("validated node exists");
                affected.insert(owner);
                Ok(Undo::RestoreNode { index, node })
            }
            PresentationCommand::MoveNode {
                id,
                new_parent,
                index,
            } => {
                let node = self
                    .nodes
                    .get(id)
                    .ok_or(PresentationError::UnknownNode(*id))?;
                let owner = node.owner;
                let old_parent = node.parent;
                let old_index = self.position_in_parent(owner, old_parent, *id)?;
                self.validate_destination(owner, *new_parent, *index, Some(*id))?;
                if let Some(parent) = new_parent {
                    if *parent == *id || self.is_descendant(*id, *parent)? {
                        return Err(PresentationError::ParentCycle);
                    }
                    let parent_depth = self.node_depth(*parent)?;
                    let subtree_depth = self.subtree_depth(*id)?;
                    if parent_depth.saturating_add(subtree_depth) > MAX_GROUP_DEPTH {
                        return Err(PresentationError::LimitExceeded("group depth"));
                    }
                }
                self.remove_from_parent(owner, old_parent, old_index);
                self.insert_into_parent(owner, *new_parent, *index, *id);
                self.nodes
                    .get_mut(id)
                    .expect("validated node exists")
                    .parent = *new_parent;
                affected.insert(owner);
                Ok(Undo::MoveNode {
                    id: *id,
                    parent: old_parent,
                    index: old_index,
                })
            }
            PresentationCommand::SetNodeBounds { id, bounds } => {
                bounds.right()?;
                bounds.bottom()?;
                let node = self
                    .nodes
                    .get_mut(id)
                    .ok_or(PresentationError::UnknownNode(*id))?;
                let owner = node.owner;
                let previous = core::mem::replace(&mut node.bounds, *bounds);
                affected.insert(owner);
                Ok(Undo::SetNodeBounds { id: *id, previous })
            }
            PresentationCommand::SetNodeTransform { id, transform } => {
                transform.validate()?;
                let node = self
                    .nodes
                    .get_mut(id)
                    .ok_or(PresentationError::UnknownNode(*id))?;
                let previous = core::mem::replace(&mut node.transform, *transform);
                Ok(Undo::SetNodeTransform { id: *id, previous })
            }
            PresentationCommand::SetNodeContent { id, kind } => {
                validate_node_kind(kind, false)?;
                let owner = self
                    .nodes
                    .get(id)
                    .ok_or(PresentationError::UnknownNode(*id))?
                    .owner;
                self.validate_node_references(owner, *id, kind)?;
                let node = self
                    .nodes
                    .get_mut(id)
                    .ok_or(PresentationError::UnknownNode(*id))?;
                if node.kind.tag() != kind.tag() {
                    return Err(PresentationError::Unsupported(
                        "changing a scene node's kind",
                    ));
                }
                if let (NodeKind::Group(previous), NodeKind::Group(next)) = (&node.kind, kind) {
                    if previous.children != next.children {
                        return Err(PresentationError::InvalidParent);
                    }
                }
                let previous = core::mem::replace(&mut node.kind, kind.clone());
                Ok(Undo::SetNodeContent { id: *id, previous })
            }
            PresentationCommand::Unsupported { feature } => {
                Err(PresentationError::Unsupported(feature))
            }
        }
    }

    fn rollback(&mut self, undo: Undo) {
        match undo {
            Undo::SetPresentationSize { previous } => self.slide_size = previous,
            Undo::DeleteMaster(id) => {
                self.masters.remove(&id);
                remove_id(&mut self.master_order, id);
            }
            Undo::DeleteLayout(id) => {
                self.layouts.remove(&id);
                remove_id(&mut self.layout_order, id);
            }
            Undo::DeleteSlide(id) => {
                self.slides.remove(&id);
                remove_id(&mut self.slide_order, id);
            }
            Undo::RestoreMaster { index, master } => {
                self.master_order.insert(index, master.id);
                self.masters.insert(master.id, master);
            }
            Undo::RestoreLayout { index, layout } => {
                self.layout_order.insert(index, layout.id);
                self.layouts.insert(layout.id, layout);
            }
            Undo::RestoreSlide { index, slide } => {
                self.slide_order.insert(index, slide.id);
                self.slides.insert(slide.id, slide);
            }
            Undo::SetSlideTitle { id, previous } => {
                self.slides.get_mut(&id).unwrap().title = previous
            }
            Undo::SetSlideLayout { id, previous } => {
                self.slides.get_mut(&id).unwrap().layout_id = previous
            }
            Undo::SetSlideNotes { id, previous } => {
                self.slides.get_mut(&id).unwrap().notes = previous
            }
            Undo::DeleteNode(id) => {
                if let Some(node) = self.nodes.remove(&id) {
                    let index = self
                        .position_in_parent(node.owner, node.parent, id)
                        .unwrap();
                    self.remove_from_parent(node.owner, node.parent, index);
                }
            }
            Undo::RestoreNode { index, node } => {
                self.insert_into_parent(node.owner, node.parent, index, node.id);
                self.nodes.insert(node.id, node);
            }
            Undo::MoveNode { id, parent, index } => {
                let node = self.nodes.get(&id).unwrap();
                let owner = node.owner;
                let current_parent = node.parent;
                let current_index = self.position_in_parent(owner, current_parent, id).unwrap();
                self.remove_from_parent(owner, current_parent, current_index);
                self.insert_into_parent(owner, parent, index, id);
                self.nodes.get_mut(&id).unwrap().parent = parent;
            }
            Undo::SetNodeBounds { id, previous } => {
                self.nodes.get_mut(&id).unwrap().bounds = previous
            }
            Undo::SetNodeTransform { id, previous } => {
                self.nodes.get_mut(&id).unwrap().transform = previous
            }
            Undo::SetNodeContent { id, previous } => {
                self.nodes.get_mut(&id).unwrap().kind = previous
            }
        }
    }

    fn validate_new_catalog_id(&self, id: StableId) -> Result<(), PresentationError> {
        if id.is_zero() || id.namespace() == 0 || id.counter() == 0 {
            return Err(PresentationError::InvalidId);
        }
        if id == self.id
            || self.masters.contains_key(&id)
            || self.layouts.contains_key(&id)
            || self.slides.contains_key(&id)
            || self.nodes.contains_key(&id)
        {
            return Err(PresentationError::DuplicateId(id));
        }
        Ok(())
    }

    fn scene(&self, owner: SceneOwner) -> Result<&Scene, PresentationError> {
        match owner {
            SceneOwner::Master(id) => self
                .masters
                .get(&id)
                .map(|master| &master.scene)
                .ok_or(PresentationError::UnknownMaster(id)),
            SceneOwner::Layout(id) => self
                .layouts
                .get(&id)
                .map(|layout| &layout.scene)
                .ok_or(PresentationError::UnknownLayout(id)),
            SceneOwner::Slide(id) => self
                .slides
                .get(&id)
                .map(|slide| &slide.scene)
                .ok_or(PresentationError::UnknownSlide(id)),
        }
    }

    fn scene_mut(&mut self, owner: SceneOwner) -> &mut Scene {
        match owner {
            SceneOwner::Master(id) => &mut self.masters.get_mut(&id).unwrap().scene,
            SceneOwner::Layout(id) => &mut self.layouts.get_mut(&id).unwrap().scene,
            SceneOwner::Slide(id) => &mut self.slides.get_mut(&id).unwrap().scene,
        }
    }

    fn scene_paint_order(&self, owner: SceneOwner) -> Result<Vec<StableId>, PresentationError> {
        let mut output = Vec::new();
        let mut stack = self
            .scene(owner)?
            .roots
            .iter()
            .rev()
            .copied()
            .collect::<Vec<_>>();
        let mut visited = BTreeSet::new();
        while let Some(id) = stack.pop() {
            if !visited.insert(id) {
                return Err(PresentationError::ParentCycle);
            }
            let node = self
                .nodes
                .get(&id)
                .ok_or(PresentationError::UnknownNode(id))?;
            if node.owner != owner {
                return Err(PresentationError::InvalidOwner);
            }
            output.push(id);
            if let NodeKind::Group(group) = &node.kind {
                stack.extend(group.children.iter().rev().copied());
            }
        }
        Ok(output)
    }

    fn rebuild_spatial_index(&self, owner: SceneOwner) -> Result<SpatialIndex, PresentationError> {
        let paint_order = self.scene_paint_order(owner)?;
        SpatialIndex::rebuild(
            owner,
            paint_order.iter().map(|id| {
                self.nodes
                    .get(id)
                    .expect("validated paint-order node exists")
            }),
        )
    }

    fn validate_node_references(
        &self,
        owner: SceneOwner,
        node_id: StableId,
        kind: &NodeKind,
    ) -> Result<(), PresentationError> {
        let NodeKind::Connector(connector) = kind else {
            return Ok(());
        };
        for endpoint in [connector.start, connector.end] {
            if let Some(target_id) = endpoint.node_id {
                if target_id == node_id {
                    return Err(PresentationError::InvalidParent);
                }
                let target = self
                    .nodes
                    .get(&target_id)
                    .ok_or(PresentationError::UnknownNode(target_id))?;
                if target.owner != owner {
                    return Err(PresentationError::InvalidOwner);
                }
            }
        }
        Ok(())
    }

    fn validate_destination(
        &self,
        owner: SceneOwner,
        parent: Option<StableId>,
        index: usize,
        moving: Option<StableId>,
    ) -> Result<(), PresentationError> {
        let (len, same_container) = if let Some(parent_id) = parent {
            let parent_node = self
                .nodes
                .get(&parent_id)
                .ok_or(PresentationError::InvalidParent)?;
            if parent_node.owner != owner {
                return Err(PresentationError::InvalidOwner);
            }
            let NodeKind::Group(group) = &parent_node.kind else {
                return Err(PresentationError::InvalidParent);
            };
            if group.children.len() == MAX_GROUP_CHILDREN
                && !group.children.contains(&moving.unwrap_or(StableId::ZERO))
            {
                return Err(PresentationError::LimitExceeded("group children"));
            }
            (
                group.children.len(),
                moving.is_some_and(|id| group.children.contains(&id)),
            )
        } else {
            let roots = self.scene(owner)?.roots();
            if roots.len() == MAX_PRESENTATION_ROOTS
                && !roots.contains(&moving.unwrap_or(StableId::ZERO))
            {
                return Err(PresentationError::LimitExceeded("scene roots"));
            }
            (roots.len(), moving.is_some_and(|id| roots.contains(&id)))
        };
        let final_len = len.saturating_sub(usize::from(same_container));
        if index > final_len {
            return Err(PresentationError::InvalidOrderIndex);
        }
        Ok(())
    }

    fn position_in_parent(
        &self,
        owner: SceneOwner,
        parent: Option<StableId>,
        id: StableId,
    ) -> Result<usize, PresentationError> {
        let values = if let Some(parent) = parent {
            let node = self
                .nodes
                .get(&parent)
                .ok_or(PresentationError::InvalidParent)?;
            let NodeKind::Group(group) = &node.kind else {
                return Err(PresentationError::InvalidParent);
            };
            group.children.as_slice()
        } else {
            self.scene(owner)?.roots()
        };
        values
            .iter()
            .position(|candidate| *candidate == id)
            .ok_or(PresentationError::InvalidParent)
    }

    fn remove_from_parent(&mut self, owner: SceneOwner, parent: Option<StableId>, index: usize) {
        if let Some(parent) = parent {
            let NodeKind::Group(group) = &mut self.nodes.get_mut(&parent).unwrap().kind else {
                unreachable!("validated parent is a group")
            };
            group.children.remove(index);
        } else {
            self.scene_mut(owner).roots.remove(index);
        }
    }

    fn insert_into_parent(
        &mut self,
        owner: SceneOwner,
        parent: Option<StableId>,
        index: usize,
        id: StableId,
    ) {
        if let Some(parent) = parent {
            let NodeKind::Group(group) = &mut self.nodes.get_mut(&parent).unwrap().kind else {
                unreachable!("validated parent is a group")
            };
            group.children.insert(index, id);
        } else {
            self.scene_mut(owner).roots.insert(index, id);
        }
    }

    fn is_descendant(
        &self,
        ancestor: StableId,
        candidate: StableId,
    ) -> Result<bool, PresentationError> {
        let mut cursor = Some(candidate);
        let mut steps = 0usize;
        while let Some(id) = cursor {
            if id == ancestor {
                return Ok(true);
            }
            cursor = self
                .nodes
                .get(&id)
                .ok_or(PresentationError::UnknownNode(id))?
                .parent;
            steps += 1;
            if steps > MAX_GROUP_DEPTH {
                return Err(PresentationError::LimitExceeded("group depth"));
            }
        }
        Ok(false)
    }

    fn node_depth(&self, id: StableId) -> Result<usize, PresentationError> {
        let mut depth = 1usize;
        let mut cursor = self
            .nodes
            .get(&id)
            .ok_or(PresentationError::UnknownNode(id))?
            .parent;
        while let Some(parent) = cursor {
            depth += 1;
            if depth > MAX_GROUP_DEPTH {
                return Err(PresentationError::LimitExceeded("group depth"));
            }
            cursor = self
                .nodes
                .get(&parent)
                .ok_or(PresentationError::UnknownNode(parent))?
                .parent;
        }
        Ok(depth)
    }

    fn subtree_depth(&self, id: StableId) -> Result<usize, PresentationError> {
        let node = self
            .nodes
            .get(&id)
            .ok_or(PresentationError::UnknownNode(id))?;
        let NodeKind::Group(group) = &node.kind else {
            return Ok(1);
        };
        let mut maximum = 1usize;
        let mut stack = group
            .children
            .iter()
            .map(|id| (*id, 2usize))
            .collect::<Vec<_>>();
        while let Some((child_id, depth)) = stack.pop() {
            if depth > MAX_GROUP_DEPTH {
                return Err(PresentationError::LimitExceeded("group depth"));
            }
            maximum = maximum.max(depth);
            if let NodeKind::Group(child_group) = &self
                .nodes
                .get(&child_id)
                .ok_or(PresentationError::UnknownNode(child_id))?
                .kind
            {
                stack.extend(child_group.children.iter().map(|id| (*id, depth + 1)));
            }
        }
        Ok(maximum)
    }

    pub(crate) fn from_snapshot_parts(
        parts: PresentationSnapshotParts,
    ) -> Result<Self, PresentationError> {
        let mut presentation = Self {
            id: parts.id,
            revision: parts.revision,
            ids: parts.ids,
            slide_size: parts.slide_size,
            master_order: parts.master_order,
            masters: parts.masters,
            layout_order: parts.layout_order,
            layouts: parts.layouts,
            slide_order: parts.slide_order,
            slides: parts.slides,
            nodes: parts.nodes,
            spatial: BTreeMap::new(),
        };
        presentation.validate_complete_model()?;
        for owner in presentation
            .master_order
            .iter()
            .copied()
            .map(SceneOwner::Master)
            .chain(
                presentation
                    .layout_order
                    .iter()
                    .copied()
                    .map(SceneOwner::Layout),
            )
            .chain(
                presentation
                    .slide_order
                    .iter()
                    .copied()
                    .map(SceneOwner::Slide),
            )
        {
            let index = presentation.rebuild_spatial_index(owner)?;
            if index != SpatialIndex::default() {
                presentation.spatial.insert(owner, index);
            }
        }
        Ok(presentation)
    }

    fn validate_complete_model(&self) -> Result<(), PresentationError> {
        SlideSize::new(self.slide_size.width.raw(), self.slide_size.height.raw())?;
        if self.id.is_zero() || self.id.namespace() == 0 || self.id.counter() == 0 {
            return Err(PresentationError::InvalidSnapshot("invalid deck id"));
        }
        validate_order(&self.master_order, &self.masters, "master order")?;
        validate_order(&self.layout_order, &self.layouts, "layout order")?;
        validate_order(&self.slide_order, &self.slides, "slide order")?;
        if self.masters.len() > MAX_PRESENTATION_MASTERS
            || self.layouts.len() > MAX_PRESENTATION_LAYOUTS
            || self.slides.len() > MAX_PRESENTATION_SLIDES
            || self.nodes.len() > MAX_PRESENTATION_NODES
        {
            return Err(PresentationError::LimitExceeded(
                "presentation object count",
            ));
        }
        let mut all_ids = BTreeSet::from([self.id]);
        for (key, master) in &self.masters {
            if key != &master.id {
                return Err(PresentationError::InvalidSnapshot(
                    "master map key mismatch",
                ));
            }
            validate_name(&master.name)?;
            if !all_ids.insert(master.id) {
                return Err(PresentationError::DuplicateId(master.id));
            }
        }
        for (key, layout) in &self.layouts {
            if key != &layout.id {
                return Err(PresentationError::InvalidSnapshot(
                    "layout map key mismatch",
                ));
            }
            validate_name(&layout.name)?;
            if let Some(master_id) = layout.master_id {
                if !self.masters.contains_key(&master_id) {
                    return Err(PresentationError::UnknownMaster(master_id));
                }
            }
            if !all_ids.insert(layout.id) {
                return Err(PresentationError::DuplicateId(layout.id));
            }
        }
        for (key, slide) in &self.slides {
            if key != &slide.id {
                return Err(PresentationError::InvalidSnapshot("slide map key mismatch"));
            }
            validate_name_or_empty(&slide.title)?;
            validate_rich_text(&slide.notes)?;
            if let Some(layout_id) = slide.layout_id {
                if !self.layouts.contains_key(&layout_id) {
                    return Err(PresentationError::UnknownLayout(layout_id));
                }
            }
            if !all_ids.insert(slide.id) {
                return Err(PresentationError::DuplicateId(slide.id));
            }
        }
        for node in self.nodes.values() {
            if node.id.is_zero()
                || node.id.namespace() == 0
                || node.id.counter() == 0
                || !all_ids.insert(node.id)
            {
                return Err(PresentationError::DuplicateId(node.id));
            }
            validate_node(
                &NewSceneNode {
                    id: node.id,
                    name: node.name.clone(),
                    bounds: node.bounds,
                    transform: node.transform,
                    kind: node.kind.clone(),
                },
                false,
            )?;
            self.scene(node.owner)?;
            if let Some(parent) = node.parent {
                let parent_node = self
                    .nodes
                    .get(&parent)
                    .ok_or(PresentationError::InvalidParent)?;
                if parent_node.owner != node.owner {
                    return Err(PresentationError::InvalidOwner);
                }
                let NodeKind::Group(group) = &parent_node.kind else {
                    return Err(PresentationError::InvalidParent);
                };
                if group.children.iter().filter(|id| **id == node.id).count() != 1 {
                    return Err(PresentationError::InvalidParent);
                }
            } else if self
                .scene(node.owner)?
                .roots
                .iter()
                .filter(|id| **id == node.id)
                .count()
                != 1
            {
                return Err(PresentationError::InvalidParent);
            }
            self.node_depth(node.id)?;
            if let NodeKind::Group(group) = &node.kind {
                for child_id in &group.children {
                    let child = self
                        .nodes
                        .get(child_id)
                        .ok_or(PresentationError::UnknownNode(*child_id))?;
                    if child.owner != node.owner || child.parent != Some(node.id) {
                        return Err(PresentationError::InvalidParent);
                    }
                }
            }
            self.validate_node_references(node.owner, node.id, &node.kind)?;
        }
        for owner in self
            .master_order
            .iter()
            .copied()
            .map(SceneOwner::Master)
            .chain(self.layout_order.iter().copied().map(SceneOwner::Layout))
            .chain(self.slide_order.iter().copied().map(SceneOwner::Slide))
        {
            let scene = self.scene(owner)?;
            if scene.roots.len() > MAX_PRESENTATION_ROOTS {
                return Err(PresentationError::LimitExceeded("scene roots"));
            }
            for root in &scene.roots {
                let node = self
                    .nodes
                    .get(root)
                    .ok_or(PresentationError::UnknownNode(*root))?;
                if node.owner != owner || node.parent.is_some() {
                    return Err(PresentationError::InvalidOwner);
                }
            }
        }
        let maximum_local = all_ids
            .iter()
            .filter(|id| id.namespace() == self.ids.namespace())
            .map(|id| id.counter())
            .max()
            .unwrap_or(0);
        if self.ids.namespace() == 0
            || (!self.ids.is_exhausted() && maximum_local >= self.ids.next_counter())
            || (self.ids.is_exhausted() && maximum_local != u64::MAX)
        {
            return Err(PresentationError::InvalidSnapshot(
                "id allocator can collide",
            ));
        }
        Ok(())
    }
}

pub(crate) struct PresentationSnapshotParts {
    pub id: StableId,
    pub revision: u64,
    pub ids: IdGenerator,
    pub slide_size: SlideSize,
    pub master_order: Vec<StableId>,
    pub masters: BTreeMap<StableId, Master>,
    pub layout_order: Vec<StableId>,
    pub layouts: BTreeMap<StableId, Layout>,
    pub slide_order: Vec<StableId>,
    pub slides: BTreeMap<StableId, Slide>,
    pub nodes: BTreeMap<StableId, SceneNode>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ResolvedSceneNode {
    pub id: StableId,
    pub source: SceneOwner,
    pub inherited: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedSlideScene {
    pub slide_id: StableId,
    pub nodes: Vec<ResolvedSceneNode>,
}

pub struct PresentationBatchTransaction<'a> {
    presentation: &'a mut Presentation,
    receipt: PresentationBatchReceipt,
    undo: Option<Vec<Undo>>,
    previous_ids: IdGenerator,
    previous_revision: u64,
    previous_spatial: Vec<(SceneOwner, Option<SpatialIndex>)>,
}

impl<'a> PresentationBatchTransaction<'a> {
    #[must_use]
    pub const fn presentation(&self) -> &Presentation {
        self.presentation
    }

    #[must_use]
    pub const fn receipt(&self) -> PresentationBatchReceipt {
        self.receipt
    }

    pub fn commit(mut self) -> PresentationBatchReceipt {
        self.undo = None;
        self.receipt
    }

    pub fn rollback(mut self) {
        self.restore();
    }

    fn restore(&mut self) {
        let Some(undo) = self.undo.take() else {
            return;
        };
        for entry in undo.into_iter().rev() {
            self.presentation.rollback(entry);
        }
        self.presentation.ids = self.previous_ids.clone();
        self.presentation.revision = self.previous_revision;
        for (owner, previous) in &self.previous_spatial {
            if let Some(index) = previous {
                self.presentation.spatial.insert(*owner, index.clone());
            } else {
                self.presentation.spatial.remove(owner);
            }
        }
    }
}

impl Drop for PresentationBatchTransaction<'_> {
    fn drop(&mut self) {
        self.restore();
    }
}

#[derive(Debug)]
enum Undo {
    SetPresentationSize {
        previous: SlideSize,
    },
    DeleteMaster(StableId),
    DeleteLayout(StableId),
    DeleteSlide(StableId),
    RestoreMaster {
        index: usize,
        master: Master,
    },
    RestoreLayout {
        index: usize,
        layout: Layout,
    },
    RestoreSlide {
        index: usize,
        slide: Slide,
    },
    SetSlideTitle {
        id: StableId,
        previous: String,
    },
    SetSlideLayout {
        id: StableId,
        previous: Option<StableId>,
    },
    SetSlideNotes {
        id: StableId,
        previous: RichText,
    },
    DeleteNode(StableId),
    RestoreNode {
        index: usize,
        node: SceneNode,
    },
    MoveNode {
        id: StableId,
        parent: Option<StableId>,
        index: usize,
    },
    SetNodeBounds {
        id: StableId,
        previous: super::Rect,
    },
    SetNodeTransform {
        id: StableId,
        previous: super::Transform,
    },
    SetNodeContent {
        id: StableId,
        previous: NodeKind,
    },
}

fn map_id_error(error: IdError) -> PresentationError {
    match error {
        IdError::Exhausted => PresentationError::IdExhausted,
        IdError::InvalidText | IdError::InvalidValue => PresentationError::InvalidId,
    }
}

fn validate_name(value: &str) -> Result<(), PresentationError> {
    if value.is_empty() {
        return Err(PresentationError::InvalidText("name must not be empty"));
    }
    validate_name_or_empty(value)
}

fn validate_name_or_empty(value: &str) -> Result<(), PresentationError> {
    if value.len() > MAX_NAME_BYTES {
        return Err(PresentationError::LimitExceeded("name bytes"));
    }
    if value.as_bytes().contains(&0) {
        return Err(PresentationError::InvalidText("text contains null"));
    }
    Ok(())
}

pub(crate) fn validate_rich_text(value: &RichText) -> Result<(), PresentationError> {
    if value.paragraphs.len() > MAX_TEXT_PARAGRAPHS {
        return Err(PresentationError::LimitExceeded("text paragraphs"));
    }
    let mut bytes = 0usize;
    let mut runs = 0usize;
    for paragraph in &value.paragraphs {
        runs = runs
            .checked_add(paragraph.runs.len())
            .ok_or(PresentationError::LimitExceeded("text runs"))?;
        if runs > MAX_TEXT_RUNS {
            return Err(PresentationError::LimitExceeded("text runs"));
        }
        for run in &paragraph.runs {
            bytes = bytes
                .checked_add(run.text.len())
                .ok_or(PresentationError::LimitExceeded("text bytes"))?;
            if bytes > MAX_TEXT_BYTES {
                return Err(PresentationError::LimitExceeded("text bytes"));
            }
            if run.text.as_bytes().contains(&0) {
                return Err(PresentationError::InvalidText("text contains null"));
            }
            if run.style.font_family.is_empty()
                || run.style.font_family.len() > MAX_NAME_BYTES
                || run.style.font_family.as_bytes().contains(&0)
            {
                return Err(PresentationError::InvalidStyle("font family"));
            }
            if !(1..=409_600).contains(&run.style.font_size_centipoints) {
                return Err(PresentationError::InvalidStyle("font size"));
            }
            if run
                .style
                .language
                .as_ref()
                .is_some_and(|language| language.len() > 128 || language.as_bytes().contains(&0))
            {
                return Err(PresentationError::InvalidStyle("language"));
            }
        }
    }
    Ok(())
}

fn validate_node(node: &NewSceneNode, require_empty_group: bool) -> Result<(), PresentationError> {
    if node.id.is_zero() || node.id.namespace() == 0 || node.id.counter() == 0 {
        return Err(PresentationError::InvalidId);
    }
    validate_name(&node.name)?;
    node.bounds.right()?;
    node.bounds.bottom()?;
    node.transform.validate()?;
    validate_node_kind(&node.kind, require_empty_group)
}

fn validate_node_kind(kind: &NodeKind, require_empty_group: bool) -> Result<(), PresentationError> {
    match kind {
        NodeKind::Shape(shape) => {
            validate_line(shape.line)?;
            if let Some(text) = &shape.text {
                validate_rich_text(text)?;
            }
            if let Some(placeholder) = &shape.placeholder {
                if placeholder.kind.is_empty()
                    || placeholder.kind.len() > MAX_NAME_BYTES
                    || placeholder.kind.as_bytes().contains(&0)
                {
                    return Err(PresentationError::InvalidText("placeholder kind"));
                }
            }
        }
        NodeKind::Group(group) => {
            if require_empty_group && !group.children.is_empty() {
                return Err(PresentationError::InvalidParent);
            }
            if group.children.len() > MAX_GROUP_CHILDREN {
                return Err(PresentationError::LimitExceeded("group children"));
            }
            if group.child_extent_width.raw() <= 0 || group.child_extent_height.raw() <= 0 {
                return Err(PresentationError::InvalidGeometry("group child extent"));
            }
            let mut unique = BTreeSet::new();
            if group
                .children
                .iter()
                .any(|id| id.is_zero() || !unique.insert(*id))
            {
                return Err(PresentationError::InvalidParent);
            }
        }
        NodeKind::Connector(connector) => {
            validate_line(connector.line)?;
            for endpoint in [connector.start, connector.end] {
                Emu::new(endpoint.x.raw())?;
                Emu::new(endpoint.y.raw())?;
                if endpoint.node_id.is_some_and(StableId::is_zero) {
                    return Err(PresentationError::InvalidId);
                }
            }
        }
        NodeKind::Chart(chart) => validate_chart(chart)?,
        NodeKind::Table(table) => validate_table(table)?,
        NodeKind::Media(media) => {
            if media.content_type.is_empty()
                || media.content_type.len() > MAX_MEDIA_TYPE_BYTES
                || !media
                    .content_type
                    .bytes()
                    .all(|byte| byte.is_ascii_graphic())
                || !media.content_type.contains('/')
            {
                return Err(PresentationError::InvalidMedia("content type"));
            }
            if media.alt_text.len() > MAX_TEXT_BYTES || media.alt_text.as_bytes().contains(&0) {
                return Err(PresentationError::InvalidMedia("alt text"));
            }
            if media.intrinsic_width == 0 || media.intrinsic_height == 0 {
                return Err(PresentationError::InvalidMedia("intrinsic dimensions"));
            }
        }
    }
    Ok(())
}

fn validate_line(line: super::LineStyle) -> Result<(), PresentationError> {
    if line.width.raw() < 0 {
        return Err(PresentationError::InvalidStyle("negative line width"));
    }
    Ok(())
}

fn validate_chart(chart: &Chart) -> Result<(), PresentationError> {
    validate_rich_text(&chart.title)?;
    if chart.series.len() > MAX_CHART_SERIES {
        return Err(PresentationError::LimitExceeded("chart series"));
    }
    let mut points = 0usize;
    for series in &chart.series {
        validate_name(&series.name)?;
        points = points
            .checked_add(series.categories.len())
            .and_then(|v| v.checked_add(series.values.len()))
            .and_then(|v| v.checked_add(series.x_values.len()))
            .and_then(|v| v.checked_add(series.bubble_sizes.len()))
            .ok_or(PresentationError::LimitExceeded("chart points"))?;
        if points > MAX_CHART_POINTS {
            return Err(PresentationError::LimitExceeded("chart points"));
        }
        for category in &series.categories {
            validate_name_or_empty(category)?;
        }
    }
    Ok(())
}

fn validate_table(table: &super::Table) -> Result<(), PresentationError> {
    let rows = table.rows.len();
    let columns = table.rows.first().map(Vec::len).unwrap_or(0);
    if rows == 0
        || rows > MAX_TABLE_ROWS
        || columns == 0
        || columns > MAX_TABLE_COLUMNS
        || table.rows.iter().any(|row| row.len() != columns)
    {
        return Err(PresentationError::InvalidTable("rectangular dimensions"));
    }
    if rows
        .checked_mul(columns)
        .is_none_or(|cells| cells > MAX_TABLE_CELLS)
    {
        return Err(PresentationError::LimitExceeded("table cells"));
    }
    if !table.column_widths.is_empty() && table.column_widths.len() != columns {
        return Err(PresentationError::InvalidTable("column widths"));
    }
    if !table.row_heights.is_empty() && table.row_heights.len() != rows {
        return Err(PresentationError::InvalidTable("row heights"));
    }
    if table
        .column_widths
        .iter()
        .chain(&table.row_heights)
        .any(|value| value.raw() <= 0)
    {
        return Err(PresentationError::InvalidTable("non-positive grid size"));
    }
    validate_line(table.line)?;
    let mut covered = vec![false; rows * columns];
    for (row_index, row) in table.rows.iter().enumerate() {
        for (column_index, cell) in row.iter().enumerate() {
            let offset = row_index * columns + column_index;
            match cell {
                None if !covered[offset] => {
                    return Err(PresentationError::InvalidTable("orphan covered cell"))
                }
                None => {}
                Some(_) if covered[offset] => {
                    return Err(PresentationError::InvalidTable("span anchor overlaps"))
                }
                Some(cell) => {
                    validate_rich_text(&cell.text)?;
                    if cell.row_span == 0 || cell.column_span == 0 {
                        return Err(PresentationError::InvalidTable("zero span"));
                    }
                    let row_end = row_index
                        .checked_add(usize::from(cell.row_span))
                        .ok_or(PresentationError::InvalidTable("span overflow"))?;
                    let column_end = column_index
                        .checked_add(usize::from(cell.column_span))
                        .ok_or(PresentationError::InvalidTable("span overflow"))?;
                    if row_end > rows || column_end > columns {
                        return Err(PresentationError::InvalidTable("span exceeds grid"));
                    }
                    for covered_row in row_index..row_end {
                        for covered_column in column_index..column_end {
                            if covered_row == row_index && covered_column == column_index {
                                continue;
                            }
                            let covered_offset = covered_row * columns + covered_column;
                            if covered[covered_offset]
                                || table.rows[covered_row][covered_column].is_some()
                            {
                                return Err(PresentationError::InvalidTable("overlapping spans"));
                            }
                            covered[covered_offset] = true;
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

fn order_index(order: &[StableId], id: StableId) -> Result<usize, PresentationError> {
    order
        .iter()
        .position(|candidate| *candidate == id)
        .ok_or(PresentationError::InvalidSnapshot(
            "catalog order is inconsistent",
        ))
}

fn remove_id(order: &mut Vec<StableId>, id: StableId) {
    if let Some(index) = order.iter().position(|candidate| *candidate == id) {
        order.remove(index);
    }
}

fn validate_order<T>(
    order: &[StableId],
    values: &BTreeMap<StableId, T>,
    label: &'static str,
) -> Result<(), PresentationError> {
    if order.len() != values.len() {
        return Err(PresentationError::InvalidSnapshot(label));
    }
    let mut unique = BTreeSet::new();
    if order
        .iter()
        .any(|id| !values.contains_key(id) || !unique.insert(*id))
    {
        return Err(PresentationError::InvalidSnapshot(label));
    }
    Ok(())
}
