#![forbid(unsafe_code)]

use std::hint::black_box;
use std::time::Instant;

use opengeni_artifact_kernel::{AtomicBatch, Cell, CellBlock, CellCoord, Command, StableId};
use opengeni_artifact_kernel_binding_protocol::{
    apply_commands, create_workbook, encode_command_batch, encode_namespace, encode_viewport_query,
    encode_workbook_metadata_query, BindingSession, ViewportQuery, WorkbookMetadataQuery,
};

const EDITS: usize = 20_000;
const STATELESS_SAMPLE_EDITS: usize = 250;

fn samples_nanos(iterations: usize, mut operation: impl FnMut()) -> Vec<u128> {
    let mut samples = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let started = Instant::now();
        operation();
        samples.push(started.elapsed().as_nanos());
    }
    samples.sort_unstable();
    samples
}

fn percentile_nanos(iterations: usize, mut operation: impl FnMut()) -> u128 {
    let samples = samples_nanos(iterations, &mut operation);
    p95(&samples)
}

fn p95(samples: &[u128]) -> u128 {
    samples[(samples.len() * 95).div_ceil(100).saturating_sub(1)]
}

fn mean(samples: &[u128]) -> u128 {
    samples.iter().sum::<u128>() / samples.len().max(1) as u128
}

fn seeded_session(namespace: u64, rows: u32, columns: u32) -> BindingSession {
    let sheet_id = StableId::from_parts(namespace, 100);
    let seed = encode_command_batch(&AtomicBatch::from_commands(vec![
        Command::CreateSheet {
            id: sheet_id,
            name: "ForkBench".into(),
        },
        Command::SetCells {
            sheet_id,
            anchor: CellCoord::new(0, 0),
            cells: CellBlock::new(
                rows,
                columns,
                vec![Cell::from(true); rows as usize * columns as usize],
            )
            .expect("seed block"),
        },
    ]))
    .expect("seed command");
    let mut session = BindingSession::create(&encode_namespace(namespace)).expect("session");
    session.apply_commands(&seed).expect("seed session");
    session
}

fn main() {
    let pinned = std::env::var("OPENGENI_ARTIFACT_BENCH_PINNED").is_ok_and(|value| value == "1");
    let namespace = 0x6f70_656e_6765_6e69;
    let namespace_envelope = encode_namespace(namespace);
    let sheet_id = StableId::from_parts(namespace, 100);
    let create = encode_command_batch(&AtomicBatch::from_commands(vec![
        Command::CreateSheet {
            id: sheet_id,
            name: "Bench".into(),
        },
        Command::SetCells {
            sheet_id,
            anchor: CellCoord::new(0, 0),
            cells: CellBlock::new(256, 256, vec![Cell::from(true); 256 * 256])
                .expect("dense seed block"),
        },
    ]))
    .expect("create command");
    let edit = encode_command_batch(&AtomicBatch::from_commands(vec![Command::SetCells {
        sheet_id,
        anchor: CellCoord::new(42, 17),
        cells: CellBlock::new(1, 1, vec![Cell::from("hot-path")]).expect("cell block"),
    }]))
    .expect("edit command");

    let initial = create_workbook(&namespace_envelope).expect("initial snapshot");
    let seeded = apply_commands(&initial, &create).expect("seed snapshot");
    let mut session = BindingSession::open(&seeded).expect("open stateful session");
    let stateful_samples = samples_nanos(EDITS, || {
        black_box(session.apply_commands(&edit).expect("stateful edit"));
    });
    let stateful_snapshot = session.snapshot().expect("stateful snapshot");

    let mut stateless_snapshot = seeded;
    let stateless_samples = samples_nanos(STATELESS_SAMPLE_EDITS, || {
        stateless_snapshot =
            apply_commands(&stateless_snapshot, &edit).expect("stateless edit snapshot");
        black_box(&stateless_snapshot);
    });

    let stateful_ns = mean(&stateful_samples);
    let stateful_p95_ns = p95(&stateful_samples);
    let stateless_ns = mean(&stateless_samples);
    let stateless_p95_ns = p95(&stateless_samples);
    let speedup = stateless_ns as f64 / stateful_ns.max(1) as f64;
    assert_eq!(
        opengeni_artifact_kernel::decode_snapshot(&stateful_snapshot)
            .expect("stateful decode")
            .sheet_count(),
        1
    );
    println!(
        "{{\"name\":\"binding_stateful_edit\",\"backend\":\"rust-binding-protocol\",\"modelCells\":65536,\"samples\":{EDITS},\"meanMs\":{:.6},\"p95Ms\":{:.6},\"statelessSamples\":{STATELESS_SAMPLE_EDITS},\"statelessMeanMs\":{:.6},\"statelessP95Ms\":{:.6},\"statefulSpeedup\":{speedup:.3}}}",
        nanos_ms(stateful_ns),
        nanos_ms(stateful_p95_ns),
        nanos_ms(stateless_ns),
        nanos_ms(stateless_p95_ns),
    );
    if pinned {
        assert!(
            stateful_p95_ns < 100_000,
            "stateful binding edit p95 exceeded 0.1 ms"
        );
        assert!(speedup > 100.0, "stateful binding speedup fell below 100x");
    }

    for (cells, rows, columns, fork_samples, hash_samples) in [
        (100_000, 1_000, 100, 50, 12),
        (1_000_000, 1_000, 1_000, 20, 5),
    ] {
        let session = seeded_session(namespace.wrapping_add(cells as u64), rows, columns);
        let fork_p95 = percentile_nanos(fork_samples, || {
            black_box(session.fork().expect("fork"));
        });
        let hash_p95 = percentile_nanos(hash_samples, || {
            black_box(session.state_hash().expect("state hash"));
        });
        let query = encode_viewport_query(ViewportQuery {
            sheet_id: StableId::from_parts(namespace.wrapping_add(cells as u64), 100),
            start: CellCoord::new(400, 0),
            rows: 100,
            columns: 100,
            max_cells: u32::MAX,
            max_bytes: u32::MAX,
        })
        .expect("viewport query");
        let viewport_p95 = percentile_nanos(50, || {
            black_box(session.query(&query).expect("viewport projection"));
        });
        let metadata_query = encode_workbook_metadata_query(WorkbookMetadataQuery {
            max_sheets: u32::MAX,
            max_bytes: u32::MAX,
        })
        .expect("metadata query");
        let metadata_samples = if cells == 1_000_000 { 5 } else { 12 };
        let metadata_p95 = percentile_nanos(metadata_samples, || {
            black_box(session.query(&metadata_query).expect("metadata projection"));
        });
        println!(
            "{{\"name\":\"binding_session_scale\",\"backend\":\"rust-binding-protocol\",\"cells\":{cells},\"forkSamples\":{fork_samples},\"forkP95Ms\":{:.6},\"stateHashSamples\":{hash_samples},\"stateHashP95Ms\":{:.6},\"viewportCells\":10000,\"viewportSamples\":50,\"viewportP95Ms\":{:.6},\"metadataSamples\":{metadata_samples},\"metadataP95Ms\":{:.6}}}",
            nanos_ms(fork_p95),
            nanos_ms(hash_p95),
            nanos_ms(viewport_p95),
            nanos_ms(metadata_p95),
        );
        if pinned && cells == 1_000_000 {
            assert!(fork_p95 < 10_000_000, "native fork p95 exceeded 10 ms");
            assert!(
                hash_p95 < 50_000_000,
                "native state hash p95 exceeded 50 ms"
            );
        }
    }
}

fn nanos_ms(nanoseconds: u128) -> f64 {
    nanoseconds as f64 / 1_000_000.0
}
