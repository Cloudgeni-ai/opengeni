#![no_main]

use libfuzzer_sys::fuzz_target;
use opengeni_artifact_kernel::{
    decode_snapshot, encode_snapshot, AtomicBatch, Cell, CellBlock, CellCoord, CellRange, Command,
    StableId, Workbook,
};

const MAX_INPUT_BYTES: usize = 4_096;

fuzz_target!(|input: &[u8]| {
    let input = &input[..input.len().min(MAX_INPUT_BYTES)];
    let namespace = u64::from(input.first().copied().unwrap_or(1)).saturating_add(1);
    let sheet_id = StableId::from_parts(namespace, 10);
    let missing_id = StableId::from_parts(namespace, 11);
    let mut workbook = Workbook::new(namespace).expect("bounded namespace");
    workbook
        .apply_batch(&AtomicBatch::from_commands(vec![Command::CreateSheet {
            id: sheet_id,
            name: "Fuzz".into(),
        }]))
        .expect("initial sheet");

    for chunk in input.get(1..).unwrap_or_default().chunks(8) {
        let byte = |index: usize| chunk.get(index).copied().unwrap_or(0);
        let row = ((u32::from(byte(1)) << 8) | u32::from(byte(2))) * 16;
        let column = u32::from(byte(3));
        let command = match byte(0) % 4 {
            0 => Command::SetCells {
                sheet_id,
                anchor: CellCoord::new(row, column),
                cells: CellBlock::new(1, 1, vec![Cell::from(format!("{}:{}", byte(4), byte(5)))])
                    .expect("one cell"),
            },
            1 => Command::ClearRange {
                sheet_id,
                range: CellRange::new(
                    CellCoord::new(row, column),
                    CellCoord::new(row.saturating_add(u32::from(byte(4) % 8)), column),
                ),
            },
            2 => Command::RenameSheet {
                id: sheet_id,
                name: format!("Fuzz-{}-{}", byte(4), byte(5)),
            },
            _ => Command::SetCells {
                sheet_id: missing_id,
                anchor: CellCoord::new(row, column),
                cells: CellBlock::new(1, 1, vec![Cell::from("invalid")]).expect("one cell"),
            },
        };

        let before = encode_snapshot(&workbook).expect("snapshot before operation");
        let outcome = workbook.apply_batch(&AtomicBatch::from_commands(vec![command]));
        if outcome.is_err() {
            assert_eq!(
                encode_snapshot(&workbook).expect("snapshot after rejected operation"),
                before,
                "rejected batch changed state"
            );
        }
        let snapshot = encode_snapshot(&workbook).expect("snapshot after operation");
        let restored = decode_snapshot(&snapshot).expect("operation result must decode");
        assert_eq!(restored, workbook);
    }
});
