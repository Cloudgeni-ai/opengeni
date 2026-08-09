use crate::{Number, StableId};

use super::*;

fn id(counter: u64) -> StableId {
    StableId::from_parts(7, counter)
}

fn rect(x: i64, y: i64, width: i64, height: i64) -> Rect {
    Rect::new(
        x * EMU_PER_CSS_PIXEL,
        y * EMU_PER_CSS_PIXEL,
        width * EMU_PER_CSS_PIXEL,
        height * EMU_PER_CSS_PIXEL,
    )
    .expect("valid test rectangle")
}

fn shape(id: StableId, name: &str, bounds: Rect, text: &str) -> NewSceneNode {
    NewSceneNode {
        id,
        name: name.to_owned(),
        bounds,
        transform: Transform::default(),
        kind: NodeKind::Shape(Shape {
            geometry: ShapeGeometry::TextBox,
            fill: Fill::None,
            line: LineStyle::default(),
            text: Some(RichText::plain(text)),
            placeholder: None,
        }),
    }
}

fn minimal_deck() -> Presentation {
    let mut deck = Presentation::new(7, SlideSize::widescreen()).expect("deck");
    deck.apply_batch(&PresentationBatch::from_commands(vec![
        PresentationCommand::CreateMaster {
            id: id(2),
            name: "Master".to_owned(),
            background: Fill::Solid(Color::WHITE),
        },
        PresentationCommand::CreateLayout {
            id: id(3),
            name: "Layout".to_owned(),
            master_id: Some(id(2)),
            background: Fill::Solid(Color::WHITE),
        },
        PresentationCommand::CreateSlide {
            id: id(4),
            index: 0,
            title: String::new(),
            layout_id: Some(id(3)),
            background: Fill::Solid(Color::WHITE),
        },
        PresentationCommand::InsertNode {
            owner: SceneOwner::Slide(id(4)),
            parent: None,
            index: 0,
            node: shape(id(5), "Greeting", rect(10, 20, 30, 40), "Hello"),
        },
    ]))
    .expect("minimal deck batch");
    deck
}

#[test]
fn minimal_model_matches_typescript_reference_vector() {
    let deck = minimal_deck();
    let master = deck.master(id(2)).expect("master");
    let layout = deck.layout(id(3)).expect("layout");
    let slide = deck.slide(id(4)).expect("slide");
    let node = deck.node(id(5)).expect("shape");
    let NodeKind::Shape(shape) = &node.kind else {
        panic!("shape node")
    };
    let vector = format!(
        "deck|pr/1|{}|{}\nmaster|mt/{}|{}\nlayout|ly/{}|{}|mt/{}\nslide|sl/{}|{}|ly/{}\ntextbox|sh/{}|{}|{}|{}|{}|{}|{}\n",
        deck.slide_size().width.raw() / EMU_PER_CSS_PIXEL,
        deck.slide_size().height.raw() / EMU_PER_CSS_PIXEL,
        master.id.counter(),
        master.name,
        layout.id.counter(),
        layout.name,
        layout.master_id.expect("master id").counter(),
        slide.id.counter(),
        slide.title,
        slide.layout_id.expect("layout id").counter(),
        node.id.counter(),
        node.name,
        node.bounds.x.raw() / EMU_PER_CSS_PIXEL,
        node.bounds.y.raw() / EMU_PER_CSS_PIXEL,
        node.bounds.width.raw() / EMU_PER_CSS_PIXEL,
        node.bounds.height.raw() / EMU_PER_CSS_PIXEL,
        shape.text.as_ref().expect("shape text").text(),
    );
    assert_eq!(
        vector,
        include_str!("../../../test/fixtures/presentation-kernel-v1.txt")
    );
}

#[test]
fn command_batch_rolls_back_without_cloning_the_model() {
    let mut deck = minimal_deck();
    let before = deck.clone();
    let result = deck.apply_batch(&PresentationBatch::from_commands(vec![
        PresentationCommand::SetPresentationSize {
            size: SlideSize::new(960 * EMU_PER_CSS_PIXEL, 540 * EMU_PER_CSS_PIXEL)
                .expect("custom size"),
        },
        PresentationCommand::SetSlideTitle {
            id: id(4),
            title: "Changed".to_owned(),
        },
        PresentationCommand::SetSlideLayout {
            id: id(4),
            layout_id: Some(id(999)),
        },
    ]));
    assert_eq!(
        result,
        Err(PresentationBatchError {
            command_index: 2,
            kind: PresentationError::UnknownLayout(id(999)),
        })
    );
    assert_eq!(deck, before);
}

#[test]
fn presentation_size_changes_canonical_state_and_round_trips() {
    let mut deck = minimal_deck();
    let before = encode_presentation_snapshot(&deck).expect("default snapshot");
    let before_hash = presentation_state_hash(&deck).expect("default hash");
    let custom =
        SlideSize::new(960 * EMU_PER_CSS_PIXEL, 540 * EMU_PER_CSS_PIXEL).expect("custom size");
    deck.apply_batch(&PresentationBatch::from_commands(vec![
        PresentationCommand::SetPresentationSize { size: custom },
    ]))
    .expect("set presentation size");
    assert_eq!(deck.slide_size(), custom);
    let after = encode_presentation_snapshot(&deck).expect("custom snapshot");
    assert_ne!(after, before);
    assert_ne!(
        presentation_state_hash(&deck).expect("custom hash"),
        before_hash
    );
    assert_eq!(
        decode_presentation_snapshot(&after).expect("custom snapshot decode"),
        deck
    );
}

#[test]
fn viewport_projection_is_bounded_and_in_paint_order() {
    let mut deck = minimal_deck();
    deck.apply_batch(&PresentationBatch::from_commands(vec![
        PresentationCommand::InsertNode {
            owner: SceneOwner::Slide(id(4)),
            parent: None,
            index: 1,
            node: shape(id(6), "Offscreen", rect(500, 500, 20, 20), "No"),
        },
        PresentationCommand::InsertNode {
            owner: SceneOwner::Slide(id(4)),
            parent: None,
            index: 1,
            node: shape(id(7), "Second", rect(15, 25, 10, 10), "Yes"),
        },
    ]))
    .expect("insert shapes");
    let projection = deck
        .viewport_projection(SceneOwner::Slide(id(4)), rect(0, 0, 100, 100), 16)
        .expect("projection");
    assert_eq!(
        projection
            .nodes
            .iter()
            .map(|node| node.id)
            .collect::<Vec<_>>(),
        vec![id(5), id(7)]
    );
    assert!(!projection.truncated);
    let bounded = deck
        .viewport_projection(SceneOwner::Slide(id(4)), rect(0, 0, 100, 100), 1)
        .expect("bounded projection");
    assert_eq!(bounded.nodes[0].id, id(5));
    assert!(bounded.truncated);
}

#[test]
fn groups_reject_cycles_and_preserve_hierarchy_atomically() {
    let mut deck = minimal_deck();
    let group = |group_id| NewSceneNode {
        id: group_id,
        name: "Group".to_owned(),
        bounds: rect(0, 0, 100, 100),
        transform: Transform::default(),
        kind: NodeKind::Group(Group {
            child_offset_x: Emu::ZERO,
            child_offset_y: Emu::ZERO,
            child_extent_width: Emu::new(100 * EMU_PER_CSS_PIXEL).unwrap(),
            child_extent_height: Emu::new(100 * EMU_PER_CSS_PIXEL).unwrap(),
            children: Vec::new(),
        }),
    };
    deck.apply_batch(&PresentationBatch::from_commands(vec![
        PresentationCommand::InsertNode {
            owner: SceneOwner::Slide(id(4)),
            parent: None,
            index: 1,
            node: group(id(6)),
        },
        PresentationCommand::InsertNode {
            owner: SceneOwner::Slide(id(4)),
            parent: Some(id(6)),
            index: 0,
            node: group(id(7)),
        },
    ]))
    .expect("nested groups");
    let before = deck.clone();
    let error = deck
        .apply_batch(&PresentationBatch::from_commands(vec![
            PresentationCommand::MoveNode {
                id: id(6),
                new_parent: Some(id(7)),
                index: 0,
            },
        ]))
        .expect_err("cycle rejected");
    assert_eq!(error.kind, PresentationError::ParentCycle);
    assert_eq!(deck, before);
}

#[test]
fn invalid_table_spans_and_non_finite_chart_values_fail_closed() {
    let bad_table = NodeKind::Table(Table {
        rows: vec![vec![
            Some(TableCell {
                text: RichText::plain("A"),
                fill: Fill::None,
                row_span: 1,
                column_span: 2,
            }),
            Some(TableCell {
                text: RichText::plain("overlap"),
                fill: Fill::None,
                row_span: 1,
                column_span: 1,
            }),
        ]],
        column_widths: Vec::new(),
        row_heights: Vec::new(),
        line: LineStyle::default(),
    });
    let mut deck = minimal_deck();
    let error = deck
        .apply_batch(&PresentationBatch::from_commands(vec![
            PresentationCommand::InsertNode {
                owner: SceneOwner::Slide(id(4)),
                parent: None,
                index: 1,
                node: NewSceneNode {
                    id: id(6),
                    name: "Table".to_owned(),
                    bounds: rect(0, 0, 100, 50),
                    transform: Transform::default(),
                    kind: bad_table,
                },
            },
        ]))
        .expect_err("overlap rejected");
    assert_eq!(error.command_index, 0);
    assert!(matches!(error.kind, PresentationError::InvalidTable(_)));
    assert!(Number::new(f64::NAN).is_err());
}

#[test]
fn inheritance_resolves_placeholder_overrides_without_flattening_layers() {
    let mut deck = minimal_deck();
    let placeholder = |node_id, text: &str| {
        let mut node = shape(node_id, "Title", rect(10, 10, 100, 20), text);
        let NodeKind::Shape(shape) = &mut node.kind else {
            unreachable!()
        };
        shape.placeholder = Some(Placeholder {
            kind: "title".to_owned(),
            index: Some(0),
        });
        node
    };
    deck.apply_batch(&PresentationBatch::from_commands(vec![
        PresentationCommand::InsertNode {
            owner: SceneOwner::Master(id(2)),
            parent: None,
            index: 0,
            node: placeholder(id(6), "Master title"),
        },
        PresentationCommand::InsertNode {
            owner: SceneOwner::Layout(id(3)),
            parent: None,
            index: 0,
            node: placeholder(id(7), "Layout title"),
        },
        PresentationCommand::InsertNode {
            owner: SceneOwner::Slide(id(4)),
            parent: None,
            index: 1,
            node: placeholder(id(8), "Slide title"),
        },
    ]))
    .expect("placeholder layers");
    let resolved = deck.resolved_slide_scene(id(4)).expect("resolved scene");
    assert_eq!(
        resolved.nodes,
        vec![
            ResolvedSceneNode {
                id: id(5),
                source: SceneOwner::Slide(id(4)),
                inherited: false,
            },
            ResolvedSceneNode {
                id: id(8),
                source: SceneOwner::Slide(id(4)),
                inherited: false,
            },
        ]
    );
}

#[test]
fn connectors_require_same_scene_targets_and_block_dangling_deletes() {
    let mut deck = minimal_deck();
    deck.apply_batch(&PresentationBatch::from_commands(vec![
        PresentationCommand::InsertNode {
            owner: SceneOwner::Slide(id(4)),
            parent: None,
            index: 1,
            node: shape(id(6), "Target", rect(80, 20, 30, 40), "Target"),
        },
        PresentationCommand::InsertNode {
            owner: SceneOwner::Slide(id(4)),
            parent: None,
            index: 2,
            node: NewSceneNode {
                id: id(7),
                name: "Connector".to_owned(),
                bounds: rect(40, 30, 40, 1),
                transform: Transform::default(),
                kind: NodeKind::Connector(Connector {
                    kind: ConnectorKind::Straight,
                    start: ConnectorEndpoint {
                        node_id: Some(id(5)),
                        x: Emu::new(40 * EMU_PER_CSS_PIXEL).unwrap(),
                        y: Emu::new(30 * EMU_PER_CSS_PIXEL).unwrap(),
                    },
                    end: ConnectorEndpoint {
                        node_id: Some(id(6)),
                        x: Emu::new(80 * EMU_PER_CSS_PIXEL).unwrap(),
                        y: Emu::new(30 * EMU_PER_CSS_PIXEL).unwrap(),
                    },
                    line: LineStyle::default(),
                }),
            },
        },
    ]))
    .expect("connector");
    let before = deck.clone();
    let error = deck
        .apply_batch(&PresentationBatch::from_commands(vec![
            PresentationCommand::DeleteNode { id: id(5) },
        ]))
        .expect_err("referenced shape cannot be deleted");
    assert_eq!(error.kind, PresentationError::ReferencedObject);
    assert_eq!(deck, before);
}

#[test]
fn hit_test_returns_frontmost_node_first() {
    let mut deck = minimal_deck();
    deck.apply_batch(&PresentationBatch::from_commands(vec![
        PresentationCommand::InsertNode {
            owner: SceneOwner::Slide(id(4)),
            parent: None,
            index: 1,
            node: shape(id(6), "Front", rect(10, 20, 30, 40), "Front"),
        },
    ]))
    .expect("overlap");
    let hits = deck
        .hit_test(
            SceneOwner::Slide(id(4)),
            Emu::new(15 * EMU_PER_CSS_PIXEL).unwrap(),
            Emu::new(25 * EMU_PER_CSS_PIXEL).unwrap(),
            16,
        )
        .expect("hit test");
    assert_eq!(
        hits.iter().map(|hit| hit.id).collect::<Vec<_>>(),
        vec![id(6), id(5)]
    );
    let bounded = deck
        .hit_test(
            SceneOwner::Slide(id(4)),
            Emu::new(15 * EMU_PER_CSS_PIXEL).unwrap(),
            Emu::new(25 * EMU_PER_CSS_PIXEL).unwrap(),
            1,
        )
        .expect("bounded hit test");
    assert_eq!(
        bounded.iter().map(|hit| hit.id).collect::<Vec<_>>(),
        vec![id(6)]
    );
}

#[test]
fn inserting_below_the_maximum_group_depth_is_rejected_atomically() {
    let mut deck = minimal_deck();
    let group = |node_id| NewSceneNode {
        id: node_id,
        name: "Group".to_owned(),
        bounds: rect(0, 0, 100, 100),
        transform: Transform::default(),
        kind: NodeKind::Group(Group {
            child_offset_x: Emu::ZERO,
            child_offset_y: Emu::ZERO,
            child_extent_width: Emu::new(100 * EMU_PER_CSS_PIXEL).unwrap(),
            child_extent_height: Emu::new(100 * EMU_PER_CSS_PIXEL).unwrap(),
            children: Vec::new(),
        }),
    };
    let mut commands = Vec::new();
    for depth in 0..MAX_GROUP_DEPTH {
        commands.push(PresentationCommand::InsertNode {
            owner: SceneOwner::Slide(id(4)),
            parent: (depth > 0).then(|| id(5 + depth as u64)),
            index: 0,
            node: group(id(6 + depth as u64)),
        });
    }
    deck.apply_batch(&PresentationBatch::from_commands(commands))
        .expect("maximum-depth hierarchy");
    let before = deck.clone();
    let error = deck
        .apply_batch(&PresentationBatch::from_commands(vec![
            PresentationCommand::InsertNode {
                owner: SceneOwner::Slide(id(4)),
                parent: Some(id(5 + MAX_GROUP_DEPTH as u64)),
                index: 0,
                node: shape(
                    id(6 + MAX_GROUP_DEPTH as u64),
                    "Too deep",
                    rect(1, 1, 1, 1),
                    "",
                ),
            },
        ]))
        .expect_err("depth 33 rejected");
    assert_eq!(error.kind, PresentationError::LimitExceeded("group depth"));
    assert_eq!(deck, before);
}

#[test]
fn deterministic_edit_sequences_preserve_snapshot_and_spatial_parity() {
    let mut deck = minimal_deck();
    let inserts = (0..128u64)
        .map(|offset| PresentationCommand::InsertNode {
            owner: SceneOwner::Slide(id(4)),
            parent: None,
            index: usize::try_from(offset + 1).expect("index"),
            node: shape(
                id(6 + offset),
                &format!("Node {offset}"),
                rect(
                    i64::try_from(offset % 16).unwrap() * 12,
                    i64::try_from(offset / 16).unwrap() * 12,
                    10,
                    10,
                ),
                "",
            ),
        })
        .collect();
    deck.apply_batch(&PresentationBatch::from_commands(inserts))
        .expect("seed nodes");

    let mut state = 0x9e37_79b9u64;
    for step in 0..64usize {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        let target = id(6 + state % 128);
        let x = i64::try_from((state >> 8) % 1_000).unwrap();
        let y = i64::try_from((state >> 24) % 600).unwrap();
        deck.apply_batch(&PresentationBatch::from_commands(vec![
            PresentationCommand::SetNodeBounds {
                id: target,
                bounds: rect(x, y, 10, 10),
            },
            PresentationCommand::MoveNode {
                id: target,
                new_parent: None,
                index: step.wrapping_mul(17) % 129,
            },
        ]))
        .expect("deterministic edit");

        let snapshot = encode_presentation_snapshot(&deck).expect("encode");
        let decoded = decode_presentation_snapshot(&snapshot).expect("decode");
        assert_eq!(decoded, deck);
        assert_eq!(
            decoded
                .viewport_projection(SceneOwner::Slide(id(4)), rect(0, 0, 1_280, 720), 256)
                .expect("decoded viewport"),
            deck.viewport_projection(SceneOwner::Slide(id(4)), rect(0, 0, 1_280, 720), 256)
                .expect("source viewport")
        );
    }
}
