#![forbid(unsafe_code)]

use std::hint::black_box;
use std::time::Instant;

use opengeni_artifact_kernel::document::{
    DocumentBatch, DocumentCommand, DocumentId, DocumentIdKind, DocumentQuery, DocumentQueryLimits,
    ParagraphStyle, StoryTarget, TextRange, TextRun,
};
use opengeni_artifact_kernel_binding_protocol::{
    apply_document_commands, create_document, encode_document_command_batch, encode_document_query,
    encode_namespace, DocumentBindingSession,
};

const STATEFUL_EDITS: usize = 20_000;
const STATELESS_EDITS: usize = 250;

fn samples(iterations: usize, mut operation: impl FnMut()) -> Vec<u128> {
    let mut values = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let started = Instant::now();
        operation();
        values.push(started.elapsed().as_nanos());
    }
    values.sort_unstable();
    values
}

fn p95(values: &[u128]) -> u128 {
    values[(values.len() * 95).div_ceil(100).saturating_sub(1)]
}

fn mean(values: &[u128]) -> u128 {
    values.iter().sum::<u128>() / values.len().max(1) as u128
}

fn millis(nanoseconds: u128) -> f64 {
    nanoseconds as f64 / 1_000_000.0
}

fn main() {
    let pinned = std::env::var("OPENGENI_ARTIFACT_BENCH_PINNED").is_ok_and(|value| value == "1");
    let namespace = 0x646f_6375_6d65_6e74;
    let paragraph_id =
        DocumentId::new(DocumentIdKind::Paragraph, namespace, 8).expect("paragraph id");
    let seed = encode_document_command_batch(&DocumentBatch::from_commands(vec![
        DocumentCommand::AddParagraph {
            target: StoryTarget::Body,
            id: paragraph_id,
            runs: vec![TextRun::plain("x".repeat(64 * 1024))],
            style: ParagraphStyle::default(),
        },
    ]))
    .expect("seed command");
    let edit = encode_document_command_batch(&DocumentBatch::from_commands(vec![
        DocumentCommand::EditParagraph {
            id: paragraph_id,
            range: TextRange { start: 0, end: 1 },
            replacement: "y".into(),
            style: None,
        },
    ]))
    .expect("edit command");
    let initial = create_document(&encode_namespace(namespace)).expect("initial document");
    let seeded = apply_document_commands(&initial, &seed).expect("seeded document");

    let mut session = DocumentBindingSession::open(&seeded).expect("stateful session");
    let stateful = samples(STATEFUL_EDITS, || {
        black_box(session.apply_commands(&edit).expect("stateful edit"));
    });
    let stateful_snapshot = session.snapshot().expect("stateful snapshot");

    let mut stateless_snapshot = seeded;
    let stateless = samples(STATELESS_EDITS, || {
        stateless_snapshot =
            apply_document_commands(&stateless_snapshot, &edit).expect("stateless edit");
        black_box(&stateless_snapshot);
    });

    let query = encode_document_query(DocumentQuery::Body {
        start_block: 0,
        limits: DocumentQueryLimits::default(),
    })
    .expect("query");
    let query_samples = samples(5_000, || {
        black_box(session.query(&query).expect("document projection"));
    });

    let stateful_mean = mean(&stateful);
    let stateful_p95 = p95(&stateful);
    let stateless_mean = mean(&stateless);
    let stateless_p95 = p95(&stateless);
    let query_p95 = p95(&query_samples);
    let speedup = stateless_mean as f64 / stateful_mean.max(1) as f64;
    assert_eq!(
        opengeni_artifact_kernel::document::decode_document_snapshot(&stateful_snapshot)
            .expect("decode stateful snapshot")
            .revision(),
        1 + STATEFUL_EDITS as u64
    );
    println!(
        "{{\"name\":\"document_binding_session\",\"backend\":\"rust-binding-protocol\",\"textUtf16\":65536,\"statefulSamples\":{STATEFUL_EDITS},\"statefulMeanMs\":{:.6},\"statefulP95Ms\":{:.6},\"statelessSamples\":{STATELESS_EDITS},\"statelessMeanMs\":{:.6},\"statelessP95Ms\":{:.6},\"statefulSpeedup\":{speedup:.3},\"querySamples\":5000,\"queryP95Ms\":{:.6}}}",
        millis(stateful_mean),
        millis(stateful_p95),
        millis(stateless_mean),
        millis(stateless_p95),
        millis(query_p95),
    );
    if pinned {
        assert!(
            stateful_p95 < 1_000_000,
            "stateful 64 KiB document edit p95 exceeded 1 ms"
        );
        assert!(
            query_p95 < 1_000_000,
            "bounded 64 KiB document query p95 exceeded 1 ms"
        );
        assert!(speedup > 3.0, "stateful document speedup fell below 3x");
    }
}
