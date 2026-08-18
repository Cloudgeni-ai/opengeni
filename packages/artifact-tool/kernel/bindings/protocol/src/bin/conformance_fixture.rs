#![forbid(unsafe_code)]

use opengeni_artifact_kernel::{
    decode_snapshot, encode_snapshot, AtomicBatch, Cell, CellBlock, CellCoord, CellValue, Command,
    FormulaError, Number, SnapshotError, StableId, Workbook,
};
use opengeni_artifact_kernel_binding_protocol::{
    build_identity, encode_command_batch, encode_namespace, encode_viewport_query, query,
    ViewportQuery,
};

fn main() {
    let namespace = 0x0123_4567_89ab_cdef;
    let sheet_id = StableId::from_parts(namespace, 50);
    let command = AtomicBatch::from_commands(vec![
        Command::CreateSheet {
            id: sheet_id,
            name: "Conformance ✓".into(),
        },
        Command::SetCells {
            sheet_id,
            anchor: CellCoord::new(255, 255),
            cells: CellBlock::new(
                2,
                3,
                vec![
                    Cell::from("Revenue"),
                    Cell::from_value(CellValue::Number(Number::new(12.5).expect("finite"))),
                    Cell::from(true),
                    Cell::formula("=B1*2").expect("formula"),
                    Cell::from_value(CellValue::Error(FormulaError::NotAvailable)),
                    Cell::from("done"),
                ],
            )
            .expect("cell block"),
        },
    ]);

    let mut workbook = Workbook::new(namespace).expect("workbook");
    let initial = encode_snapshot(&workbook).expect("initial snapshot");
    workbook.apply_batch(&command).expect("direct apply");
    let expected = encode_snapshot(&workbook).expect("expected snapshot");
    let negative_zero_snapshot = negative_zero_snapshot();
    let formula = formula_fixture();

    println!(
        "{{\"buildIdentity\":\"{}\",\"namespace\":\"{}\",\"command\":\"{}\",\"initial\":\"{}\",\"expected\":\"{}\",\"negativeZeroSnapshot\":\"{}\",\"formulaNamespace\":\"{}\",\"formulaInitialCommand\":\"{}\",\"formulaIncrementalCommand\":\"{}\",\"formulaInitial\":\"{}\",\"formulaAfterInitial\":\"{}\",\"formulaAfterIncremental\":\"{}\",\"formulaQuery\":\"{}\",\"formulaProjection\":\"{}\"}}",
        hex(build_identity()),
        hex(&encode_namespace(namespace)),
        hex(&encode_command_batch(&command).expect("command envelope")),
        hex(&initial),
        hex(&expected),
        hex(&negative_zero_snapshot),
        hex(&encode_namespace(formula.namespace)),
        hex(&encode_command_batch(&formula.initial_command).expect("formula initial command")),
        hex(
            &encode_command_batch(&formula.incremental_command)
                .expect("formula incremental command")
        ),
        hex(&formula.initial),
        hex(&formula.after_initial),
        hex(&formula.after_incremental),
        hex(&formula.query),
        hex(&formula.projection),
    );
}

struct FormulaFixture {
    namespace: u64,
    initial_command: AtomicBatch,
    incremental_command: AtomicBatch,
    initial: Vec<u8>,
    after_initial: Vec<u8>,
    after_incremental: Vec<u8>,
    query: Vec<u8>,
    projection: Vec<u8>,
}

const DEPENDENCY_CHAIN_LENGTH: usize = 128;
const MATH_FORMULAS: [&str; 31] = [
    "=1/(1+0.1)^4",
    "=POWER(1.1,-4)",
    "=POWER(2,-1024)",
    "=POWER(2,-3)",
    "=POWER(2,-0)",
    "=POWER(2,0)",
    "=POWER(2,1)",
    "=POWER(2,2)",
    "=POWER(2,3)",
    "=POWER(2,4)",
    "=POWER(1,9007199254740991)",
    "=POWER(2,0.5)",
    "=POWER(4,-0.5)",
    "=POWER(-2,3)",
    "=POWER(-2,0.5)",
    "=POWER(-0,3)",
    "=POWER(0,3)",
    "=POWER(0,-1)",
    "=POWER(5E-324,1)",
    "=POWER(1E308,2)",
    "=ROUND(2.55,1)",
    "=ROUNDUP(-1.21,1)",
    "=ROUNDDOWN(-1.29,1)",
    "=ROUND(1.2345,309)",
    "=ROUND(1.2345,-324)",
    "=SQRT(9)",
    "=SQRT(-1)",
    "=SQRT(5E-324)",
    "=-0",
    "=POWER(-0,-3)",
    "=1/0",
];

fn formula_fixture() -> FormulaFixture {
    let namespace = 0x0a11_ce55_1a7e_0001;
    let inputs = StableId::from_parts(namespace, 50);
    let output = StableId::from_parts(namespace, 51);
    let formula = |source: &str| Cell::formula(source).expect("formula");
    let initial_command = AtomicBatch::from_commands(vec![
        Command::CreateSheet {
            id: inputs,
            name: "Inputs Q1".into(),
        },
        Command::CreateSheet {
            id: output,
            name: "Calculated".into(),
        },
        Command::SetCells {
            sheet_id: inputs,
            anchor: CellCoord::new(0, 0),
            cells: CellBlock::new(
                3,
                1,
                [1.0, 2.0, 3.0]
                    .into_iter()
                    .map(|value| {
                        Cell::from_value(CellValue::Number(
                            Number::new(value).expect("finite input"),
                        ))
                    })
                    .collect(),
            )
            .expect("formula inputs"),
        },
        Command::SetCells {
            sheet_id: output,
            anchor: CellCoord::new(8, 0),
            cells: CellBlock::new(
                MATH_FORMULAS.len() as u32,
                1,
                MATH_FORMULAS.into_iter().map(formula).collect(),
            )
            .expect("deterministic math formulas"),
        },
        Command::SetCells {
            sheet_id: output,
            anchor: CellCoord::new(0, 0),
            cells: CellBlock::new(
                6,
                1,
                ["SUM", "AVERAGE", "MIN", "MAX", "COUNT", "COUNTA"]
                    .into_iter()
                    .map(|function| formula(&format!("={function}('Inputs Q1'!A1:A3)")))
                    .collect(),
            )
            .expect("cross-sheet aggregate formulas"),
        },
        Command::SetCells {
            sheet_id: output,
            anchor: CellCoord::new(0, 1),
            cells: CellBlock::new(
                3,
                1,
                vec![formula("=B2+1"), formula("=B1+1"), formula("=B1+1")],
            )
            .expect("cycle formulas"),
        },
        Command::SetCells {
            sheet_id: output,
            anchor: CellCoord::new(6, 0),
            cells: CellBlock::new(2, 1, vec![formula("=1/0"), formula("=A7+1")])
                .expect("error formulas"),
        },
        Command::SetCells {
            sheet_id: output,
            anchor: CellCoord::new(0, 2),
            cells: CellBlock::new(
                DEPENDENCY_CHAIN_LENGTH as u32,
                1,
                (0..DEPENDENCY_CHAIN_LENGTH)
                    .map(|row| {
                        if row == 0 {
                            formula("=1")
                        } else {
                            formula(&format!("=C{row}+1"))
                        }
                    })
                    .collect(),
            )
            .expect("large dependency chain"),
        },
    ]);
    let incremental_command = AtomicBatch::from_commands(vec![Command::SetCells {
        sheet_id: inputs,
        anchor: CellCoord::new(1, 0),
        cells: CellBlock::new(
            1,
            1,
            vec![Cell::from_value(CellValue::Number(
                Number::new(8.0).expect("finite edit"),
            ))],
        )
        .expect("incremental input"),
    }]);

    let mut workbook = Workbook::new(namespace).expect("formula workbook");
    let initial = encode_snapshot(&workbook).expect("formula initial snapshot");
    workbook
        .apply_batch(&initial_command)
        .expect("formula initial apply");
    assert_formula_fixture(&workbook, output, [6.0, 2.0, 1.0, 3.0, 3.0, 3.0]);
    let after_initial = encode_snapshot(&workbook).expect("formula initial result");
    workbook
        .apply_batch(&incremental_command)
        .expect("formula incremental apply");
    assert_formula_fixture(&workbook, output, [12.0, 4.0, 1.0, 8.0, 3.0, 3.0]);
    let after_incremental = encode_snapshot(&workbook).expect("formula incremental result");
    assert_eq!(
        workbook
            .sheet(output)
            .expect("formula output")
            .cell(CellCoord::new(8, 0))
            .and_then(|cell| match cell.value() {
                CellValue::Number(value) => Some(value.get().to_bits()),
                _ => None,
            }),
        Some(0x3fe5_db3f_08b0_ab7d),
        "incident discount factor bits"
    );
    assert_eq!(
        workbook
            .sheet(output)
            .expect("formula output")
            .cell(CellCoord::new(10, 0))
            .and_then(|cell| match cell.value() {
                CellValue::Number(value) => Some(value.get().to_bits()),
                _ => None,
            }),
        Some(0x0004_0000_0000_0000),
        "subnormal underflow bits"
    );
    let query_bytes = encode_viewport_query(ViewportQuery {
        sheet_id: output,
        start: CellCoord::new(0, 0),
        rows: DEPENDENCY_CHAIN_LENGTH as u32,
        columns: 3,
        max_cells: 192,
        max_bytes: 256 * 1024,
    })
    .expect("formula query");
    let projection = query(&after_incremental, &query_bytes).expect("formula projection");

    FormulaFixture {
        namespace,
        initial_command,
        incremental_command,
        initial,
        after_initial,
        after_incremental,
        query: query_bytes,
        projection,
    }
}

fn assert_formula_fixture(workbook: &Workbook, output: StableId, aggregates: [f64; 6]) {
    let sheet = workbook.sheet(output).expect("formula output sheet");
    for (row, expected) in aggregates.into_iter().enumerate() {
        assert_eq!(
            sheet.cell(CellCoord::new(row as u32, 0)).map(Cell::value),
            Some(&CellValue::Number(
                Number::new(expected).expect("finite aggregate")
            )),
            "aggregate row {row}"
        );
    }
    for row in 0..3 {
        assert_eq!(
            sheet.cell(CellCoord::new(row, 1)).map(Cell::value),
            Some(&CellValue::Error(FormulaError::Custom("#CYCLE!".into())))
        );
    }
    for row in 6..8 {
        assert_eq!(
            sheet.cell(CellCoord::new(row, 0)).map(Cell::value),
            Some(&CellValue::Error(FormulaError::DivideByZero))
        );
    }
    assert_eq!(
        sheet
            .cell(CellCoord::new((DEPENDENCY_CHAIN_LENGTH - 1) as u32, 2))
            .map(Cell::value),
        Some(&CellValue::Number(
            Number::new(DEPENDENCY_CHAIN_LENGTH as f64).expect("finite chain result")
        ))
    );
    for row in [22, 25, 27, 31, 32, 34, 37] {
        assert_eq!(
            sheet.cell(CellCoord::new(row, 0)).map(Cell::value),
            Some(&CellValue::Error(FormulaError::Number)),
            "numeric error row {row}"
        );
    }
}

fn negative_zero_snapshot() -> Vec<u8> {
    const HEADER_BYTES: usize = 20;
    const CHECKSUM_BYTES: usize = 8;
    let namespace = 0x0fed_cba9_8765_4321;
    let sheet_id = StableId::from_parts(namespace, 50);
    let marker = 12_345.678_901_234_5_f64;
    let mut workbook = Workbook::new(namespace).expect("workbook");
    workbook
        .apply_batch(&AtomicBatch::from_commands(vec![
            Command::CreateSheet {
                id: sheet_id,
                name: "Negative zero fixture".into(),
            },
            Command::SetCells {
                sheet_id,
                anchor: CellCoord::new(0, 0),
                cells: CellBlock::new(
                    1,
                    1,
                    vec![Cell::from_value(CellValue::Number(
                        Number::new(marker).expect("finite marker"),
                    ))],
                )
                .expect("cell block"),
            },
        ]))
        .expect("fixture commands");
    let mut bytes = encode_snapshot(&workbook).expect("fixture snapshot");
    let payload_end = bytes.len() - CHECKSUM_BYTES;
    let marker_bytes = marker.to_bits().to_le_bytes();
    let positions = bytes[HEADER_BYTES..payload_end]
        .windows(marker_bytes.len())
        .enumerate()
        .filter_map(|(offset, candidate)| (candidate == marker_bytes).then_some(offset))
        .collect::<Vec<_>>();
    assert_eq!(positions.len(), 1, "negative-zero marker must be unique");
    let number_offset = HEADER_BYTES + positions[0];
    bytes[number_offset..number_offset + 8].copy_from_slice(&(-0.0f64).to_bits().to_le_bytes());
    let checksum = fnv_checksum(&bytes[HEADER_BYTES..payload_end]);
    bytes[payload_end..].copy_from_slice(&checksum.to_le_bytes());
    assert_eq!(
        decode_snapshot(&bytes),
        Err(SnapshotError::NonCanonical("number uses negative zero"))
    );
    bytes
}

fn fnv_checksum(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
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
