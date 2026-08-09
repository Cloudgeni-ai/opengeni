use std::time::Instant;

use crate::{
    decode_snapshot, encode_snapshot, AtomicBatch, Cell, CellBlock, CellCoord, CellValue, Command,
    DateValue, FormulaError, Number, StableId, Workbook,
};

use super::{FormulaCellKey, FormulaEngine, FormulaEngineError, FormulaLimits};

fn sheet_id(counter: u64) -> StableId {
    StableId::from_parts(42, counter)
}

fn key(sheet_id: StableId, row: u32, column: u32) -> FormulaCellKey {
    FormulaCellKey::new(sheet_id, CellCoord::new(row, column))
}

fn number(value: f64) -> CellValue {
    CellValue::Number(Number::new(value).expect("finite test number"))
}

fn number_at(engine: &FormulaEngine, key: FormulaCellKey) -> f64 {
    match engine.value(key) {
        Some(CellValue::Number(value)) => value.get(),
        value => panic!("expected number at {key:?}, got {value:?}"),
    }
}

#[test]
fn recalculation_visits_only_the_dirty_reverse_closure() {
    let sheet = sheet_id(1);
    let mut engine = FormulaEngine::new();
    engine.register_sheet(sheet, "Model").expect("sheet");
    engine
        .set_value(key(sheet, 0, 0), number(10.0))
        .expect("A1");
    engine.set_formula(key(sheet, 0, 1), "=A1*2").expect("B1");
    engine.set_formula(key(sheet, 0, 2), "=B1+1").expect("C1");

    let initial = engine.recalculate().expect("initial recalc");
    assert_eq!(initial.partition_widths, [1, 1]);
    assert_eq!(initial.evaluated_cells, 2);
    assert_eq!(number_at(&engine, key(sheet, 0, 2)), 21.0);

    engine
        .set_value(key(sheet, 0, 0), number(11.0))
        .expect("edit A1");
    let incremental = engine.recalculate().expect("incremental recalc");
    assert_eq!(incremental.evaluated_cells, 2);
    assert_eq!(incremental.partition_widths, [1, 1]);
    assert_eq!(number_at(&engine, key(sheet, 0, 2)), 23.0);

    engine
        .set_value(key(sheet, 99, 10), CellValue::Text("unrelated".into()))
        .expect("unrelated input");
    assert_eq!(
        engine.recalculate().expect("no-op recalc").evaluated_cells,
        0
    );
}

#[test]
fn core_function_set_matches_reference_semantics() {
    let sheet = sheet_id(2);
    let mut engine = FormulaEngine::new();
    engine.register_sheet(sheet, "Functions").expect("sheet");
    for (row, value) in [1.0, 2.0, 3.0].into_iter().enumerate() {
        engine
            .set_value(key(sheet, row as u32, 0), number(value))
            .expect("input");
    }
    let formulas = [
        "=SUM(A1:A3)",
        "=AVERAGE(A1:A3)",
        "=MIN(A1:A3)",
        "=MAX(A1:A3)",
        "=COUNT(A1:A3)",
        "=COUNTA(A1:A3)",
        "=IF(A1=1,7,9)",
        "=IFERROR(1/0,8)",
        "=AND(TRUE,NOT(FALSE))",
        "=ABS(-4)",
        "=ROUND(2.55,1)",
        "=ROUNDUP(2.51,1)",
        "=ROUNDDOWN(2.59,1)",
        "=POWER(2,3)",
        "=SQRT(9)",
        "=LEN(\"A😀\")",
        "=LOWER(\"LOUD\")",
        "=UPPER(\"quiet\")",
        "=TRIM(\"  a   b  \")",
        "=LEFT(\"abcd\",2)",
        "=RIGHT(\"abcd\",2)",
        "=MID(\"abcd\",2,2)",
        "=CONCAT(\"a\",A1,\"b\")",
        "=INDEX(A1:A3,2,1)",
        "=MATCH(2,A1:A3,0)",
        "=XLOOKUP(3,A1:A3,A1:A3,99)",
        "=YEAR(DATE(2024,2,29))",
        "=MONTH(DATE(2024,2,29))",
        "=DAY(DATE(2024,2,29))",
        "=DATE(2024,2,29)",
    ];
    for (row, formula) in formulas.into_iter().enumerate() {
        engine
            .set_formula(key(sheet, row as u32, 1), formula)
            .expect("formula");
    }
    engine.recalculate().expect("recalculate");

    let expected_numbers = [
        (0, 6.0),
        (1, 2.0),
        (2, 1.0),
        (3, 3.0),
        (4, 3.0),
        (5, 3.0),
        (6, 7.0),
        (7, 8.0),
        (9, 4.0),
        (10, 2.6),
        (11, 2.6),
        (12, 2.5),
        (13, 8.0),
        (14, 3.0),
        (15, 3.0),
        (23, 2.0),
        (24, 2.0),
        (25, 3.0),
        (26, 2024.0),
        (27, 2.0),
        (28, 29.0),
    ];
    for (row, expected) in expected_numbers {
        assert_eq!(
            number_at(&engine, key(sheet, row, 1)),
            expected,
            "row {row}"
        );
    }
    assert_eq!(
        engine.value(key(sheet, 8, 1)),
        Some(&CellValue::Boolean(true))
    );
    assert_eq!(
        engine.value(key(sheet, 16, 1)),
        Some(&CellValue::Text("loud".into()))
    );
    assert_eq!(
        engine.value(key(sheet, 17, 1)),
        Some(&CellValue::Text("QUIET".into()))
    );
    assert_eq!(
        engine.value(key(sheet, 18, 1)),
        Some(&CellValue::Text("a b".into()))
    );
    assert_eq!(
        engine.value(key(sheet, 19, 1)),
        Some(&CellValue::Text("ab".into()))
    );
    assert_eq!(
        engine.value(key(sheet, 20, 1)),
        Some(&CellValue::Text("cd".into()))
    );
    assert_eq!(
        engine.value(key(sheet, 21, 1)),
        Some(&CellValue::Text("bc".into()))
    );
    assert_eq!(
        engine.value(key(sheet, 22, 1)),
        Some(&CellValue::Text("a1b".into()))
    );
    assert_eq!(
        engine.value(key(sheet, 29, 1)),
        Some(&CellValue::Date(
            DateValue::new(1_709_164_800_000).expect("leap day")
        ))
    );
}

#[test]
fn evaluator_preserves_lazy_branches_provenance_and_error_semantics() {
    let sheet = sheet_id(61);
    let mut engine = FormulaEngine::new();
    engine.register_sheet(sheet, "Semantics").expect("sheet");
    engine
        .set_value(key(sheet, 0, 0), CellValue::Boolean(true))
        .expect("A1");
    engine
        .set_value(key(sheet, 1, 0), CellValue::Boolean(false))
        .expect("A2");
    engine
        .set_value(
            key(sheet, 2, 0),
            CellValue::Error(FormulaError::NotAvailable),
        )
        .expect("A3");
    engine.set_value(key(sheet, 3, 0), number(2.0)).expect("A4");
    for (row, source) in [
        (0, "=IF(FALSE,1/0,7)"),
        (1, "=IFERROR(1,1/0)"),
        (2, "=SUM(TRUE,2)"),
        (3, "=SUM(A4)"),
        (4, "=SUM(A1)"),
        (5, "=COUNTA(\"\")"),
        (6, "=AND(A1:A2)"),
        (7, "=\"a\"<1"),
        (8, "=ABS(1,2)"),
        (9, "=LEFT(\"abc\",-1)"),
        (10, "=MATCH(2,A3:A4,0)"),
        (11, "=MATCH(2,A4,1)"),
    ] {
        engine
            .set_formula(key(sheet, row, 1), source)
            .expect("formula");
    }
    engine.recalculate().expect("recalculate");
    for (row, expected) in [(0, 7.0), (1, 1.0), (2, 3.0), (3, 2.0), (4, 0.0), (5, 1.0)] {
        assert_eq!(number_at(&engine, key(sheet, row, 1)), expected);
    }
    assert_eq!(
        engine.value(key(sheet, 6, 1)),
        Some(&CellValue::Boolean(false))
    );
    for row in [7, 8, 9] {
        assert_eq!(
            engine.value(key(sheet, row, 1)),
            Some(&CellValue::Error(FormulaError::Value))
        );
    }
    for row in [10, 11] {
        assert_eq!(
            engine.value(key(sheet, row, 1)),
            Some(&CellValue::Error(FormulaError::NotAvailable))
        );
    }
}

#[test]
fn unselected_if_branch_consumes_no_range_read_fuel() {
    let sheet = sheet_id(62);
    let limits = FormulaLimits {
        max_recalculation_cell_reads: 1,
        ..FormulaLimits::default()
    };
    let mut engine = FormulaEngine::with_limits(limits).expect("limits");
    engine.register_sheet(sheet, "Lazy").expect("sheet");
    engine
        .set_formula(key(sheet, 0, 0), "=IF(FALSE,SUM(B1:B100000),7)")
        .expect("formula");
    let receipt = engine.recalculate().expect("dead branch is not evaluated");
    assert_eq!(receipt.cell_reads, 0);
    assert_eq!(number_at(&engine, key(sheet, 0, 0)), 7.0);
}

#[test]
fn stable_sheet_ids_compile_cross_sheet_references() {
    let inputs = sheet_id(3);
    let output = sheet_id(4);
    let mut engine = FormulaEngine::new();
    engine.register_sheet(inputs, "Inputs Q1").expect("inputs");
    engine.register_sheet(output, "Output").expect("output");
    engine
        .set_value(key(inputs, 0, 0), number(12.0))
        .expect("input");
    engine
        .set_formula(key(output, 0, 0), "='inputs q1'!A1*2")
        .expect("cross-sheet formula");
    engine.recalculate().expect("recalc");
    assert_eq!(number_at(&engine, key(output, 0, 0)), 24.0);

    engine.rename_sheet(inputs, "Assumptions").expect("rename");
    assert_eq!(
        engine.formula_source(key(output, 0, 0)),
        Some("='Assumptions'!A1*2")
    );
    engine
        .set_value(key(inputs, 0, 0), number(13.0))
        .expect("edit");
    engine.recalculate().expect("recalc after rename");
    assert_eq!(number_at(&engine, key(output, 0, 0)), 26.0);
}

#[test]
fn cycles_and_downstream_cells_have_deterministic_cycle_errors() {
    let sheet = sheet_id(5);
    let mut engine = FormulaEngine::new();
    engine.register_sheet(sheet, "Cycles").expect("sheet");
    engine.set_formula(key(sheet, 0, 0), "=B1+1").expect("A1");
    engine.set_formula(key(sheet, 0, 1), "=A1+1").expect("B1");
    engine.set_formula(key(sheet, 0, 2), "=A1+1").expect("C1");
    let receipt = engine.recalculate().expect("cycle result");
    assert_eq!(receipt.cyclic_or_blocked_cells, 3);
    for column in 0..3 {
        assert_eq!(
            engine.value(key(sheet, 0, column)),
            Some(&CellValue::Error(FormulaError::Custom("#CYCLE!".into())))
        );
    }
}

#[test]
fn dependency_edges_are_replaced_without_stale_invalidation() {
    let sheet = sheet_id(6);
    let mut engine = FormulaEngine::new();
    engine.register_sheet(sheet, "Edges").expect("sheet");
    engine.set_value(key(sheet, 0, 0), number(1.0)).expect("A1");
    engine
        .set_value(key(sheet, 0, 2), number(10.0))
        .expect("C1");
    engine.set_formula(key(sheet, 0, 1), "=A1").expect("B1");
    engine.recalculate().expect("initial");
    engine
        .set_formula(key(sheet, 0, 1), "=C1")
        .expect("replace");
    engine.recalculate().expect("replacement");

    engine
        .set_value(key(sheet, 0, 0), number(2.0))
        .expect("old source");
    assert_eq!(
        engine
            .recalculate()
            .expect("old source no-op")
            .evaluated_cells,
        0
    );
    engine
        .set_value(key(sheet, 0, 2), number(11.0))
        .expect("new source");
    assert_eq!(engine.recalculate().expect("new source").evaluated_cells, 1);
    assert_eq!(number_at(&engine, key(sheet, 0, 1)), 11.0);
    assert_eq!(engine.stats().graph_edges, 1);
}

#[test]
fn formula_limits_fail_before_unbounded_allocation() {
    let sheet = sheet_id(7);
    let mut engine = FormulaEngine::new();
    engine.register_sheet(sheet, "Limits").expect("sheet");
    let oversized = format!("={}+0", "1".repeat(engine.limits.max_formula_bytes));
    assert!(matches!(
        engine.set_formula(key(sheet, 0, 0), &oversized),
        Err(FormulaEngineError::Limit {
            resource: "formula bytes",
            ..
        })
    ));
    assert!(matches!(
        engine.set_formula(key(sheet, 0, 0), "=SUM(A1:A100001)"),
        Err(FormulaEngineError::Limit {
            resource: "formula range cells",
            ..
        })
    ));
    let nested = format!(
        "={}1{}",
        "(".repeat(engine.limits.max_nesting_depth + 1),
        ")".repeat(engine.limits.max_nesting_depth + 1)
    );
    assert!(matches!(
        engine.set_formula(key(sheet, 0, 0), &nested),
        Err(FormulaEngineError::Limit {
            resource: "formula nesting depth",
            ..
        })
    ));
    assert!(matches!(
        engine.set_formula(key(sheet, 0, 0), "=SUM(A1:A60000,A1:A60000)"),
        Err(FormulaEngineError::Limit {
            resource: "formula cell reads",
            ..
        })
    ));
    let flat = format!(
        "={}",
        std::iter::repeat_n("1", 66).collect::<Vec<_>>().join("+")
    );
    engine
        .set_formula(key(sheet, 0, 0), &flat)
        .expect("flat operator chains are not nested expressions");
    engine.recalculate().expect("flat chain recalculation");
    assert_eq!(number_at(&engine, key(sheet, 0, 0)), 66.0);
}

#[test]
fn dependency_depth_is_rejected_when_the_edge_is_authored() {
    let sheet = sheet_id(73);
    let limits = FormulaLimits {
        max_dependency_depth: 4,
        ..FormulaLimits::default()
    };
    let mut engine = FormulaEngine::with_limits(limits).expect("limits");
    engine.register_sheet(sheet, "Depth").expect("sheet");
    engine.set_value(key(sheet, 0, 0), number(1.0)).expect("A1");
    for (column, source) in [(1, "=A1"), (2, "=B1"), (3, "=C1"), (4, "=D1")] {
        engine
            .set_formula(key(sheet, 0, column), source)
            .expect("within depth");
    }
    assert!(matches!(
        engine.set_formula(key(sheet, 0, 5), "=E1"),
        Err(FormulaEngineError::Limit {
            resource: "formula dependency depth",
            actual: 5,
            maximum: 4,
        })
    ));
    engine.recalculate().expect("accepted chain remains usable");
    assert_eq!(number_at(&engine, key(sheet, 0, 4)), 1.0);
    assert_eq!(engine.value(key(sheet, 0, 5)), None);
}

#[test]
fn hostile_unicode_and_extreme_date_or_index_inputs_are_values_not_panics() {
    let sheet = sheet_id(71);
    let mut engine = FormulaEngine::new();
    engine.register_sheet(sheet, "Hostile").expect("sheet");
    for (row, formula) in [
        "=é",
        "=\u{00a0}",
        "=DATE(9223372036854775807,1,1)",
        "=DATE(-9223372036854775808,1,1)",
        "=INDEX(A1:A2,4294967297,1)",
    ]
    .into_iter()
    .enumerate()
    {
        engine
            .set_formula(key(sheet, row as u32, 1), formula)
            .expect("bounded formula");
    }
    engine.recalculate().expect("recalculate");
    assert_eq!(
        engine.value(key(sheet, 0, 1)),
        Some(&CellValue::Error(FormulaError::Value))
    );
    assert_eq!(
        engine.value(key(sheet, 1, 1)),
        Some(&CellValue::Error(FormulaError::Value))
    );
    for row in 2..=3 {
        assert_eq!(
            engine.value(key(sheet, row, 1)),
            Some(&CellValue::Error(FormulaError::Number))
        );
    }
    assert_eq!(
        engine.value(key(sheet, 4, 1)),
        Some(&CellValue::Error(FormulaError::Reference))
    );
}

#[test]
fn shared_fuel_keeps_failed_recalculation_atomic() {
    let sheet = sheet_id(8);
    let limits = FormulaLimits {
        max_operations: 2,
        max_recalculation_operations: 2,
        ..FormulaLimits::default()
    };
    let mut engine = FormulaEngine::with_limits(limits).expect("limits");
    engine.register_sheet(sheet, "Fuel").expect("sheet");
    engine.set_value(key(sheet, 0, 0), number(1.0)).expect("A1");
    engine.set_formula(key(sheet, 0, 1), "=A1+1").expect("B1");
    assert!(matches!(
        engine.recalculate(),
        Err(FormulaEngineError::Limit {
            resource: "formula operations",
            ..
        })
    ));
    assert_eq!(engine.value(key(sheet, 0, 1)), Some(&CellValue::Empty));
    assert_eq!(engine.stats().dirty_formula_cells, 1);
}

#[test]
fn aggregate_cached_value_budget_stops_text_fanout_atomically() {
    let sheet = sheet_id(72);
    let limits = FormulaLimits {
        max_engine_value_bytes: 128,
        ..FormulaLimits::default()
    };
    let mut engine = FormulaEngine::with_limits(limits).expect("limits");
    engine.register_sheet(sheet, "Text fanout").expect("sheet");
    engine
        .set_value(key(sheet, 0, 0), CellValue::Text("x".repeat(64)))
        .expect("source");
    engine
        .set_formula(key(sheet, 0, 1), "=A1")
        .expect("first dependent");
    engine
        .set_formula(key(sheet, 0, 2), "=A1")
        .expect("second dependent");
    assert!(matches!(
        engine.recalculate(),
        Err(FormulaEngineError::Limit {
            resource: "formula engine value bytes",
            ..
        })
    ));
    assert_eq!(engine.value(key(sheet, 0, 1)), Some(&CellValue::Empty));
    assert_eq!(engine.value(key(sheet, 0, 2)), Some(&CellValue::Empty));
    assert_eq!(engine.stats().dirty_formula_cells, 2);
    assert_eq!(engine.allocation_facts().cached_value_utf8_bytes, 64);
}

#[test]
fn rejected_formula_edit_rolls_back_nodes_and_interned_arenas() {
    let sheet = sheet_id(81);
    let limits = FormulaLimits {
        max_interned_ast_nodes: 2,
        ..FormulaLimits::default()
    };
    let mut engine = FormulaEngine::with_limits(limits).expect("limits");
    engine.register_sheet(sheet, "Atomic").expect("sheet");
    let before = engine.stats();
    assert!(matches!(
        engine.set_formula(key(sheet, 0, 0), "=A2+2+3"),
        Err(FormulaEngineError::Limit {
            resource: "formula AST nodes",
            ..
        })
    ));
    assert_eq!(engine.stats(), before);
    assert_eq!(engine.value(key(sheet, 0, 0)), None);
    assert_eq!(engine.value(key(sheet, 1, 0)), None);
}

#[test]
fn aggregate_interned_string_budget_is_bounded_and_transactional() {
    let sheet = sheet_id(85);
    let limits = FormulaLimits {
        max_interned_string_bytes: 16,
        ..FormulaLimits::default()
    };
    let mut engine = FormulaEngine::with_limits(limits).expect("limits");
    engine.register_sheet(sheet, "Strings").expect("sheet");
    engine
        .set_formula(key(sheet, 0, 0), "=1234567890")
        .expect("first formula");
    let before = engine.stats();

    assert!(matches!(
        engine.set_formula(key(sheet, 1, 0), "=0987654321"),
        Err(FormulaEngineError::Limit {
            resource: "formula interned UTF-8 bytes",
            ..
        })
    ));
    assert_eq!(engine.stats(), before);
    assert_eq!(engine.value(key(sheet, 1, 0)), None);

    // Reusing the existing source is interned once, not charged per cell.
    engine
        .set_formula(key(sheet, 2, 0), "=1234567890")
        .expect("deduplicated formula");
    engine.recalculate().expect("recalculate");
    assert_eq!(number_at(&engine, key(sheet, 2, 0)), 1_234_567_890.0);
}

#[test]
fn empty_formula_source_is_rejected_without_creating_state() {
    let sheet = sheet_id(82);
    let mut engine = FormulaEngine::new();
    engine.register_sheet(sheet, "Empty").expect("sheet");
    assert!(matches!(
        engine.set_formula(key(sheet, 0, 0), ""),
        Err(FormulaEngineError::FormulaSyntax { .. })
    ));
    assert_eq!(engine.stats().tracked_cells, 0);
}

#[test]
fn alternating_formula_and_value_edits_bound_stale_dirty_queue_entries() {
    let sheet = sheet_id(83);
    let mut engine = FormulaEngine::new();
    engine.register_sheet(sheet, "Queue").expect("sheet");
    let target = key(sheet, 0, 0);
    for _ in 0..10_000 {
        engine.set_formula(target, "=1+1").expect("formula");
        engine.set_value(target, number(2.0)).expect("value");
    }
    assert_eq!(engine.stats().dirty_formula_cells, 0);
    assert!(
        engine.dirty_nodes.len() <= 1_024,
        "stale dirty queue grew to {}",
        engine.dirty_nodes.len()
    );
    assert_eq!(engine.recalculate().expect("no-op").evaluated_cells, 0);
}

#[test]
fn unique_formula_churn_compacts_arenas_to_live_state() {
    let sheet = sheet_id(84);
    let mut engine = FormulaEngine::new();
    engine.register_sheet(sheet, "Churn").expect("sheet");
    let target = key(sheet, 0, 0);
    let mut maximum_ast_nodes = 0usize;
    for index in 0..10_000 {
        engine
            .set_formula(target, &format!("={index}+1"))
            .expect("formula");
        engine.set_value(target, number(0.0)).expect("value");
        maximum_ast_nodes = maximum_ast_nodes.max(engine.stats().interned_ast_nodes);
    }
    assert!(
        maximum_ast_nodes < 1_100,
        "AST churn reached {maximum_ast_nodes}"
    );
    engine.compact().expect("explicit final compaction");
    let stats = engine.stats();
    let facts = engine.allocation_facts();
    assert_eq!(stats.tracked_cells, 1);
    assert_eq!(stats.formula_cells, 0);
    assert_eq!(stats.interned_ast_nodes, 0);
    assert_eq!(stats.compiled_ranges, 0);
    assert_eq!(stats.interned_strings, 0);
    assert_eq!(facts.cached_value_utf8_bytes, 0);
}

#[test]
fn identical_formulas_share_the_compiled_ast() {
    let sheet = sheet_id(9);
    let mut engine = FormulaEngine::new();
    engine.register_sheet(sheet, "Interning").expect("sheet");
    engine.set_value(key(sheet, 0, 0), number(1.0)).expect("A1");
    for row in 1..=1_000 {
        engine
            .set_formula(key(sheet, row, 1), "=$A$1+1")
            .expect("formula");
    }
    let stats = engine.stats();
    assert_eq!(stats.formula_cells, 1_000);
    assert_eq!(stats.graph_edges, 1_000);
    assert_eq!(stats.interned_ast_nodes, 3);
    assert_eq!(stats.interned_strings, 1);
}

#[test]
fn deterministic_random_dag_matches_independent_arithmetic() {
    const CELLS: usize = 5_000;
    let sheet = sheet_id(10);
    let mut engine = FormulaEngine::new();
    engine.register_sheet(sheet, "Random DAG").expect("sheet");
    engine
        .set_value(key(sheet, 0, 0), number(1.0))
        .expect("seed one");
    engine
        .set_value(key(sheet, 1, 0), number(2.0))
        .expect("seed two");
    let mut expected = vec![1.0, 2.0];
    let mut state = 0x9e37_79b9_7f4a_7c15u64;
    for row in 2..CELLS {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        let left = state as usize % row;
        state = state.rotate_left(23).wrapping_mul(0x2545_f491_4f6c_dd1d);
        let right = state as usize % row;
        let formula = format!("=A{}+A{}", left + 1, right + 1);
        engine
            .set_formula(key(sheet, row as u32, 0), &formula)
            .expect("DAG formula");
        expected.push(expected[left] + expected[right]);
    }
    let started = Instant::now();
    let receipt = engine.recalculate().expect("DAG recalc");
    assert_eq!(receipt.evaluated_cells, CELLS - 2);
    assert!(
        started.elapsed().as_secs_f64() < 2.0,
        "debug DAG sanity budget"
    );
    for row in (0..CELLS).step_by(97) {
        assert_eq!(number_at(&engine, key(sheet, row as u32, 0)), expected[row]);
    }
}

#[test]
fn trace_is_stable_and_bounded() {
    let sheet = sheet_id(11);
    let mut engine = FormulaEngine::new();
    engine.register_sheet(sheet, "Trace").expect("sheet");
    engine.set_value(key(sheet, 0, 0), number(2.0)).expect("A1");
    engine.set_formula(key(sheet, 0, 1), "=A1+1").expect("B1");
    engine.set_formula(key(sheet, 0, 2), "=B1+1").expect("C1");
    engine.recalculate().expect("recalc");
    let trace = engine.trace(key(sheet, 0, 2), 3).expect("trace");
    assert_eq!(trace.nodes.len(), 3);
    assert_eq!(
        trace
            .nodes
            .iter()
            .map(|node| node.depth)
            .collect::<Vec<_>>(),
        [0, 1, 2]
    );
    assert!(matches!(
        engine.trace(key(sheet, 0, 2), 2),
        Err(FormulaEngineError::Limit {
            resource: "formula trace nodes",
            ..
        })
    ));
}

#[test]
fn workbook_commands_and_snapshot_rebuild_derive_cached_values_from_source() {
    let sheet = sheet_id(12);
    let mut workbook = Workbook::new(42).expect("workbook");
    workbook
        .apply_batch(&AtomicBatch::from_commands(vec![
            Command::CreateSheet {
                id: sheet,
                name: "Snapshot".into(),
            },
            Command::SetCells {
                sheet_id: sheet,
                anchor: CellCoord::new(0, 0),
                cells: CellBlock::new(
                    1,
                    2,
                    vec![
                        Cell::from_value(number(1.0)),
                        Cell::formula("=A1*2", number(2.0)).expect("formula"),
                    ],
                )
                .expect("cells"),
            },
        ]))
        .expect("seed workbook");

    workbook
        .apply_batch(&AtomicBatch::from_commands(vec![Command::SetCells {
            sheet_id: sheet,
            anchor: CellCoord::new(0, 0),
            cells: CellBlock::new(1, 1, vec![Cell::from_value(number(3.0))]).expect("input edit"),
        }]))
        .expect("canonical formula-aware edit");
    assert_eq!(
        workbook
            .sheet(sheet)
            .and_then(|sheet| sheet.cell(CellCoord::new(0, 1)))
            .map(Cell::value),
        Some(&number(6.0))
    );

    let bytes = encode_snapshot(&workbook).expect("snapshot");
    let restored_workbook = decode_snapshot(&bytes).expect("decode");
    let restored_engine = FormulaEngine::from_workbook(&restored_workbook).expect("rebuild graph");
    assert_eq!(
        restored_engine.formula_source(key(sheet, 0, 1)),
        Some("=A1*2")
    );
    assert_eq!(number_at(&restored_engine, key(sheet, 0, 1)), 6.0);
    assert_eq!(restored_engine.stats().dirty_formula_cells, 0);
}

#[test]
fn million_dense_non_formula_cells_do_not_enter_the_formula_graph() {
    const CELL_COUNT: usize = 1_000_000;
    let sheet = sheet_id(156);
    let mut workbook = Workbook::new(42).expect("workbook");
    let primitive = Cell::from_value(number(7.0));
    workbook
        .apply_batch(&AtomicBatch::from_commands(vec![
            Command::CreateSheet {
                id: sheet,
                name: "Dense primitives".into(),
            },
            Command::SetCells {
                sheet_id: sheet,
                anchor: CellCoord::new(0, 0),
                cells: CellBlock::new(1_000, 1_000, vec![primitive; CELL_COUNT])
                    .expect("dense block"),
            },
        ]))
        .expect("dense write");

    for engine in [
        &workbook.formula_engine,
        &FormulaEngine::from_workbook(&workbook).expect("sparse rebuild"),
    ] {
        assert_eq!(engine.stats().tracked_cells, 0);
        assert_eq!(engine.stats().formula_cells, 0);
        let allocation = engine.allocation_facts();
        assert_eq!(allocation.node_slots, 0);
        assert_eq!(allocation.node_capacity, 0);
        assert_eq!(allocation.node_index_capacity, 0);
        assert_eq!(allocation.hydration_queue_slots, 0);
        assert_eq!(allocation.hydration_queue_capacity, 0);
        assert_eq!(allocation.cached_value_utf8_bytes, 0);
    }
}

#[test]
fn hydrated_empty_precedents_are_not_rescanned_by_unrelated_edits() {
    let sheet = sheet_id(157);
    let mut workbook = Workbook::new(42).expect("workbook");
    workbook
        .apply_batch(&AtomicBatch::from_commands(vec![
            Command::CreateSheet {
                id: sheet,
                name: "Sparse formula graph".into(),
            },
            Command::SetCells {
                sheet_id: sheet,
                anchor: CellCoord::new(0, 1),
                cells: CellBlock::new(
                    1,
                    1,
                    vec![Cell::formula("=COUNT(A1:A10000)", CellValue::Empty).expect("formula")],
                )
                .expect("formula block"),
            },
        ]))
        .expect("seed");
    assert_eq!(workbook.formula_engine.stats().tracked_cells, 10_001);
    assert_eq!(
        workbook
            .formula_engine
            .allocation_facts()
            .hydration_queue_slots,
        0
    );

    workbook
        .apply_batch(&AtomicBatch::from_commands(vec![Command::SetCells {
            sheet_id: sheet,
            anchor: CellCoord::new(0, 2),
            cells: CellBlock::new(1, 1, vec![Cell::from("unrelated")]).expect("point edit"),
        }]))
        .expect("unrelated edit");
    assert_eq!(workbook.formula_engine.stats().tracked_cells, 10_001);
    assert_eq!(
        workbook
            .formula_engine
            .allocation_facts()
            .hydration_queue_slots,
        0
    );
}

#[test]
fn command_and_snapshot_boundaries_ignore_forged_formula_caches() {
    let sheet = sheet_id(120);
    let mut workbook = Workbook::new(42).expect("workbook");
    workbook
        .apply_batch(&AtomicBatch::from_commands(vec![
            Command::CreateSheet {
                id: sheet,
                name: "Authoritative source".into(),
            },
            Command::SetCells {
                sheet_id: sheet,
                anchor: CellCoord::new(0, 0),
                cells: CellBlock::new(
                    1,
                    1,
                    vec![Cell::formula("=1+1", number(999.0)).expect("formula")],
                )
                .expect("cell"),
            },
        ]))
        .expect("formula-aware command");
    assert_eq!(
        workbook
            .sheet(sheet)
            .and_then(|sheet| sheet.cell(CellCoord::new(0, 0)))
            .map(Cell::value),
        Some(&number(2.0))
    );

    // Simulate an untrusted v1 snapshot producer by bypassing the command
    // boundary inside this crate. Decode must still derive the cache from the
    // authored source before exposing the workbook.
    workbook.sheets.get_mut(&sheet).expect("sheet").set_cell(
        CellCoord::new(0, 0),
        Cell::formula("=1+1", number(777.0)).expect("forged cache"),
    );
    let restored = decode_snapshot(&encode_snapshot(&workbook).expect("encode forged"))
        .expect("decode and normalize");
    assert_eq!(
        restored
            .sheet(sheet)
            .and_then(|sheet| sheet.cell(CellCoord::new(0, 0)))
            .map(Cell::value),
        Some(&number(2.0))
    );
}

#[test]
fn rejected_formula_recalculation_leaves_workbook_and_engine_atomic() {
    let sheet = sheet_id(122);
    let mut workbook = Workbook::new(42).expect("workbook");
    workbook
        .apply_batch(&AtomicBatch::from_commands(vec![
            Command::CreateSheet {
                id: sheet,
                name: "Atomic".into(),
            },
            Command::SetCells {
                sheet_id: sheet,
                anchor: CellCoord::new(0, 0),
                cells: CellBlock::new(
                    1,
                    2,
                    vec![
                        Cell::from("a".repeat(20_000)),
                        Cell::from("b".repeat(20_000)),
                    ],
                )
                .expect("inputs"),
            },
        ]))
        .expect("seed");
    let before = encode_snapshot(&workbook).expect("before");
    let rejected = workbook.apply_batch(&AtomicBatch::from_commands(vec![Command::SetCells {
        sheet_id: sheet,
        anchor: CellCoord::new(0, 2),
        cells: CellBlock::new(
            1,
            1,
            vec![Cell::formula("=A1&B1", CellValue::Empty).expect("formula")],
        )
        .expect("cell"),
    }]));
    assert!(matches!(
        rejected,
        Err(crate::BatchError {
            kind: crate::CommandErrorKind::Formula(FormulaEngineError::Limit {
                resource: "formula result UTF-16 units",
                ..
            }),
            ..
        })
    ));
    assert_eq!(encode_snapshot(&workbook).expect("after rejection"), before);

    workbook
        .apply_batch(&AtomicBatch::from_commands(vec![Command::SetCells {
            sheet_id: sheet,
            anchor: CellCoord::new(0, 2),
            cells: CellBlock::new(
                1,
                1,
                vec![Cell::formula("=LEFT(A1,2)", CellValue::Empty).expect("formula")],
            )
            .expect("cell"),
        }]))
        .expect("engine restored after rejection");
    assert_eq!(
        workbook
            .sheet(sheet)
            .and_then(|sheet| sheet.cell(CellCoord::new(0, 2)))
            .map(Cell::value),
        Some(&CellValue::Text("aa".into()))
    );
}

#[test]
fn snapshot_rebuild_forward_reference_remains_incrementally_reachable() {
    let sheet = sheet_id(121);
    let mut workbook = Workbook::new(42).expect("workbook");
    workbook
        .apply_batch(&AtomicBatch::from_commands(vec![
            Command::CreateSheet {
                id: sheet,
                name: "Forward".into(),
            },
            Command::SetCells {
                sheet_id: sheet,
                anchor: CellCoord::new(0, 0),
                cells: CellBlock::new(
                    2,
                    1,
                    vec![
                        Cell::formula("=A2", number(1.0)).expect("dependent"),
                        Cell::formula("=1", number(1.0)).expect("precedent"),
                    ],
                )
                .expect("formulas"),
            },
        ]))
        .expect("seed");
    let mut engine = FormulaEngine::from_workbook(&workbook).expect("restore");
    assert_eq!(engine.stats().dirty_formula_cells, 0);
    engine
        .set_formula(key(sheet, 1, 0), "=2")
        .expect("change precedent");
    let receipt = engine.recalculate().expect("recalculate");
    assert_eq!(receipt.evaluated_cells, 2);
    assert_eq!(number_at(&engine, key(sheet, 0, 0)), 2.0);
}

#[test]
fn renamed_sheet_sources_survive_snapshot_graph_rebuild() {
    let inputs = sheet_id(13);
    let output = sheet_id(14);
    let mut workbook = Workbook::new(42).expect("workbook");
    workbook
        .apply_batch(&AtomicBatch::from_commands(vec![
            Command::CreateSheet {
                id: inputs,
                name: "Old".into(),
            },
            Command::CreateSheet {
                id: output,
                name: "Output".into(),
            },
            Command::SetCells {
                sheet_id: inputs,
                anchor: CellCoord::new(0, 0),
                cells: CellBlock::new(1, 1, vec![Cell::from_value(number(4.0))]).expect("input"),
            },
            Command::SetCells {
                sheet_id: output,
                anchor: CellCoord::new(0, 0),
                cells: CellBlock::new(
                    1,
                    1,
                    vec![Cell::formula("=Old!A1", number(4.0)).expect("formula")],
                )
                .expect("output"),
            },
        ]))
        .expect("seed workbook");
    workbook
        .apply_batch(&AtomicBatch::from_commands(vec![Command::RenameSheet {
            id: inputs,
            name: "New Name".into(),
        }]))
        .expect("workbook rename");

    let restored_workbook =
        decode_snapshot(&encode_snapshot(&workbook).expect("encode")).expect("decode");
    let mut restored = FormulaEngine::from_workbook(&restored_workbook).expect("engine rebuild");
    assert_eq!(
        restored.formula_source(key(output, 0, 0)),
        Some("='New Name'!A1")
    );
    restored
        .set_value(key(inputs, 0, 0), number(5.0))
        .expect("input edit");
    restored.recalculate().expect("recalc");
    assert_eq!(number_at(&restored, key(output, 0, 0)), 5.0);
}

#[test]
fn deleting_a_sheet_turns_existing_precedents_into_reference_tombstones() {
    let inputs = sheet_id(15);
    let output = sheet_id(16);
    let mut engine = FormulaEngine::new();
    engine.register_sheet(inputs, "Inputs").expect("inputs");
    engine.register_sheet(output, "Output").expect("output");
    engine
        .set_value(key(inputs, 0, 0), number(1.0))
        .expect("input");
    engine
        .set_formula(key(output, 0, 0), "=Inputs!A1")
        .expect("formula");
    engine.recalculate().expect("initial");
    engine.delete_sheet(inputs).expect("delete");
    let receipt = engine.recalculate().expect("reference recalc");
    assert_eq!(receipt.evaluated_cells, 1);
    assert_eq!(engine.value(key(inputs, 0, 0)), None);
    assert_eq!(
        engine.value(key(output, 0, 0)),
        Some(&CellValue::Error(FormulaError::Reference))
    );
    assert!(matches!(
        engine.register_sheet(inputs, "Reused"),
        Err(FormulaEngineError::DuplicateSheetId)
    ));
}

#[test]
fn deleted_sheet_reference_cannot_resurrect_by_name_after_snapshot() {
    let deleted = sheet_id(151);
    let replacement = sheet_id(152);
    let output = sheet_id(153);
    let mut workbook = Workbook::new(42).expect("workbook");
    workbook
        .apply_batch(&AtomicBatch::from_commands(vec![
            Command::CreateSheet {
                id: deleted,
                name: "Inputs".into(),
            },
            Command::CreateSheet {
                id: output,
                name: "Output".into(),
            },
            Command::SetCells {
                sheet_id: deleted,
                anchor: CellCoord::new(0, 0),
                cells: CellBlock::new(1, 1, vec![Cell::from_value(number(3.0))]).expect("input"),
            },
            Command::SetCells {
                sheet_id: output,
                anchor: CellCoord::new(0, 0),
                cells: CellBlock::new(
                    1,
                    1,
                    vec![Cell::formula("=Inputs!A1", number(999.0)).expect("formula")],
                )
                .expect("output"),
            },
        ]))
        .expect("seed");
    workbook
        .apply_batch(&AtomicBatch::from_commands(vec![
            Command::DeleteSheet { id: deleted },
            Command::CreateSheet {
                id: replacement,
                name: "Inputs".into(),
            },
            Command::SetCells {
                sheet_id: replacement,
                anchor: CellCoord::new(0, 0),
                cells: CellBlock::new(1, 1, vec![Cell::from_value(number(88.0))])
                    .expect("replacement"),
            },
        ]))
        .expect("replace sheet");

    let restored = decode_snapshot(&encode_snapshot(&workbook).expect("encode")).expect("decode");
    let formula = restored
        .sheet(output)
        .and_then(|sheet| sheet.cell(CellCoord::new(0, 0)))
        .expect("formula");
    assert_eq!(formula.formula_source(), Some("=#REF!A1"));
    assert_eq!(formula.value(), &CellValue::Error(FormulaError::Reference));
}

#[test]
fn unicode_case_insensitive_sheet_rename_rewrites_formula_source() {
    let input = sheet_id(154);
    let output = sheet_id(155);
    let mut workbook = Workbook::new(42).expect("workbook");
    workbook
        .apply_batch(&AtomicBatch::from_commands(vec![
            Command::CreateSheet {
                id: input,
                name: "Ångström".into(),
            },
            Command::CreateSheet {
                id: output,
                name: "Output".into(),
            },
            Command::SetCells {
                sheet_id: input,
                anchor: CellCoord::new(0, 0),
                cells: CellBlock::new(1, 1, vec![Cell::from_value(number(5.0))]).expect("input"),
            },
            Command::SetCells {
                sheet_id: output,
                anchor: CellCoord::new(0, 0),
                cells: CellBlock::new(
                    1,
                    1,
                    vec![Cell::formula("='ångström'!A1", CellValue::Empty).expect("formula")],
                )
                .expect("output"),
            },
        ]))
        .expect("seed");
    workbook
        .apply_batch(&AtomicBatch::from_commands(vec![Command::RenameSheet {
            id: input,
            name: "Measurements".into(),
        }]))
        .expect("rename");
    let formula = workbook
        .sheet(output)
        .and_then(|sheet| sheet.cell(CellCoord::new(0, 0)))
        .expect("formula");
    assert_eq!(formula.formula_source(), Some("='Measurements'!A1"));
    assert_eq!(formula.value(), &number(5.0));
}
