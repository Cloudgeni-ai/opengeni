use std::hint::black_box;
use std::time::{Duration, Instant};

use opengeni_artifact_kernel::formula::{FormulaCellKey, FormulaEngine};
use opengeni_artifact_kernel::{CellCoord, CellValue, Number, StableId};

const DEPENDENTS: usize = 100_000;
const TARGET_P95_MS: f64 = 50.0;
const PINNED_SAMPLES: usize = 100;
const PINNED_WARMUPS: usize = 10;

fn main() {
    let pinned = std::env::var("OPENGENI_ARTIFACT_BENCH_PINNED").is_ok_and(|value| value == "1");
    let samples = if pinned { PINNED_SAMPLES } else { 20 };
    let warmups = if pinned { PINNED_WARMUPS } else { 3 };
    let sheet = StableId::from_parts(900, 1);
    let input = FormulaCellKey::new(sheet, CellCoord::new(0, 0));
    let mut engine = FormulaEngine::new();
    engine.register_sheet(sheet, "Incremental").expect("sheet");
    engine
        .set_value(input, number(1.0))
        .expect("benchmark input");
    for row in 0..DEPENDENTS {
        engine
            .set_formula(
                FormulaCellKey::new(sheet, CellCoord::new(row as u32, 1)),
                "=$A$1+1",
            )
            .expect("benchmark formula");
    }
    let initial = engine.recalculate().expect("initial calculation");
    assert_eq!(initial.evaluated_cells, DEPENDENTS);
    let stats = engine.stats();
    assert_eq!(stats.tracked_cells, DEPENDENTS + 1);
    assert_eq!(stats.formula_cells, DEPENDENTS);
    assert_eq!(stats.graph_edges, DEPENDENTS);
    assert_eq!(stats.dirty_formula_cells, 0);
    let allocation = engine.allocation_facts();
    // One-precedent formula edges stay inline; the input fanout is contiguous.
    assert_eq!(allocation.dependency_edge_slots, DEPENDENTS);
    assert_eq!(allocation.dependency_heap_capacity, 0);

    for sample in 0..warmups {
        edit_and_recalculate(&mut engine, input, sample as f64 + 2.0);
    }

    let mut total_timings = Vec::with_capacity(samples);
    let mut invalidation_timings = Vec::with_capacity(samples);
    let mut recalculation_timings = Vec::with_capacity(samples);
    for sample in 0..samples {
        let started = Instant::now();
        let update = engine
            .set_value(input, number(sample as f64 + 2.0))
            .expect("input edit");
        let invalidated = Instant::now();
        let receipt = engine.recalculate().expect("incremental calculation");
        let completed = Instant::now();
        total_timings.push(completed.duration_since(started));
        invalidation_timings.push(invalidated.duration_since(started));
        recalculation_timings.push(completed.duration_since(invalidated));
        assert!(update.content_changed);
        assert_eq!(update.dirty_formula_cells, DEPENDENTS);
        assert_eq!(receipt.evaluated_cells, DEPENDENTS);
        assert_eq!(receipt.changed_cells.len(), DEPENDENTS);
        assert_eq!(receipt.partition_widths, [DEPENDENTS]);
        assert_eq!(receipt.cyclic_or_blocked_cells, 0);
        assert_eq!(receipt.cell_reads, DEPENDENTS);
        assert_eq!(receipt.operations, DEPENDENTS * 3);
        black_box(receipt);
    }
    total_timings.sort_unstable();
    invalidation_timings.sort_unstable();
    recalculation_timings.sort_unstable();
    let p50_ms = milliseconds(percentile(&total_timings, 0.50));
    let p95_ms = milliseconds(percentile(&total_timings, 0.95));
    let p99_ms = milliseconds(percentile(&total_timings, 0.99));
    let invalidation_p95_ms = milliseconds(percentile(&invalidation_timings, 0.95));
    let recalculation_p95_ms = milliseconds(percentile(&recalculation_timings, 0.95));
    let minimum_ms = milliseconds(total_timings[0]);
    let maximum_ms = milliseconds(*total_timings.last().expect("timings"));
    let passed = p95_ms < TARGET_P95_MS;
    let last_value = engine
        .value(FormulaCellKey::new(
            sheet,
            CellCoord::new((DEPENDENTS - 1) as u32, 1),
        ))
        .and_then(|value| match value {
            CellValue::Number(value) => Some(value.get()),
            _ => None,
        })
        .expect("last formula value");
    let passed_json = if pinned {
        passed.to_string()
    } else {
        "null".to_owned()
    };
    println!(
        concat!(
            "{{\"schema_version\":1,",
            "\"benchmark\":\"recalculate_simple_dependents\",",
            "\"topology\":\"direct_fanout_shared_ast\",",
            "\"backend\":\"rust_native_kernel\",",
            "\"affected_cells\":{DEPENDENTS},\"warmups\":{warmups},\"samples\":{samples},",
            "\"min_ms\":{minimum_ms:.3},\"p50_ms\":{p50_ms:.3},",
            "\"p95_ms\":{p95_ms:.3},\"p99_ms\":{p99_ms:.3},\"max_ms\":{maximum_ms:.3},",
            "\"invalidation_p95_ms\":{invalidation_p95_ms:.3},",
            "\"recalculation_p95_ms\":{recalculation_p95_ms:.3},",
            "\"target_p95_ms\":{TARGET_P95_MS:.1},\"gate_enabled\":{pinned},",
            "\"release_comparable\":{pinned},\"passed\":{passed_json},",
            "\"platform\":\"{os}-{arch}\",\"pointer_width_bits\":{pointer_width},",
            "\"facts\":{{\"tracked_cells\":{tracked_cells},",
            "\"formula_cells\":{formula_cells},\"graph_edges\":{graph_edges},",
            "\"ast_nodes\":{ast_nodes},\"interned_strings\":{interned_strings},",
            "\"interned_utf8_bytes\":{interned_utf8_bytes},",
            "\"node_capacity\":{node_capacity},\"node_index_capacity\":{node_index_capacity},",
            "\"dependency_edge_slots\":{dependency_edge_slots},",
            "\"dependency_heap_capacity\":{dependency_heap_capacity},",
            "\"dependent_edge_slots\":{dependent_edge_slots},",
            "\"dependent_heap_capacity\":{dependent_heap_capacity},",
            "\"dirty_queue_capacity\":{dirty_queue_capacity},",
            "\"last_formula_value\":{last_value}}}}}"
        ),
        DEPENDENTS = DEPENDENTS,
        warmups = warmups,
        samples = samples,
        minimum_ms = minimum_ms,
        p50_ms = p50_ms,
        p95_ms = p95_ms,
        p99_ms = p99_ms,
        maximum_ms = maximum_ms,
        invalidation_p95_ms = invalidation_p95_ms,
        recalculation_p95_ms = recalculation_p95_ms,
        TARGET_P95_MS = TARGET_P95_MS,
        pinned = pinned,
        passed_json = passed_json,
        os = std::env::consts::OS,
        arch = std::env::consts::ARCH,
        pointer_width = usize::BITS,
        tracked_cells = stats.tracked_cells,
        formula_cells = stats.formula_cells,
        graph_edges = stats.graph_edges,
        ast_nodes = stats.interned_ast_nodes,
        interned_strings = stats.interned_strings,
        interned_utf8_bytes = allocation.interned_utf8_bytes,
        node_capacity = allocation.node_capacity,
        node_index_capacity = allocation.node_index_capacity,
        dependency_edge_slots = allocation.dependency_edge_slots,
        dependency_heap_capacity = allocation.dependency_heap_capacity,
        dependent_edge_slots = allocation.dependent_edge_slots,
        dependent_heap_capacity = allocation.dependent_heap_capacity,
        dirty_queue_capacity = allocation.dirty_queue_capacity,
        last_value = last_value,
    );
    if pinned {
        assert!(
            p95_ms < TARGET_P95_MS,
            "100k-dependent formula recalculation p95 {p95_ms:.3}ms exceeded {TARGET_P95_MS:.1}ms"
        );
    }
}

fn edit_and_recalculate(engine: &mut FormulaEngine, input: FormulaCellKey, value: f64) {
    let update = engine
        .set_value(input, number(value))
        .expect("warmup input edit");
    let receipt = engine.recalculate().expect("warmup calculation");
    assert!(update.content_changed);
    assert_eq!(receipt.evaluated_cells, DEPENDENTS);
    black_box(receipt);
}

fn number(value: f64) -> CellValue {
    CellValue::Number(Number::new(value).expect("finite benchmark number"))
}

fn percentile(values: &[Duration], percentile: f64) -> Duration {
    let index = ((values.len() as f64 * percentile).ceil() as usize)
        .saturating_sub(1)
        .min(values.len() - 1);
    values[index]
}

fn milliseconds(value: Duration) -> f64 {
    value.as_secs_f64() * 1_000.0
}
