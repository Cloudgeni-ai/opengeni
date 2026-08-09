use std::alloc::{GlobalAlloc, Layout, System};
use std::hint::black_box;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use opengeni_artifact_kernel::{
    decode_snapshot, encode_snapshot, AtomicBatch, CausalDot, CausalFrontier, Cell, CellBlock,
    CellCoord, CellValue, CollaborationCommand, CollaborationOperation, CollaborationTransaction,
    CollaborativeWorkbook, Command, Number, OperationId, ReplicaId, SheetGeneration, StableId,
    TransactionId, Workbook,
};

const BULK_RELEASE_BUDGET_MS: f64 = 100.0;

struct TrackingAllocator;

static ALLOCATED_BYTES: AtomicU64 = AtomicU64::new(0);
static LIVE_BYTES: AtomicUsize = AtomicUsize::new(0);
static PEAK_LIVE_BYTES: AtomicUsize = AtomicUsize::new(0);

#[global_allocator]
static GLOBAL_ALLOCATOR: TrackingAllocator = TrackingAllocator;

unsafe impl GlobalAlloc for TrackingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            record_allocation(layout.size());
        }
        pointer
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() {
            record_allocation(layout.size());
        }
        pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) };
        LIVE_BYTES.fetch_sub(layout.size(), Ordering::Relaxed);
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let resized = unsafe { System.realloc(pointer, layout, new_size) };
        if !resized.is_null() {
            if new_size >= layout.size() {
                record_allocation(new_size - layout.size());
            } else {
                LIVE_BYTES.fetch_sub(layout.size() - new_size, Ordering::Relaxed);
            }
        }
        resized
    }
}

fn record_allocation(bytes: usize) {
    ALLOCATED_BYTES.fetch_add(bytes as u64, Ordering::Relaxed);
    let live = LIVE_BYTES.fetch_add(bytes, Ordering::Relaxed) + bytes;
    PEAK_LIVE_BYTES.fetch_max(live, Ordering::Relaxed);
}

#[derive(Clone, Copy)]
struct AllocationProbe {
    allocated: u64,
    live: usize,
    rss: Option<u64>,
}

#[derive(Clone, Copy)]
struct AllocationFacts {
    allocated_bytes: u64,
    peak_live_delta_bytes: usize,
    rss_before_bytes: Option<u64>,
    rss_after_bytes: Option<u64>,
}

impl AllocationProbe {
    fn start() -> Self {
        let live = LIVE_BYTES.load(Ordering::Relaxed);
        PEAK_LIVE_BYTES.store(live, Ordering::Relaxed);
        Self {
            allocated: ALLOCATED_BYTES.load(Ordering::Relaxed),
            live,
            rss: resident_set_bytes(),
        }
    }

    fn finish(self) -> AllocationFacts {
        AllocationFacts {
            allocated_bytes: ALLOCATED_BYTES
                .load(Ordering::Relaxed)
                .saturating_sub(self.allocated),
            peak_live_delta_bytes: PEAK_LIVE_BYTES
                .load(Ordering::Relaxed)
                .saturating_sub(self.live),
            rss_before_bytes: self.rss,
            rss_after_bytes: resident_set_bytes(),
        }
    }
}

fn main() {
    let deep = environment_flag("OPENGENI_ARTIFACT_BENCH_DEEP");
    let pinned = environment_flag("OPENGENI_ARTIFACT_BENCH_PINNED");
    let mode = if deep { "deep" } else { "ci" };
    let filter = std::env::var("OPENGENI_ARTIFACT_BENCH_FILTER").unwrap_or_else(|_| "all".into());
    if filter == "sparse" {
        benchmark_sparse(mode, if deep { 10_000 } else { 1_000 });
        return;
    }
    if filter == "dense" {
        benchmark_dense_random_edits(mode, if deep { 1_000_000 } else { 100_000 }, pinned);
        return;
    }
    if filter == "collaboration" {
        benchmark_collaboration_repeated_edits(
            mode,
            if deep { 1_000_000 } else { 100_000 },
            if deep { 200 } else { 50 },
            pinned,
        );
        return;
    }
    assert!(
        filter == "all" || filter == "core",
        "unknown OPENGENI_ARTIFACT_BENCH_FILTER: {filter}"
    );
    benchmark_create(mode, if deep { 1_000 } else { 100 }, pinned);
    let (mut workbook, sheet_id) = benchmark_bulk_write(
        mode,
        if deep { 100_000 } else { 20_000 },
        if deep { 30 } else { 8 },
        pinned,
    );
    benchmark_reversible_boundary_edit(
        mode,
        &mut workbook,
        sheet_id,
        if deep { 1_000 } else { 100 },
        pinned,
    );
    benchmark_snapshot(mode, &workbook, if deep { 30 } else { 8 });
    benchmark_lookups(
        mode,
        &workbook,
        sheet_id,
        if deep { 4_000_000 } else { 400_000 },
    );
    benchmark_collaboration_hot_apply(mode, if deep { 100_000 } else { 20_000 });
    if filter == "all" {
        benchmark_sparse(mode, if deep { 10_000 } else { 1_000 });
        benchmark_dense_random_edits(mode, if deep { 1_000_000 } else { 100_000 }, pinned);
        benchmark_collaboration_repeated_edits(
            mode,
            if deep { 1_000_000 } else { 100_000 },
            if deep { 200 } else { 50 },
            pinned,
        );
    }
}

fn benchmark_reversible_boundary_edit(
    mode: &str,
    workbook: &mut Workbook,
    sheet_id: StableId,
    samples: usize,
    pinned: bool,
) {
    let cell_count = workbook
        .sheet(sheet_id)
        .expect("sheet")
        .non_empty_cell_count();
    let coord = CellCoord::new(0, 0);
    let original = workbook
        .sheet(sheet_id)
        .and_then(|sheet| sheet.cell(coord))
        .cloned();
    let batch = AtomicBatch::from_commands(vec![Command::SetCells {
        sheet_id,
        anchor: coord,
        cells: CellBlock::new(1, 1, vec![Cell::from("boundary probe")]).expect("single cell"),
    }]);

    let mut timings = Vec::with_capacity(samples);
    for _ in 0..samples {
        let started = Instant::now();
        let transaction = workbook
            .begin_batch(black_box(&batch))
            .expect("begin batch");
        black_box(
            transaction
                .workbook()
                .sheet(sheet_id)
                .and_then(|sheet| sheet.cell(coord)),
        );
        transaction.rollback();
        timings.push(started.elapsed());
    }
    assert_eq!(
        workbook
            .sheet(sheet_id)
            .and_then(|sheet| sheet.cell(coord))
            .cloned(),
        original
    );
    let p95_ms = duration_ms(percentile(&timings, 0.95));
    print_measurement(
        "reversible_one_cell_boundary_edit_without_model_clone",
        mode,
        cell_count,
        timings,
        Some(1.0),
        pinned.then_some(p95_ms < 1.0),
    );
}

fn environment_flag(name: &str) -> bool {
    std::env::var(name).is_ok_and(|value| value == "1")
}

fn benchmark_create(mode: &str, samples: usize, pinned: bool) {
    let mut timings = Vec::with_capacity(samples);
    for sample in 0..samples {
        let started = Instant::now();
        let mut workbook = Workbook::new(10 + sample as u64).expect("workbook");
        let sheet_id = StableId::from_parts(10 + sample as u64, 100);
        workbook
            .apply_batch(&AtomicBatch::from_commands(vec![Command::CreateSheet {
                id: sheet_id,
                name: "Benchmark".into(),
            }]))
            .expect("create sheet");
        black_box(workbook);
        timings.push(started.elapsed());
    }
    let p95_ms = duration_ms(percentile(&timings, 0.95));
    print_measurement(
        "create_workbook_and_sheet",
        mode,
        1,
        timings,
        Some(5.0),
        pinned.then_some(p95_ms < 5.0),
    );
}

fn benchmark_bulk_write(
    mode: &str,
    cell_count: usize,
    samples: usize,
    pinned: bool,
) -> (Workbook, StableId) {
    let columns = 100u32;
    let rows = u32::try_from(cell_count / columns as usize).expect("row count");
    let cells: Vec<Cell> = (0..cell_count)
        .map(|index| {
            Cell::from_value(CellValue::Number(
                Number::new(index as f64).expect("finite benchmark input"),
            ))
        })
        .collect();
    let block = CellBlock::new(rows, columns, cells).expect("valid dense block");
    let sheet_id = StableId::from_parts(1, 10);
    let batch = AtomicBatch::from_commands(vec![
        Command::CreateSheet {
            id: sheet_id,
            name: "Benchmark".into(),
        },
        Command::SetCells {
            sheet_id,
            anchor: CellCoord::new(0, 0),
            cells: block,
        },
    ]);

    let mut timings = Vec::with_capacity(samples);
    let mut retained = None;
    for _ in 0..samples {
        let mut workbook = Workbook::new(1).expect("workbook");
        let started = Instant::now();
        let receipt = workbook
            .apply_batch(black_box(&batch))
            .expect("apply batch");
        timings.push(started.elapsed());
        assert_eq!(receipt.written_cells, cell_count);
        assert_eq!(
            workbook
                .sheet(sheet_id)
                .expect("sheet")
                .non_empty_cell_count(),
            cell_count
        );
        retained = Some(workbook);
    }
    let p95_ms = duration_ms(percentile(&timings, 0.95));
    let release_comparable = pinned && cell_count == 100_000;
    print_measurement(
        "bulk_write_primitive_cells",
        mode,
        cell_count,
        timings,
        Some(BULK_RELEASE_BUDGET_MS),
        release_comparable.then_some(p95_ms < BULK_RELEASE_BUDGET_MS),
    );
    (retained.expect("sample workbook"), sheet_id)
}

fn benchmark_snapshot(mode: &str, workbook: &Workbook, samples: usize) {
    let mut encode_timings = Vec::with_capacity(samples);
    let mut snapshot = Vec::new();
    for _ in 0..samples {
        let started = Instant::now();
        snapshot = encode_snapshot(black_box(workbook)).expect("encode snapshot");
        encode_timings.push(started.elapsed());
    }
    print_measurement(
        "encode_canonical_snapshot",
        mode,
        workbook
            .sheets()
            .map(opengeni_artifact_kernel::Sheet::non_empty_cell_count)
            .sum(),
        encode_timings,
        None,
        None,
    );

    let mut decode_timings = Vec::with_capacity(samples);
    for _ in 0..samples {
        let started = Instant::now();
        let decoded = decode_snapshot(black_box(&snapshot)).expect("decode snapshot");
        decode_timings.push(started.elapsed());
        assert_eq!(&decoded, workbook);
    }
    print_measurement_with_bytes(
        "decode_canonical_snapshot",
        mode,
        snapshot.len(),
        decode_timings,
        snapshot.len(),
    );
}

fn benchmark_lookups(mode: &str, workbook: &Workbook, sheet_id: StableId, lookups: usize) {
    let probes = [
        CellCoord::new(0, 0),
        CellCoord::new(127, 31),
        CellCoord::new(511, 63),
        CellCoord::new(999, 99),
    ];
    let started = Instant::now();
    for index in 0..lookups {
        black_box(
            workbook
                .sheet(sheet_id)
                .expect("sheet")
                .cell(probes[index % probes.len()]),
        );
    }
    print_measurement(
        "random_cell_lookup",
        mode,
        lookups,
        vec![started.elapsed()],
        None,
        None,
    );
}

fn benchmark_sparse(mode: &str, point_count: usize) {
    let sheet_id = StableId::from_parts(2, 10);
    let mut commands = Vec::with_capacity(point_count + 1);
    commands.push(Command::CreateSheet {
        id: sheet_id,
        name: "Sparse".into(),
    });
    for index in 0..point_count {
        let row = ((index as u64 * 999_999) / (point_count.saturating_sub(1).max(1) as u64)) as u32;
        let block = CellBlock::new(1, 1, vec![Cell::from(index.to_string())]).expect("point");
        commands.push(Command::SetCells {
            sheet_id,
            anchor: CellCoord::new(row, (index % 16) as u32),
            cells: block,
        });
    }
    let mut workbook = Workbook::new(2).expect("workbook");
    let allocations = AllocationProbe::start();
    let started = Instant::now();
    workbook
        .apply_batch(&AtomicBatch::from_commands(commands))
        .expect("sparse apply");
    let elapsed = started.elapsed();
    let snapshot = encode_snapshot(&workbook).expect("sparse snapshot");
    let allocation_facts = allocations.finish();
    let sheet = workbook.sheet(sheet_id).expect("sheet");
    assert_eq!(sheet.non_empty_cell_count(), point_count);
    print_measurement_with_facts(
        "sparse_million_row_sheet",
        mode,
        point_count,
        vec![elapsed],
        snapshot.len(),
        sheet.tile_count(),
        allocation_facts,
    );
}

fn benchmark_collaboration_hot_apply(mode: &str, cell_count: usize) {
    let model_namespace = 500;
    let replica = ReplicaId::new(501).expect("replica");
    let sheet_id = StableId::from_parts(model_namespace, 10);
    let creation_id = OperationId::from_stable_id(StableId::from_parts(501, 100));
    let mut workbook = CollaborativeWorkbook::new(model_namespace).expect("collaborative model");
    workbook
        .apply_transaction(CollaborationTransaction::new(
            TransactionId::from_stable_id(StableId::from_parts(501, 1)),
            CausalDot::new(replica, 1).expect("dot"),
            CausalFrontier::new(),
            vec![CollaborationOperation::new(
                creation_id,
                CollaborationCommand::CreateSheet {
                    sheet_id,
                    name: "Collaboration".into(),
                    after: None,
                },
            )],
        ))
        .expect("create collaborative sheet");

    let columns = 100u32;
    let rows = u32::try_from(cell_count / columns as usize).expect("rows");
    let cells: Vec<Cell> = (0..cell_count)
        .map(|index| Cell::from(index.to_string()))
        .collect();
    let transaction = CollaborationTransaction::new(
        TransactionId::from_stable_id(StableId::from_parts(501, 2)),
        CausalDot::new(replica, 2).expect("dot"),
        CausalFrontier::from_entries([(replica, 1)]).expect("base"),
        vec![CollaborationOperation::new(
            OperationId::from_stable_id(StableId::from_parts(501, 101)),
            CollaborationCommand::SetCells {
                sheet: SheetGeneration::new(sheet_id, creation_id),
                anchor: CellCoord::new(0, 0),
                cells: CellBlock::new(rows, columns, cells).expect("dense block"),
            },
        )],
    );
    let started = Instant::now();
    workbook
        .apply_transaction(black_box(transaction))
        .expect("hot collaboration apply");
    let elapsed = started.elapsed();
    assert_eq!(workbook.causal_cell_count(), cell_count);
    assert_eq!(
        workbook
            .workbook()
            .sheet(sheet_id)
            .expect("sheet")
            .non_empty_cell_count(),
        cell_count
    );
    print_measurement(
        "collaboration_hot_apply_without_snapshot_copy",
        mode,
        cell_count,
        vec![elapsed],
        None,
        None,
    );
}

fn benchmark_dense_random_edits(mode: &str, cell_count: usize, pinned: bool) {
    let model_allocations = AllocationProbe::start();
    let namespace = 600;
    let sheet_id = StableId::from_parts(namespace, 10);
    let columns = 1_000u32;
    let rows = u32::try_from(cell_count / columns as usize).expect("dense rows");
    let mut workbook = Workbook::new(namespace).expect("dense workbook");
    workbook
        .apply_batch(&AtomicBatch::from_commands(vec![
            Command::CreateSheet {
                id: sheet_id,
                name: "DenseRandom".into(),
            },
            Command::SetCells {
                sheet_id,
                anchor: CellCoord::new(0, 0),
                cells: CellBlock::new(rows, columns, vec![Cell::from(true); cell_count])
                    .expect("dense seed"),
            },
        ]))
        .expect("seed dense workbook");
    let model_allocation_facts = model_allocations.finish();

    let edits = if mode == "deep" { 10_000 } else { 2_000 };
    let allocations = AllocationProbe::start();
    let mut timings = Vec::with_capacity(edits);
    let mut random = 0x9e37_79b9u32;
    for edit in 0..edits {
        random = random.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let row = random % rows;
        random = random.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let column = random % columns;
        let batch = AtomicBatch::from_commands(vec![Command::SetCells {
            sheet_id,
            anchor: CellCoord::new(row, column),
            cells: CellBlock::new(1, 1, vec![Cell::from((edit & 1) == 0)]).expect("point"),
        }]);
        let started = Instant::now();
        workbook
            .apply_batch(black_box(&batch))
            .expect("random edit");
        timings.push(started.elapsed());
    }
    let allocation_facts = allocations.finish();
    let p95_ms = duration_ms(percentile(&timings, 0.95));
    let release_comparable = pinned && cell_count == 1_000_000;
    print_measurement_with_allocations(
        "dense_tile_random_edit",
        mode,
        edits,
        timings,
        allocation_facts,
        Some(1.0),
        release_comparable.then_some(p95_ms < 1.0),
        &[
            ("modelCells", cell_count as u64),
            (
                "modelAllocatedBytes",
                model_allocation_facts.allocated_bytes,
            ),
            (
                "modelPeakLiveDeltaBytes",
                model_allocation_facts.peak_live_delta_bytes as u64,
            ),
            (
                "modelRssDeltaBytes",
                rss_delta(model_allocation_facts) as u64,
            ),
        ],
    );
}

fn benchmark_collaboration_repeated_edits(
    mode: &str,
    cell_count: usize,
    edits: usize,
    pinned: bool,
) {
    let model_allocations = AllocationProbe::start();
    let model_namespace = 700;
    let replica = ReplicaId::new(701).expect("replica");
    let sheet_id = StableId::from_parts(model_namespace, 10);
    let creation_id = OperationId::from_stable_id(StableId::from_parts(701, 1));
    let generation = SheetGeneration::new(sheet_id, creation_id);
    let mut workbook = CollaborativeWorkbook::new(model_namespace).expect("collaborative model");
    workbook
        .apply_transaction(CollaborationTransaction::new(
            TransactionId::from_stable_id(StableId::from_parts(701, 1)),
            CausalDot::new(replica, 1).expect("dot"),
            CausalFrontier::new(),
            vec![CollaborationOperation::new(
                creation_id,
                CollaborationCommand::CreateSheet {
                    sheet_id,
                    name: "Million".into(),
                    after: None,
                },
            )],
        ))
        .expect("create collaborative sheet");

    let columns = 1_000u32;
    let rows = u32::try_from(cell_count / columns as usize).expect("rows");
    workbook
        .apply_transaction(CollaborationTransaction::new(
            TransactionId::from_stable_id(StableId::from_parts(701, 2)),
            CausalDot::new(replica, 2).expect("dot"),
            CausalFrontier::from_entries([(replica, 1)]).expect("base"),
            vec![CollaborationOperation::new(
                OperationId::from_stable_id(StableId::from_parts(701, 2)),
                CollaborationCommand::SetCells {
                    sheet: generation,
                    anchor: CellCoord::new(0, 0),
                    cells: CellBlock::new(rows, columns, vec![Cell::from(true); cell_count])
                        .expect("million-cell seed"),
                },
            )],
        ))
        .expect("seed collaborative cells");
    let model_allocation_facts = model_allocations.finish();

    let allocations = AllocationProbe::start();
    let mut timings = Vec::with_capacity(edits);
    let mut random = 0xa5a5_5a5au32;
    for edit in 0..edits {
        let counter = edit as u64 + 3;
        random = random.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let row = random % rows;
        random = random.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let column = random % columns;
        let transaction = CollaborationTransaction::new(
            TransactionId::from_stable_id(StableId::from_parts(701, counter + 10)),
            CausalDot::new(replica, counter).expect("dot"),
            CausalFrontier::from_entries([(replica, counter - 1)]).expect("base"),
            vec![CollaborationOperation::new(
                OperationId::from_stable_id(StableId::from_parts(701, counter + 10)),
                CollaborationCommand::SetCells {
                    sheet: generation,
                    anchor: CellCoord::new(row, column),
                    cells: CellBlock::new(1, 1, vec![Cell::from((edit & 1) == 0)]).expect("point"),
                },
            )],
        );
        let started = Instant::now();
        workbook
            .apply_transaction(black_box(transaction))
            .expect("repeated collaboration edit");
        timings.push(started.elapsed());
    }
    let allocation_facts = allocations.finish();
    assert_eq!(workbook.causal_cell_count(), cell_count);
    assert_eq!(
        workbook
            .workbook()
            .sheet(sheet_id)
            .expect("sheet")
            .non_empty_cell_count(),
        cell_count
    );
    let p95_ms = duration_ms(percentile(&timings, 0.95));
    let allocated_per_edit = allocation_facts.allocated_bytes / edits.max(1) as u64;
    let release_comparable = pinned && cell_count == 1_000_000 && edits >= 200;
    let budget_met = p95_ms < 5.0 && allocated_per_edit < 262_144;
    print_measurement_with_allocations(
        "collaboration_random_edit_on_million_cells",
        mode,
        edits,
        timings,
        allocation_facts,
        Some(5.0),
        release_comparable.then_some(budget_met),
        &[
            ("modelCells", cell_count as u64),
            (
                "modelAllocatedBytes",
                model_allocation_facts.allocated_bytes,
            ),
            (
                "modelPeakLiveDeltaBytes",
                model_allocation_facts.peak_live_delta_bytes as u64,
            ),
            (
                "modelRssDeltaBytes",
                rss_delta(model_allocation_facts) as u64,
            ),
        ],
    );
}

fn print_measurement(
    name: &str,
    mode: &str,
    work_units: usize,
    mut timings: Vec<Duration>,
    budget_ms: Option<f64>,
    budget_met: Option<bool>,
) {
    timings.sort_unstable();
    let min = duration_ms(*timings.first().unwrap_or(&Duration::ZERO));
    let median = duration_ms(percentile(&timings, 0.5));
    let p95 = duration_ms(percentile(&timings, 0.95));
    let max = duration_ms(*timings.last().unwrap_or(&Duration::ZERO));
    let budget =
        budget_ms.map_or_else(String::new, |value| format!(",\"releaseBudgetMs\":{value}"));
    let met = budget_met.map_or_else(String::new, |value| {
        format!(",\"releaseComparable\":true,\"releaseBudgetMet\":{value}")
    });
    println!(
        "{{\"name\":\"{name}\",\"backend\":\"rust-kernel\",\"mode\":\"{mode}\",\"workUnits\":{work_units},\"samples\":{},\"minMs\":{min:.3},\"medianMs\":{median:.3},\"p95Ms\":{p95:.3},\"maxMs\":{max:.3}{budget}{met}}}",
        timings.len()
    );
    assert_ne!(
        budget_met,
        Some(false),
        "pinned release budget failed for {name}: p95 {p95:.3} ms"
    );
}

fn print_measurement_with_bytes(
    name: &str,
    mode: &str,
    work_units: usize,
    mut timings: Vec<Duration>,
    output_bytes: usize,
) {
    timings.sort_unstable();
    println!(
        "{{\"name\":\"{name}\",\"backend\":\"rust-kernel\",\"mode\":\"{mode}\",\"workUnits\":{work_units},\"samples\":{},\"minMs\":{:.3},\"medianMs\":{:.3},\"p95Ms\":{:.3},\"maxMs\":{:.3},\"outputBytes\":{output_bytes}}}",
        timings.len(),
        duration_ms(*timings.first().unwrap_or(&Duration::ZERO)),
        duration_ms(percentile(&timings, 0.5)),
        duration_ms(percentile(&timings, 0.95)),
        duration_ms(*timings.last().unwrap_or(&Duration::ZERO)),
    );
}

fn print_measurement_with_facts(
    name: &str,
    mode: &str,
    work_units: usize,
    timings: Vec<Duration>,
    output_bytes: usize,
    tiles: usize,
    allocations: AllocationFacts,
) {
    let elapsed = duration_ms(timings[0]);
    let rss_before = optional_json_number(allocations.rss_before_bytes);
    let rss_after = optional_json_number(allocations.rss_after_bytes);
    println!(
        "{{\"name\":\"{name}\",\"backend\":\"rust-kernel\",\"mode\":\"{mode}\",\"workUnits\":{work_units},\"samples\":1,\"minMs\":{elapsed:.3},\"medianMs\":{elapsed:.3},\"p95Ms\":{elapsed:.3},\"maxMs\":{elapsed:.3},\"outputBytes\":{output_bytes},\"allocatedBytes\":{},\"peakLiveDeltaBytes\":{},\"rssBeforeBytes\":{rss_before},\"rssAfterBytes\":{rss_after},\"facts\":{{\"logicalRows\":1000000,\"storedCells\":{work_units},\"tiles\":{tiles}}}}}",
        allocations.allocated_bytes, allocations.peak_live_delta_bytes,
    );
}

#[allow(clippy::too_many_arguments)]
fn print_measurement_with_allocations(
    name: &str,
    mode: &str,
    work_units: usize,
    mut timings: Vec<Duration>,
    allocations: AllocationFacts,
    budget_ms: Option<f64>,
    budget_met: Option<bool>,
    facts: &[(&str, u64)],
) {
    timings.sort_unstable();
    let min = duration_ms(*timings.first().unwrap_or(&Duration::ZERO));
    let median = duration_ms(percentile(&timings, 0.5));
    let p95 = duration_ms(percentile(&timings, 0.95));
    let max = duration_ms(*timings.last().unwrap_or(&Duration::ZERO));
    let budget =
        budget_ms.map_or_else(String::new, |value| format!(",\"releaseBudgetMs\":{value}"));
    let met = budget_met.map_or_else(String::new, |value| {
        format!(",\"releaseComparable\":true,\"releaseBudgetMet\":{value}")
    });
    let rss_before = optional_json_number(allocations.rss_before_bytes);
    let rss_after = optional_json_number(allocations.rss_after_bytes);
    let facts = if facts.is_empty() {
        String::new()
    } else {
        let fields = facts
            .iter()
            .map(|(key, value)| format!("\"{key}\":{value}"))
            .collect::<Vec<_>>()
            .join(",");
        format!(",\"facts\":{{{fields}}}")
    };
    println!(
        "{{\"name\":\"{name}\",\"backend\":\"rust-kernel\",\"mode\":\"{mode}\",\"workUnits\":{work_units},\"samples\":{},\"minMs\":{min:.6},\"medianMs\":{median:.6},\"p95Ms\":{p95:.6},\"maxMs\":{max:.6},\"allocatedBytes\":{},\"allocatedBytesPerUnit\":{},\"peakLiveDeltaBytes\":{},\"rssBeforeBytes\":{rss_before},\"rssAfterBytes\":{rss_after}{budget}{met}{facts}}}",
        timings.len(),
        allocations.allocated_bytes,
        allocations.allocated_bytes / work_units.max(1) as u64,
        allocations.peak_live_delta_bytes,
    );
    assert_ne!(
        budget_met,
        Some(false),
        "pinned release budget failed for {name}: p95 {p95:.6} ms"
    );
}

fn rss_delta(facts: AllocationFacts) -> usize {
    facts
        .rss_after_bytes
        .zip(facts.rss_before_bytes)
        .map_or(0, |(after, before)| after.saturating_sub(before) as usize)
}

fn optional_json_number(value: Option<u64>) -> String {
    value.map_or_else(|| "null".into(), |value| value.to_string())
}

fn resident_set_bytes() -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let status = std::fs::read_to_string("/proc/self/status").ok()?;
        let kibibytes = status
            .lines()
            .find_map(|line| line.strip_prefix("VmRSS:"))?
            .split_ascii_whitespace()
            .next()?
            .parse::<u64>()
            .ok()?;
        kibibytes.checked_mul(1_024)
    }

    #[cfg(any(target_os = "macos", target_os = "freebsd"))]
    {
        let output = std::process::Command::new("ps")
            .args(["-o", "rss=", "-p", &std::process::id().to_string()])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let kibibytes = std::str::from_utf8(&output.stdout)
            .ok()?
            .trim()
            .parse::<u64>()
            .ok()?;
        kibibytes.checked_mul(1_024)
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "freebsd")))]
    {
        None
    }
}

fn percentile(values: &[Duration], quantile: f64) -> Duration {
    if values.is_empty() {
        return Duration::ZERO;
    }
    let index = ((values.len() as f64 * quantile).ceil() as usize)
        .saturating_sub(1)
        .min(values.len() - 1);
    values[index]
}

fn duration_ms(value: Duration) -> f64 {
    value.as_secs_f64() * 1_000.0
}
