#![no_main]

use libfuzzer_sys::fuzz_target;
use opengeni_artifact_kernel::{
    decode_collaboration_snapshot, encode_collaboration_snapshot, CausalDot, CausalFrontier, Cell,
    CellBlock, CellCoord, CellRange, CollaborationCommand, CollaborationOperation,
    CollaborationTransaction, CollaborativeWorkbook, OperationId, ReplicaId, SheetGeneration,
    StableId, TransactionId,
};

const MAX_INPUT_BYTES: usize = 4_096;

fuzz_target!(|input: &[u8]| {
    let input = &input[..input.len().min(MAX_INPUT_BYTES)];
    let model_namespace = 700;
    let creator = ReplicaId::new(701).expect("creator");
    let sheet_id = StableId::from_parts(model_namespace, 10);
    let creation_id = OperationId::from_stable_id(StableId::from_parts(701, 100));
    let create = CollaborationTransaction::new(
        TransactionId::from_stable_id(StableId::from_parts(701, 1)),
        CausalDot::new(creator, 1).expect("create dot"),
        CausalFrontier::new(),
        vec![CollaborationOperation::new(
            creation_id,
            CollaborationCommand::CreateSheet {
                sheet_id,
                name: "Fuzz".into(),
                after: None,
            },
        )],
    );
    let base = CausalFrontier::from_entries([(creator, 1)]).expect("base");
    let mut transactions = Vec::new();
    let mut lane_counters = [0u64; 4];
    let mut first_data_operation = None;
    for (index, chunk) in input.chunks(8).enumerate() {
        let byte = |offset: usize| chunk.get(offset).copied().unwrap_or(0);
        let lane = usize::from(byte(6) % 4);
        lane_counters[lane] += 1;
        let counter = lane_counters[lane];
        let replica = ReplicaId::new(1_000 + lane as u64).expect("replica");
        let row = (u32::from(byte(1)) << 8) | u32::from(byte(2));
        let column = u32::from(byte(3));
        let command = if byte(0) & 1 == 0 {
            CollaborationCommand::SetCells {
                sheet: SheetGeneration::new(sheet_id, creation_id),
                anchor: CellCoord::new(row, column),
                cells: CellBlock::new(1, 1, vec![Cell::from(format!("{}:{}", byte(4), byte(5)))])
                    .expect("cell"),
            }
        } else {
            CollaborationCommand::ClearRange {
                sheet: SheetGeneration::new(sheet_id, creation_id),
                range: CellRange::new(
                    CellCoord::new(row, column),
                    CellCoord::new(
                        row.saturating_add(u32::from(byte(4) % 8)),
                        column.saturating_add(u32::from(byte(5) % 8)),
                    ),
                ),
            }
        };
        let mut causal_entries = vec![(creator, 1)];
        if counter > 1 {
            causal_entries.push((replica, counter - 1));
        }
        let causal_base = CausalFrontier::from_entries(causal_entries).expect("causal base");
        let operation_id =
            OperationId::from_stable_id(StableId::from_parts(8_001, index as u64 + 1));
        let dot = CausalDot::new(replica, counter).expect("dot");
        if first_data_operation.is_none() {
            first_data_operation = Some((operation_id, dot, causal_base.clone()));
        }
        transactions.push(CollaborationTransaction::new(
            TransactionId::from_stable_id(StableId::from_parts(8_000, index as u64 + 1)),
            dot,
            causal_base,
            vec![CollaborationOperation::new(operation_id, command)],
        ));
    }

    let delete_replica = ReplicaId::new(9_100).expect("delete replica");
    let delete_operation = OperationId::from_stable_id(StableId::from_parts(9_101, 1));
    transactions.extend([
        CollaborationTransaction::new(
            TransactionId::from_stable_id(StableId::from_parts(9_000, 1)),
            CausalDot::new(ReplicaId::new(9_000).expect("rename replica"), 1).expect("rename dot"),
            base.clone(),
            vec![CollaborationOperation::new(
                OperationId::from_stable_id(StableId::from_parts(9_001, 1)),
                CollaborationCommand::RenameSheet {
                    sheet: SheetGeneration::new(sheet_id, creation_id),
                    name: format!("Fuzz {}", input.first().copied().unwrap_or(0)),
                },
            )],
        ),
        CollaborationTransaction::new(
            TransactionId::from_stable_id(StableId::from_parts(9_100, 1)),
            CausalDot::new(delete_replica, 1).expect("delete dot"),
            base.clone(),
            vec![CollaborationOperation::new(
                delete_operation,
                CollaborationCommand::DeleteSheet {
                    sheet: SheetGeneration::new(sheet_id, creation_id),
                },
            )],
        ),
        CollaborationTransaction::new(
            TransactionId::from_stable_id(StableId::from_parts(9_100, 2)),
            CausalDot::new(delete_replica, 2).expect("undo-delete dot"),
            CausalFrontier::from_entries([(creator, 1), (delete_replica, 1)])
                .expect("undo-delete base"),
            vec![CollaborationOperation::new(
                OperationId::from_stable_id(StableId::from_parts(9_101, 2)),
                CollaborationCommand::Undo {
                    target: delete_operation,
                },
            )],
        ),
    ]);
    if let Some((target, target_dot, target_base)) = first_data_operation {
        let mut undo_base: Vec<_> = target_base.iter().collect();
        if let Some((_, counter)) = undo_base
            .iter_mut()
            .find(|(replica, _)| *replica == target_dot.replica())
        {
            *counter = target_dot.counter();
        } else {
            undo_base.push((target_dot.replica(), target_dot.counter()));
        }
        transactions.push(CollaborationTransaction::new(
            TransactionId::from_stable_id(StableId::from_parts(9_200, 1)),
            CausalDot::new(ReplicaId::new(9_200).expect("undo replica"), 1).expect("undo dot"),
            CausalFrontier::from_entries(undo_base).expect("undo base"),
            vec![CollaborationOperation::new(
                OperationId::from_stable_id(StableId::from_parts(9_201, 1)),
                CollaborationCommand::Undo { target },
            )],
        ));
    }

    let mut forward = CollaborativeWorkbook::new(model_namespace).expect("forward");
    let mut reverse = CollaborativeWorkbook::new(model_namespace).expect("reverse");
    forward
        .apply_transaction(create.clone())
        .expect("forward create");
    reverse.apply_transaction(create).expect("reverse create");
    for transaction in &transactions {
        forward
            .apply_transaction(transaction.clone())
            .expect("forward apply");
        forward
            .apply_transaction(transaction.clone())
            .expect("forward duplicate");
    }
    for transaction in transactions.iter().rev() {
        reverse
            .apply_transaction(transaction.clone())
            .expect("reverse apply");
    }
    let forward_snapshot = encode_collaboration_snapshot(&forward).expect("forward snapshot");
    let reverse_snapshot = encode_collaboration_snapshot(&reverse).expect("reverse snapshot");
    assert_eq!(forward_snapshot, reverse_snapshot);
    assert_eq!(
        decode_collaboration_snapshot(&forward_snapshot).expect("snapshot round trip"),
        forward
    );
});
