#![forbid(unsafe_code)]

use opengeni_artifact_kernel::document::{
    DocumentBatch, DocumentCommand, DocumentId, DocumentIdKind, DocumentQuery, DocumentQueryLimits,
    PageGeometry, ParagraphStyle, StoryTarget, TextRun as DocumentTextRun, TextStyle,
};
use opengeni_artifact_kernel::presentation::{
    Chart, ChartSeries, ChartType, Connector, ConnectorEndpoint, ConnectorKind, Emu, Fill, Group,
    MediaFit, MediaReference, NewSceneNode, NodeKind, PresentationBatch, PresentationCommand, Rect,
    RichText, SceneOwner, Shape, ShapeGeometry, SlideSize, Table, TableCell, Transform,
    EMU_PER_CSS_PIXEL,
};
use opengeni_artifact_kernel::{Number, StableId};
use opengeni_artifact_kernel_binding_protocol::{
    encode_document_command_batch, encode_document_query, encode_namespace,
    encode_presentation_command_batch, encode_presentation_editor_slide_query,
    encode_presentation_metadata_query, encode_presentation_slide_catalog_query,
    encode_presentation_viewport_query, DocumentBindingSession, PresentationBindingSession,
    PresentationEditorSlideQuery, PresentationMetadataQuery, PresentationSlideCatalogQuery,
    PresentationViewportQuery,
};

fn main() {
    let namespace = 0x0123_4567_89ab_cdef;
    let namespace_envelope = encode_namespace(namespace);

    let paragraph_id =
        DocumentId::new(DocumentIdKind::Paragraph, namespace, 8).expect("paragraph id");
    let document_batch = DocumentBatch::from_commands(vec![
        DocumentCommand::SetDocumentFlags {
            even_and_odd_headers: Some(Some(true)),
            track_revisions: Some(None),
        },
        DocumentCommand::AddParagraph {
            target: StoryTarget::Body,
            id: paragraph_id,
            runs: vec![DocumentTextRun {
                text: "Hello 🦀".to_owned(),
                style: TextStyle {
                    font_family: Some("Inter".to_owned()),
                    font_size_pt: Some(12.5),
                    color: Some("#102030".to_owned()),
                    bold: Some(true),
                    italic: Some(false),
                    underline: None,
                    strike: None,
                },
            }],
            style: ParagraphStyle::default(),
        },
    ]);
    let document_section_page_batch =
        DocumentBatch::from_commands(vec![DocumentCommand::SetSectionPage {
            id: DocumentId::new(DocumentIdKind::Section, namespace, 1).expect("section id"),
            page: PageGeometry {
                width_pt: 792.0,
                height_pt: 612.0,
                margin_top_pt: 36.0,
                margin_right_pt: 42.0,
                margin_bottom_pt: 48.0,
                margin_left_pt: 54.0,
                header_pt: 27.5,
                footer_pt: 31.25,
                gutter_pt: 9.5,
            },
        }]);
    let document_commands =
        encode_document_command_batch(&document_batch).expect("document commands");
    let document_section_page_command =
        encode_document_command_batch(&document_section_page_batch).expect("section page command");
    let document_summary_query =
        encode_document_query(DocumentQuery::Summary).expect("summary query");
    let document_body_query = encode_document_query(DocumentQuery::Body {
        start_block: 0,
        limits: DocumentQueryLimits {
            max_items: 8,
            max_text_utf16: 1_024,
            max_table_cells: 64,
        },
    })
    .expect("body query");
    let mut document = DocumentBindingSession::create(&namespace_envelope).expect("document");
    document
        .apply_commands(&document_commands)
        .expect("document apply");
    let document_summary = document
        .query(&document_summary_query)
        .expect("document summary");
    let document_body = document.query(&document_body_query).expect("document body");

    let master_id = StableId::from_parts(namespace, 101);
    let layout_id = StableId::from_parts(namespace, 102);
    let slide_id = StableId::from_parts(namespace, 103);
    let node_id = StableId::from_parts(namespace, 104);
    let presentation_batch = PresentationBatch::from_commands(vec![
        PresentationCommand::CreateMaster {
            id: master_id,
            name: "Master".to_owned(),
            background: Fill::None,
        },
        PresentationCommand::CreateLayout {
            id: layout_id,
            name: "Layout".to_owned(),
            master_id: Some(master_id),
            background: Fill::None,
        },
        PresentationCommand::CreateSlide {
            id: slide_id,
            index: 0,
            title: "Fixture ✓".to_owned(),
            layout_id: Some(layout_id),
            background: Fill::None,
        },
        PresentationCommand::InsertNode {
            owner: SceneOwner::Slide(slide_id),
            parent: None,
            index: 0,
            node: NewSceneNode {
                id: node_id,
                name: "Title".to_owned(),
                bounds: Rect::new(0, 0, 1_000_000, 500_000).expect("rect"),
                transform: Transform::default(),
                kind: opengeni_artifact_kernel::presentation::NodeKind::Shape(Shape {
                    geometry: ShapeGeometry::TextBox,
                    fill: Fill::None,
                    line: Default::default(),
                    text: Some(RichText::plain("Hello")),
                    placeholder: None,
                }),
            },
        },
    ]);
    let presentation_commands =
        encode_presentation_command_batch(&presentation_batch).expect("presentation commands");
    let presentation_size_command =
        encode_presentation_command_batch(&PresentationBatch::from_commands(vec![
            PresentationCommand::SetPresentationSize {
                size: SlideSize::new(960 * EMU_PER_CSS_PIXEL, 540 * EMU_PER_CSS_PIXEL)
                    .expect("presentation size"),
            },
        ]))
        .expect("presentation size command");
    let presentation_metadata_query =
        encode_presentation_metadata_query(PresentationMetadataQuery { max_bytes: 1_024 })
            .expect("presentation metadata query");
    let presentation_viewport_query =
        encode_presentation_viewport_query(PresentationViewportQuery {
            owner: SceneOwner::Slide(slide_id),
            viewport: Rect::new(0, 0, 2_000_000, 1_000_000).expect("viewport"),
            max_nodes: 16,
            max_bytes: 4_096,
        })
        .expect("presentation viewport query");
    let presentation_slide_catalog_query =
        encode_presentation_slide_catalog_query(PresentationSlideCatalogQuery {
            start_slide: 0,
            max_slides: 8,
            max_text_bytes: 1_024,
            max_bytes: 4_096,
        })
        .expect("presentation slide catalog query");
    let presentation_editor_slide_query =
        encode_presentation_editor_slide_query(PresentationEditorSlideQuery {
            slide_id,
            max_nodes: 16,
            max_text_bytes: 4_096,
            max_bytes: 16_384,
        })
        .expect("presentation editor slide query");
    let mut presentation =
        PresentationBindingSession::create(&namespace_envelope).expect("presentation");
    presentation
        .apply_commands(&presentation_commands)
        .expect("presentation apply");
    let presentation_metadata = presentation
        .query(&presentation_metadata_query)
        .expect("presentation metadata");
    let presentation_viewport = presentation
        .query(&presentation_viewport_query)
        .expect("presentation viewport");
    let presentation_slide_catalog = presentation
        .query(&presentation_slide_catalog_query)
        .expect("presentation slide catalog");
    let presentation_editor_slide = presentation
        .query(&presentation_editor_slide_query)
        .expect("presentation editor slide");
    let group_id = StableId::from_parts(namespace, 105);
    let child_id = StableId::from_parts(namespace, 106);
    let connector_id = StableId::from_parts(namespace, 107);
    let chart_id = StableId::from_parts(namespace, 108);
    let table_id = StableId::from_parts(namespace, 109);
    let media_id = StableId::from_parts(namespace, 110);
    let full_scene_batch = PresentationBatch::from_commands(vec![
        PresentationCommand::InsertNode {
            owner: SceneOwner::Slide(slide_id),
            parent: None,
            index: 1,
            node: NewSceneNode {
                id: group_id,
                name: "Group".to_owned(),
                bounds: Rect::new(0, 0, 1_000_000, 500_000).expect("group rect"),
                transform: Transform::default(),
                kind: NodeKind::Group(Group {
                    child_offset_x: Emu::ZERO,
                    child_offset_y: Emu::ZERO,
                    child_extent_width: Emu::new(1_000_000).expect("group width"),
                    child_extent_height: Emu::new(500_000).expect("group height"),
                    children: vec![],
                }),
            },
        },
        PresentationCommand::InsertNode {
            owner: SceneOwner::Slide(slide_id),
            parent: Some(group_id),
            index: 0,
            node: NewSceneNode {
                id: child_id,
                name: "Child".to_owned(),
                bounds: Rect::new(0, 0, 200_000, 100_000).expect("child rect"),
                transform: Transform::default(),
                kind: NodeKind::Shape(Shape {
                    geometry: ShapeGeometry::Rectangle,
                    fill: Fill::None,
                    line: Default::default(),
                    text: Some(RichText::plain("Nested")),
                    placeholder: None,
                }),
            },
        },
        PresentationCommand::InsertNode {
            owner: SceneOwner::Slide(slide_id),
            parent: None,
            index: 2,
            node: NewSceneNode {
                id: connector_id,
                name: "Connector".to_owned(),
                bounds: Rect::new(0, 0, 1_000_000, 100_000).expect("connector rect"),
                transform: Transform::default(),
                kind: NodeKind::Connector(Connector {
                    kind: ConnectorKind::Curved,
                    start: ConnectorEndpoint {
                        node_id: Some(node_id),
                        x: Emu::ZERO,
                        y: Emu::ZERO,
                    },
                    end: ConnectorEndpoint {
                        node_id: None,
                        x: Emu::new(1_000_000).expect("connector x"),
                        y: Emu::new(100_000).expect("connector y"),
                    },
                    line: Default::default(),
                }),
            },
        },
        PresentationCommand::InsertNode {
            owner: SceneOwner::Slide(slide_id),
            parent: None,
            index: 3,
            node: NewSceneNode {
                id: chart_id,
                name: "Chart".to_owned(),
                bounds: Rect::new(0, 0, 1_000_000, 500_000).expect("chart rect"),
                transform: Transform::default(),
                kind: NodeKind::Chart(Chart {
                    chart_type: ChartType::Line,
                    title: RichText::plain("Trend"),
                    series: vec![ChartSeries {
                        name: "Series".to_owned(),
                        categories: vec!["A".to_owned(), "B".to_owned()],
                        values: vec![Number::new(1.0).unwrap(), Number::new(2.0).unwrap()],
                        x_values: vec![],
                        bubble_sizes: vec![],
                    }],
                    has_legend: true,
                }),
            },
        },
        PresentationCommand::InsertNode {
            owner: SceneOwner::Slide(slide_id),
            parent: None,
            index: 4,
            node: NewSceneNode {
                id: table_id,
                name: "Table".to_owned(),
                bounds: Rect::new(0, 0, 1_000_000, 500_000).expect("table rect"),
                transform: Transform::default(),
                kind: NodeKind::Table(Table {
                    rows: vec![vec![Some(TableCell {
                        text: RichText::plain("Cell"),
                        fill: Fill::None,
                        row_span: 1,
                        column_span: 1,
                    })]],
                    column_widths: vec![Emu::new(1_000_000).expect("column width")],
                    row_heights: vec![Emu::new(500_000).expect("row height")],
                    line: Default::default(),
                }),
            },
        },
        PresentationCommand::InsertNode {
            owner: SceneOwner::Slide(slide_id),
            parent: None,
            index: 5,
            node: NewSceneNode {
                id: media_id,
                name: "Media".to_owned(),
                bounds: Rect::new(0, 0, 1_000_000, 500_000).expect("media rect"),
                transform: Transform::default(),
                kind: NodeKind::Media(MediaReference {
                    digest: [7; 32],
                    content_type: "image/webp".to_owned(),
                    alt_text: "Diagram".to_owned(),
                    fit: MediaFit::Cover,
                    intrinsic_width: 1_920,
                    intrinsic_height: 1_080,
                }),
            },
        },
    ]);
    presentation
        .apply_commands(
            &encode_presentation_command_batch(&full_scene_batch).expect("full scene commands"),
        )
        .expect("full scene apply");
    let presentation_editor_all_nodes = presentation
        .query(&presentation_editor_slide_query)
        .expect("presentation editor all nodes");

    println!(
        "{{\"documentCommandsHex\":\"{}\",\"documentSectionPageCommandHex\":\"{}\",\"documentSummaryQueryHex\":\"{}\",\"documentBodyQueryHex\":\"{}\",\"documentSummaryResponseHex\":\"{}\",\"documentBodyResponseHex\":\"{}\",\"presentationCommandsHex\":\"{}\",\"presentationSizeCommandHex\":\"{}\",\"presentationMetadataQueryHex\":\"{}\",\"presentationViewportQueryHex\":\"{}\",\"presentationSlideCatalogQueryHex\":\"{}\",\"presentationEditorSlideQueryHex\":\"{}\",\"presentationMetadataResponseHex\":\"{}\",\"presentationViewportResponseHex\":\"{}\",\"presentationSlideCatalogResponseHex\":\"{}\",\"presentationEditorSlideResponseHex\":\"{}\",\"presentationEditorAllNodesResponseHex\":\"{}\"}}",
        hex(&document_commands),
        hex(&document_section_page_command),
        hex(&document_summary_query),
        hex(&document_body_query),
        hex(&document_summary),
        hex(&document_body),
        hex(&presentation_commands),
        hex(&presentation_size_command),
        hex(&presentation_metadata_query),
        hex(&presentation_viewport_query),
        hex(&presentation_slide_catalog_query),
        hex(&presentation_editor_slide_query),
        hex(&presentation_metadata),
        hex(&presentation_viewport),
        hex(&presentation_slide_catalog),
        hex(&presentation_editor_slide),
        hex(&presentation_editor_all_nodes),
    );
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(DIGITS[(byte >> 4) as usize]));
        output.push(char::from(DIGITS[(byte & 0x0f) as usize]));
    }
    output
}
