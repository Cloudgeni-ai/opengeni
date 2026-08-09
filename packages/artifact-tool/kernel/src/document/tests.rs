use super::*;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

const NS: u64 = 0x0011_2233_4455_6677;
const NOW: &str = "2026-01-02T03:04:05.000Z";

fn id(kind: DocumentIdKind, counter: u64) -> DocumentId {
    DocumentId::new(kind, NS, counter).expect("fixture id")
}

fn apply(document: &mut Document, command: DocumentCommand) {
    document
        .apply_batch(&DocumentBatch::from_commands(vec![command]))
        .expect("fixture command");
}

fn full_typescript_fixture() -> Document {
    let mut document = Document::new(NS).expect("document");
    let first_section = id(DocumentIdKind::Section, 1);
    apply(
        &mut document,
        DocumentCommand::AddParagraph {
            target: StoryTarget::Section {
                section_id: first_section,
                kind: StoryKind::Header,
                variant: StoryVariant::Default,
            },
            id: id(DocumentIdKind::Paragraph, 8),
            runs: vec![TextRun::plain("OpenGeni brief")],
            style: ParagraphStyle::default(),
        },
    );
    apply(
        &mut document,
        DocumentCommand::AddParagraph {
            target: StoryTarget::Section {
                section_id: first_section,
                kind: StoryKind::Footer,
                variant: StoryVariant::Default,
            },
            id: id(DocumentIdKind::Paragraph, 9),
            runs: vec![TextRun::plain("Confidential")],
            style: ParagraphStyle::default(),
        },
    );
    apply(
        &mut document,
        DocumentCommand::AddParagraph {
            target: StoryTarget::Body,
            id: id(DocumentIdKind::Paragraph, 10),
            runs: vec![TextRun::plain("Launch decision")],
            style: ParagraphStyle {
                heading_level: Some(1),
                keep_next: Some(true),
                ..Default::default()
            },
        },
    );
    let recommendation = id(DocumentIdKind::Paragraph, 11);
    apply(
        &mut document,
        DocumentCommand::AddParagraph {
            target: StoryTarget::Body,
            id: recommendation,
            runs: vec![
                TextRun {
                    text: "Recommendation: ".into(),
                    style: TextStyle {
                        bold: Some(true),
                        ..Default::default()
                    },
                },
                TextRun::plain("ship the engine."),
            ],
            style: ParagraphStyle::default(),
        },
    );
    apply(
        &mut document,
        DocumentCommand::EditParagraph {
            id: recommendation,
            range: TextRange { start: 16, end: 20 },
            replacement: "release".into(),
            style: None,
        },
    );
    apply(
        &mut document,
        DocumentCommand::AddParagraph {
            target: StoryTarget::Body,
            id: id(DocumentIdKind::Paragraph, 12),
            runs: vec![TextRun::plain("Verify fidelity")],
            style: ParagraphStyle {
                list: Some(ListStyle {
                    kind: ListKind::Number,
                    level: Some(0),
                    instance_id: None,
                }),
                ..Default::default()
            },
        },
    );
    apply(
        &mut document,
        DocumentCommand::AddTable {
            target: StoryTarget::Body,
            id: id(DocumentIdKind::Table, 13),
            rows: vec![
                vec![vec![TextRun::plain("Area")], vec![TextRun::plain("Result")]],
                vec![
                    vec![TextRun::plain("Comments")],
                    vec![TextRun::plain("Editable")],
                ],
            ],
            style: TableStyle {
                width_pt: Some(360.0),
                column_widths_pt: Some(vec![210.0, 150.0]),
                header_rows: Some(1),
                header_fill: Some("#E5E7EB".into()),
                ..Default::default()
            },
        },
    );
    let appendix = id(DocumentIdKind::Section, 14);
    apply(
        &mut document,
        DocumentCommand::AddSection {
            ids: SectionIds {
                section: appendix,
                header_default: id(DocumentIdKind::Header, 15),
                header_first: id(DocumentIdKind::Header, 16),
                header_even: id(DocumentIdKind::Header, 17),
                footer_default: id(DocumentIdKind::Footer, 18),
                footer_first: id(DocumentIdKind::Footer, 19),
                footer_even: id(DocumentIdKind::Footer, 20),
            },
            page: PageGeometry {
                width_pt: 792.0,
                height_pt: 612.0,
                margin_left_pt: 54.0,
                margin_right_pt: 54.0,
                ..PageGeometry::default()
            },
            title_page: None,
        },
    );
    apply(
        &mut document,
        DocumentCommand::AddParagraph {
            target: StoryTarget::Section {
                section_id: appendix,
                kind: StoryKind::Header,
                variant: StoryVariant::First,
            },
            id: id(DocumentIdKind::Paragraph, 21),
            runs: vec![TextRun::plain("Appendix")],
            style: ParagraphStyle::default(),
        },
    );
    apply(
        &mut document,
        DocumentCommand::AddParagraph {
            target: StoryTarget::Body,
            id: id(DocumentIdKind::Paragraph, 22),
            runs: vec![TextRun::plain("Evidence.")],
            style: ParagraphStyle::default(),
        },
    );
    apply(
        &mut document,
        DocumentCommand::AddComment {
            id: id(DocumentIdKind::Comment, 23),
            paragraph_id: recommendation,
            range: TextRange { start: 0, end: 14 },
            resolved: false,
            root: CommentReply {
                author: "Reviewer".into(),
                text: "Confirm.".into(),
                created_at: NOW.into(),
            },
        },
    );
    apply(
        &mut document,
        DocumentCommand::AddCommentReply {
            id: id(DocumentIdKind::Comment, 23),
            reply: CommentReply {
                author: "Author".into(),
                text: "Confirmed.".into(),
                created_at: NOW.into(),
            },
        },
    );
    apply(
        &mut document,
        DocumentCommand::SetCommentResolved {
            id: id(DocumentIdKind::Comment, 23),
            resolved: true,
        },
    );
    apply(
        &mut document,
        DocumentCommand::AddTrackedChange {
            id: id(DocumentIdKind::TrackedChange, 24),
            paragraph_id: recommendation,
            range: TextRange { start: 16, end: 23 },
            kind: TrackedChangeKind::Insert,
            author: "Author".into(),
            created_at: NOW.into(),
        },
    );
    document
}

fn text_style_json(style: &TextStyle) -> Value {
    let mut value = Map::new();
    if let Some(item) = &style.font_family {
        value.insert("fontFamily".into(), json!(item));
    }
    if let Some(item) = style.font_size_pt {
        value.insert("fontSizePt".into(), json!(item));
    }
    if let Some(item) = &style.color {
        value.insert("color".into(), json!(item));
    }
    for (key, item) in [
        ("bold", style.bold),
        ("italic", style.italic),
        ("underline", style.underline),
        ("strike", style.strike),
    ] {
        if let Some(item) = item {
            value.insert(key.into(), json!(item));
        }
    }
    Value::Object(value)
}

fn paragraph_style_json(style: &ParagraphStyle) -> Value {
    let mut value = Map::new();
    if let Some(item) = style.heading_level {
        value.insert("headingLevel".into(), json!(item));
    }
    if let Some(item) = style.alignment {
        value.insert(
            "alignment".into(),
            json!(match item {
                ParagraphAlignment::Left => "left",
                ParagraphAlignment::Center => "center",
                ParagraphAlignment::Right => "right",
                ParagraphAlignment::Justify => "justify",
            }),
        );
    }
    for (key, item) in [
        ("spaceBeforePt", style.space_before_pt),
        ("spaceAfterPt", style.space_after_pt),
        ("lineHeight", style.line_height),
    ] {
        if let Some(item) = item {
            value.insert(key.into(), json!(item));
        }
    }
    for (key, item) in [
        ("keepNext", style.keep_next),
        ("pageBreakBefore", style.page_break_before),
    ] {
        if let Some(item) = item {
            value.insert(key.into(), json!(item));
        }
    }
    if let Some(list) = &style.list {
        let mut item = Map::new();
        item.insert(
            "kind".into(),
            json!(match list.kind {
                ListKind::Bullet => "bullet",
                ListKind::Number => "number",
            }),
        );
        if let Some(level) = list.level {
            item.insert("level".into(), json!(level));
        }
        if let Some(instance_id) = &list.instance_id {
            item.insert("instanceId".into(), json!(instance_id));
        }
        value.insert("list".into(), Value::Object(item));
    }
    Value::Object(value)
}

fn typescript_number(value: f64) -> Value {
    if value.fract() == 0.0 && value >= i64::MIN as f64 && value <= i64::MAX as f64 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

fn table_style_json(style: &TableStyle) -> Value {
    let mut value = Map::new();
    if let Some(item) = style.width_pt {
        value.insert("widthPt".into(), typescript_number(item));
    }
    if let Some(item) = &style.column_widths_pt {
        value.insert(
            "columnWidthsPt".into(),
            Value::Array(item.iter().copied().map(typescript_number).collect()),
        );
    }
    if let Some(item) = style.header_rows {
        value.insert("headerRows".into(), json!(item));
    }
    if let Some(item) = style.cell_padding_pt {
        value.insert("cellPaddingPt".into(), typescript_number(item));
    }
    if let Some(item) = &style.border_color {
        value.insert("borderColor".into(), json!(item));
    }
    if let Some(item) = &style.header_fill {
        value.insert("headerFill".into(), json!(item));
    }
    if let Some(item) = style.allow_row_split {
        value.insert("allowRowSplit".into(), json!(item));
    }
    Value::Object(value)
}

fn runs_json(runs: &[TextRun]) -> Value {
    Value::Array(
        runs.iter()
            .map(|run| json!({ "text": run.text, "style": text_style_json(&run.style) }))
            .collect(),
    )
}

fn block_json(document: &Document, block: BlockRef) -> Value {
    match block {
        BlockRef::Paragraph(id) => {
            let paragraph = document.paragraph(id).expect("fixture paragraph");
            json!({
                "kind": "paragraph",
                "id": id.as_typescript_id(),
                "runs": runs_json(&paragraph.runs),
                "style": paragraph_style_json(&paragraph.style),
            })
        }
        BlockRef::Table(id) => {
            let table = document.table(id).expect("fixture table");
            let rows = table
                .rows
                .iter()
                .map(|row| Value::Array(row.iter().map(|cell| runs_json(cell)).collect()))
                .collect::<Vec<_>>();
            json!({
                "kind": "table",
                "id": id.as_typescript_id(),
                "rows": rows,
                "style": table_style_json(&table.style),
            })
        }
        BlockRef::PageBreak(id) => {
            json!({ "kind": "pageBreak", "id": id.as_typescript_id() })
        }
    }
}

fn page_json(page: PageGeometry) -> Value {
    json!({
        "widthPt": typescript_number(page.width_pt),
        "heightPt": typescript_number(page.height_pt),
        "marginTopPt": typescript_number(page.margin_top_pt),
        "marginRightPt": typescript_number(page.margin_right_pt),
        "marginBottomPt": typescript_number(page.margin_bottom_pt),
        "marginLeftPt": typescript_number(page.margin_left_pt),
    })
}

fn story_json(document: &Document, story: &Story) -> Value {
    json!({
        "id": story.id.as_typescript_id(),
        "blocks": story.blocks.iter().map(|block| block_json(document, *block)).collect::<Vec<_>>(),
    })
}

fn semantic_json(document: &Document) -> Value {
    let mut root = Map::new();
    root.insert("version".into(), json!(1));
    root.insert(
        "idNamespace".into(),
        json!(format!("{:016x}", document.id_namespace())),
    );
    root.insert("nextId".into(), json!(document.next_id_counter()));
    root.insert("revision".into(), json!(document.revision()));
    if let Some(value) = document.explicit_even_and_odd_headers {
        root.insert("evenAndOddHeaders".into(), json!(value));
    }
    if let Some(value) = document.explicit_track_revisions {
        root.insert("trackRevisions".into(), json!(value));
    }
    root.insert("page".into(), page_json(document.page()));
    root.insert(
        "blocks".into(),
        Value::Array(
            document
                .body()
                .iter()
                .map(|block| block_json(document, *block))
                .collect(),
        ),
    );
    root.insert(
        "sections".into(),
        Value::Array(
            document
                .sections()
                .iter()
                .map(|section| {
                    let mut value = Map::new();
                    value.insert("id".into(), json!(section.id.as_typescript_id()));
                    value.insert("startBlockIndex".into(), json!(section.start_block_index));
                    if let Some(title_page) = section.title_page {
                        value.insert("titlePage".into(), json!(title_page));
                    }
                    value.insert("page".into(), page_json(section.page));
                    value.insert(
                        "headers".into(),
                        json!({
                            "default": story_json(document, &section.headers.default),
                            "first": story_json(document, &section.headers.first),
                            "even": story_json(document, &section.headers.even),
                        }),
                    );
                    value.insert(
                        "footers".into(),
                        json!({
                            "default": story_json(document, &section.footers.default),
                            "first": story_json(document, &section.footers.first),
                            "even": story_json(document, &section.footers.even),
                        }),
                    );
                    Value::Object(value)
                })
                .collect(),
        ),
    );
    root.insert(
        "comments".into(),
        Value::Array(
            document
                .comments()
                .map(|comment| {
                    json!({
                        "id": comment.id.as_typescript_id(),
                        "blockId": comment.block_id.as_typescript_id(),
                        "start": comment.range.start,
                        "end": comment.range.end,
                        "resolved": comment.resolved,
                        "replies": comment.replies.iter().map(|reply| json!({
                            "author": reply.author,
                            "text": reply.text,
                            "createdAt": reply.created_at,
                        })).collect::<Vec<_>>(),
                    })
                })
                .collect(),
        ),
    );
    root.insert(
        "changes".into(),
        Value::Array(
            document
                .tracked_changes()
                .map(|change| {
                    json!({
                        "id": change.id.as_typescript_id(),
                        "blockId": change.block_id.as_typescript_id(),
                        "kind": match change.kind { TrackedChangeKind::Insert => "insert", TrackedChangeKind::Delete => "delete" },
                        "start": change.range.start,
                        "end": change.range.end,
                        "author": change.author,
                        "createdAt": change.created_at,
                    })
                })
                .collect(),
        ),
    );
    Value::Object(root)
}

#[test]
fn mirrors_the_typescript_serialized_document_v1_fixture() {
    let document = full_typescript_fixture();
    document.validate().expect("valid fixture");
    let expected: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/document-native-semantic-vector.json"
    ))
    .expect("shared semantic vector");
    assert_eq!(semantic_json(&document), expected);
    assert_eq!(document.revision(), 14);
    assert_eq!(document.next_id_counter(), 25);
    assert_eq!(document.body().len(), 5);
    assert_eq!(document.sections().len(), 2);
    assert_eq!(document.sections()[1].start_block_index, 4);
    assert!(document.sections()[1].effective_title_page());
    assert_eq!(
        document
            .paragraph(id(DocumentIdKind::Paragraph, 11))
            .expect("recommendation")
            .runs,
        vec![
            TextRun {
                text: "Recommendation: release".into(),
                style: TextStyle {
                    bold: Some(true),
                    ..Default::default()
                },
            },
            TextRun::plain(" the engine."),
        ]
    );
    let comment = document
        .comment(id(DocumentIdKind::Comment, 23))
        .expect("comment");
    assert!(comment.resolved);
    assert_eq!(comment.replies.len(), 2);
    assert_eq!(comment.range, TextRange { start: 0, end: 14 });
    assert_eq!(
        document
            .tracked_change(id(DocumentIdKind::TrackedChange, 24))
            .expect("change")
            .range,
        TextRange { start: 16, end: 23 }
    );
    assert_eq!(
        id(DocumentIdKind::Paragraph, 11).as_typescript_id(),
        "p/0011223344556677000000000000000b"
    );
}

#[test]
fn canonical_snapshot_is_deterministic_strict_and_lossless() {
    let document = full_typescript_fixture();
    let first = encode_document_snapshot(&document).expect("encode");
    let second = encode_document_snapshot(&document).expect("encode again");
    assert_eq!(first, second);
    let restored = decode_document_snapshot(&first).expect("decode");
    assert_eq!(restored, document);
    assert_eq!(
        encode_document_snapshot(&restored).expect("re-encode"),
        first
    );

    let mut corrupted = first.clone();
    let index = corrupted.len() / 2;
    corrupted[index] ^= 0x80;
    assert_eq!(
        decode_document_snapshot(&corrupted),
        Err(DocumentError::SnapshotChecksumMismatch)
    );
    let mut trailing = first.clone();
    trailing.push(0);
    assert_eq!(
        decode_document_snapshot(&trailing),
        Err(DocumentError::SnapshotTrailingBytes)
    );
}

#[test]
fn legacy_default_page_snapshot_bytes_remain_exact() {
    let document = Document::new(NS).expect("document");
    let bytes = encode_document_snapshot(&document).expect("legacy snapshot");
    assert_eq!(u16::from_le_bytes([bytes[10], bytes[11]]), 0);
    assert_eq!(
        format!("{:x}", Sha256::digest(&bytes)),
        "b28976606c81dc5fe0944a5381e9af9258d0a018de5118156e5ad44cc422fed3"
    );
    let restored = decode_document_snapshot(&bytes).expect("legacy decode");
    assert_eq!(
        encode_document_snapshot(&restored).expect("legacy re-encode"),
        bytes
    );

    let mut unknown_flags = bytes.clone();
    unknown_flags[10..12].copy_from_slice(&2_u16.to_le_bytes());
    assert!(matches!(
        decode_document_snapshot(&unknown_flags),
        Err(DocumentError::NonCanonicalSnapshot(_))
    ));

    let mut missing_page_extras = bytes;
    missing_page_extras[10..12].copy_from_slice(&1_u16.to_le_bytes());
    assert_eq!(
        decode_document_snapshot(&missing_page_extras),
        Err(DocumentError::SnapshotTruncated)
    );
}

#[test]
fn failed_batch_rolls_back_exact_state_without_whole_model_clone() {
    let mut document = full_typescript_fixture();
    let before = encode_document_snapshot(&document).expect("before");
    let before_revision = document.revision();
    let next = document.next_id_counter();
    let batch = DocumentBatch::from_commands(vec![
        DocumentCommand::AddParagraph {
            target: StoryTarget::Body,
            id: id(DocumentIdKind::Paragraph, next),
            runs: vec![TextRun::plain("must roll back")],
            style: ParagraphStyle::default(),
        },
        DocumentCommand::AddTable {
            target: StoryTarget::Body,
            id: id(DocumentIdKind::Table, next + 1),
            rows: vec![vec![]],
            style: TableStyle::default(),
        },
    ]);
    let error = document.apply_batch(&batch).expect_err("invalid table");
    assert_eq!(error.command_index, 1);
    assert_eq!(error.cause, DocumentError::InvalidTable);
    assert_eq!(document.revision(), before_revision);
    assert_eq!(document.next_id_counter(), next);
    assert_eq!(encode_document_snapshot(&document).expect("after"), before);
}

#[test]
fn section_page_changes_are_validated_and_roll_back_exactly() {
    let mut document = Document::new(NS).expect("document");
    let section_id = id(DocumentIdKind::Section, 1);
    apply(
        &mut document,
        DocumentCommand::AddTable {
            target: StoryTarget::Body,
            id: id(DocumentIdKind::Table, 8),
            rows: vec![vec![vec![TextRun::plain("A")], vec![TextRun::plain("B")]]],
            style: TableStyle {
                width_pt: Some(360.0),
                column_widths_pt: Some(vec![180.0, 180.0]),
                ..TableStyle::default()
            },
        },
    );

    let landscape = PageGeometry {
        width_pt: 792.0,
        height_pt: 612.0,
        margin_top_pt: 54.0,
        margin_right_pt: 54.0,
        margin_bottom_pt: 54.0,
        margin_left_pt: 54.0,
        header_pt: 27.5,
        footer_pt: 31.25,
        gutter_pt: 9.5,
    };
    apply(
        &mut document,
        DocumentCommand::SetSectionPage {
            id: section_id,
            page: landscape,
        },
    );
    assert_eq!(document.sections()[0].page, landscape);
    assert_eq!(document.page(), landscape);

    let before = encode_document_snapshot(&document).expect("before");
    assert_eq!(u16::from_le_bytes([before[10], before[11]]), 1);
    let restored = decode_document_snapshot(&before).expect("restore page extras");
    assert_eq!(restored.sections()[0].page, landscape);
    assert_eq!(
        encode_document_snapshot(&restored).expect("re-encode page extras"),
        before
    );
    let before_revision = document.revision();
    let error = document
        .apply_batch(&DocumentBatch::from_commands(vec![
            DocumentCommand::SetSectionPage {
                id: section_id,
                page: PageGeometry::default(),
            },
            DocumentCommand::AddTable {
                target: StoryTarget::Body,
                id: id(DocumentIdKind::Table, 9),
                rows: vec![vec![]],
                style: TableStyle::default(),
            },
        ]))
        .expect_err("later failure must roll back the page change");
    assert_eq!(error.command_index, 1);
    assert_eq!(error.cause, DocumentError::InvalidTable);
    assert_eq!(document.revision(), before_revision);
    assert_eq!(encode_document_snapshot(&document).expect("after"), before);

    let invalid_page = document
        .apply_batch(&DocumentBatch::from_commands(vec![
            DocumentCommand::SetSectionPage {
                id: section_id,
                page: PageGeometry {
                    margin_left_pt: -0.0,
                    ..landscape
                },
            },
        ]))
        .expect_err("negative zero must fail closed");
    assert_eq!(invalid_page.command_index, 0);
    assert_eq!(invalid_page.cause, DocumentError::InvalidPageGeometry);
    assert_eq!(
        encode_document_snapshot(&document).expect("after invalid page"),
        before
    );

    let narrow_page = document
        .apply_batch(&DocumentBatch::from_commands(vec![
            DocumentCommand::SetSectionPage {
                id: section_id,
                page: PageGeometry {
                    width_pt: 300.0,
                    height_pt: 612.0,
                    margin_top_pt: 54.0,
                    margin_right_pt: 54.0,
                    margin_bottom_pt: 54.0,
                    margin_left_pt: 54.0,
                    ..PageGeometry::default()
                },
            },
        ]))
        .expect_err("page changes must validate existing tables");
    assert_eq!(narrow_page.command_index, 0);
    assert_eq!(narrow_page.cause, DocumentError::InvalidTableStyle);
    assert_eq!(
        encode_document_snapshot(&document).expect("after narrow page"),
        before
    );
}

#[test]
fn utf16_edits_and_review_anchors_match_javascript_boundaries() {
    let mut document = Document::new(NS).expect("document");
    let paragraph_id = id(DocumentIdKind::Paragraph, 8);
    apply(
        &mut document,
        DocumentCommand::AddParagraph {
            target: StoryTarget::Body,
            id: paragraph_id,
            runs: vec![TextRun::plain("A😀B")],
            style: ParagraphStyle::default(),
        },
    );
    let invalid = document.apply_batch(&DocumentBatch::from_commands(vec![
        DocumentCommand::EditParagraph {
            id: paragraph_id,
            range: TextRange { start: 2, end: 2 },
            replacement: "x".into(),
            style: None,
        },
    ]));
    assert_eq!(
        invalid.expect_err("surrogate split").cause,
        DocumentError::InvalidTextRange
    );
    apply(
        &mut document,
        DocumentCommand::AddComment {
            id: id(DocumentIdKind::Comment, 9),
            paragraph_id,
            range: TextRange { start: 1, end: 3 },
            resolved: false,
            root: CommentReply {
                author: "User".into(),
                text: "emoji".into(),
                created_at: NOW.into(),
            },
        },
    );
    apply(
        &mut document,
        DocumentCommand::EditParagraph {
            id: paragraph_id,
            range: TextRange { start: 1, end: 3 },
            replacement: "🙂".into(),
            style: None,
        },
    );
    assert_eq!(
        document.paragraph(paragraph_id).expect("paragraph").text(),
        "A🙂B"
    );
    assert_eq!(
        document
            .comment(id(DocumentIdKind::Comment, 9))
            .expect("comment")
            .range,
        TextRange { start: 1, end: 3 }
    );
}

#[test]
fn query_returns_complete_items_with_deterministic_cursors_and_hard_bounds() {
    let document = full_typescript_fixture();
    let limits = DocumentQueryLimits {
        max_items: 2,
        max_text_utf16: 1_000,
        max_table_cells: 100,
    };
    let first = document
        .query(DocumentQuery::Body {
            start_block: 0,
            limits,
        })
        .expect("first page");
    assert_eq!(first.items.len(), 2);
    assert_eq!(first.next_cursor, Some(2));
    assert!(first.truncated);
    let second = document
        .query(DocumentQuery::Body {
            start_block: first.next_cursor.expect("cursor"),
            limits,
        })
        .expect("second page");
    assert_eq!(second.items.len(), 2);
    assert_eq!(second.next_cursor, Some(4));
    let tiny = document.query(DocumentQuery::Body {
        start_block: 0,
        limits: DocumentQueryLimits {
            max_items: 1,
            max_text_utf16: 1,
            max_table_cells: 1,
        },
    });
    assert_eq!(tiny, Err(DocumentQueryError::FirstItemExceedsLimits));
}

#[test]
fn invalid_crossing_comments_and_overlapping_changes_fail_closed() {
    let mut document = Document::new(NS).expect("document");
    let paragraph_id = id(DocumentIdKind::Paragraph, 8);
    apply(
        &mut document,
        DocumentCommand::AddParagraph {
            target: StoryTarget::Body,
            id: paragraph_id,
            runs: vec![TextRun::plain("abcdefghij")],
            style: ParagraphStyle::default(),
        },
    );
    apply(
        &mut document,
        DocumentCommand::AddComment {
            id: id(DocumentIdKind::Comment, 9),
            paragraph_id,
            range: TextRange { start: 1, end: 6 },
            resolved: false,
            root: CommentReply {
                author: "User".into(),
                text: "one".into(),
                created_at: NOW.into(),
            },
        },
    );
    let crossing = document.apply_batch(&DocumentBatch::from_commands(vec![
        DocumentCommand::AddComment {
            id: id(DocumentIdKind::Comment, 10),
            paragraph_id,
            range: TextRange { start: 4, end: 8 },
            resolved: false,
            root: CommentReply {
                author: "User".into(),
                text: "two".into(),
                created_at: NOW.into(),
            },
        },
    ]));
    assert_eq!(
        crossing.expect_err("crossing").cause,
        DocumentError::CrossingCommentRanges
    );
    apply(
        &mut document,
        DocumentCommand::AddTrackedChange {
            id: id(DocumentIdKind::TrackedChange, 11),
            paragraph_id,
            range: TextRange { start: 0, end: 4 },
            kind: TrackedChangeKind::Insert,
            author: "User".into(),
            created_at: NOW.into(),
        },
    );
    let overlap = document.apply_batch(&DocumentBatch::from_commands(vec![
        DocumentCommand::AddTrackedChange {
            id: id(DocumentIdKind::TrackedChange, 12),
            paragraph_id,
            range: TextRange { start: 3, end: 5 },
            kind: TrackedChangeKind::Delete,
            author: "User".into(),
            created_at: NOW.into(),
        },
    ]));
    assert_eq!(
        overlap.expect_err("overlap").cause,
        DocumentError::OverlappingTrackedChanges
    );
}

#[test]
fn negative_zero_is_rejected_from_canonical_document_numbers() {
    let mut document = Document::new(NS).expect("document");
    document.sections[0].page.margin_left_pt = -0.0;
    assert!(matches!(
        encode_document_snapshot(&document),
        Err(DocumentError::InvalidPageGeometry)
    ));

    let mut document = Document::new(NS).expect("document");
    apply(
        &mut document,
        DocumentCommand::AddParagraph {
            target: StoryTarget::Body,
            id: id(DocumentIdKind::Paragraph, 8),
            runs: vec![TextRun::plain("x")],
            style: ParagraphStyle::default(),
        },
    );
    let before = encode_document_snapshot(&document).expect("before");
    assert!(document
        .apply_batch(&DocumentBatch::from_commands(vec![
            DocumentCommand::SetParagraphStyle {
                id: id(DocumentIdKind::Paragraph, 8),
                style: ParagraphStyle {
                    space_before_pt: Some(-0.0),
                    ..ParagraphStyle::default()
                },
            },
        ]))
        .is_err());
    assert_eq!(encode_document_snapshot(&document).expect("after"), before);
}
