use super::*;
use crate::{CellBlock, CellRange, Number};
use std::collections::BTreeSet;

fn replica(value: u64) -> ReplicaId {
    ReplicaId::new(value).expect("replica")
}

fn dot(replica_id: u64, counter: u64) -> CausalDot {
    CausalDot::new(replica(replica_id), counter).expect("dot")
}

fn frontier(entries: &[(u64, u64)]) -> CausalFrontier {
    CausalFrontier::from_entries(
        entries
            .iter()
            .map(|(replica_id, counter)| (replica(*replica_id), *counter)),
    )
    .expect("frontier")
}

fn transaction(
    id: u64,
    replica_id: u64,
    counter: u64,
    base: &[(u64, u64)],
    operations: Vec<CollaborationOperation>,
) -> CollaborationTransaction {
    CollaborationTransaction::new(
        TransactionId::from_stable_id(StableId::from_parts(90, id)),
        dot(replica_id, counter),
        frontier(base),
        operations,
    )
}

fn operation(id: u64, command: CollaborationCommand) -> CollaborationOperation {
    CollaborationOperation::new(
        OperationId::from_stable_id(StableId::from_parts(91, id)),
        command,
    )
}

fn sheet_id(counter: u64) -> StableId {
    StableId::from_parts(77, counter)
}

fn generation(sheet: StableId, creation_operation: u64) -> SheetGeneration {
    SheetGeneration::new(
        sheet,
        OperationId::from_stable_id(StableId::from_parts(91, creation_operation)),
    )
}

fn create_sheet_transaction() -> CollaborationTransaction {
    transaction(
        1,
        1,
        1,
        &[],
        vec![operation(
            1,
            CollaborationCommand::CreateSheet {
                sheet_id: sheet_id(10),
                name: "Data".into(),
                after: None,
            },
        )],
    )
}

fn set_cell_transaction(
    transaction_id: u64,
    operation_id: u64,
    replica_id: u64,
    counter: u64,
    base: &[(u64, u64)],
    value: &str,
) -> CollaborationTransaction {
    transaction(
        transaction_id,
        replica_id,
        counter,
        base,
        vec![operation(
            operation_id,
            CollaborationCommand::SetCells {
                sheet: generation(sheet_id(10), 1),
                anchor: CellCoord::new(0, 0),
                cells: CellBlock::new(1, 1, vec![Cell::from(value)]).expect("cell"),
            },
        )],
    )
}

fn cell_text(workbook: &CollaborativeWorkbook) -> Option<&str> {
    workbook
        .workbook()
        .sheet(sheet_id(10))
        .and_then(|sheet| sheet.cell(CellCoord::new(0, 0)))
        .and_then(|cell| match cell.value() {
            CellValue::Text(text) => Some(text.as_str()),
            _ => None,
        })
}

fn finite(value: f64) -> CellValue {
    CellValue::Number(Number::new(value).expect("finite"))
}

#[test]
fn missing_predecessor_is_deferred_then_applied_atomically() {
    let mut workbook = CollaborativeWorkbook::new(77).expect("workbook");
    workbook
        .apply_transaction(create_sheet_transaction())
        .expect("create");
    let second = set_cell_transaction(2, 2, 1, 2, &[(1, 1)], "second");
    let third = set_cell_transaction(3, 3, 1, 3, &[(1, 2)], "third");

    let receipt = workbook.apply_transaction(third).expect("defer");
    assert_eq!(receipt.disposition, TransactionDisposition::Deferred);
    assert_eq!(workbook.pending_transaction_count(), 1);
    assert_eq!(cell_text(&workbook), None);

    let receipt = workbook.apply_transaction(second).expect("fill gap");
    assert_eq!(receipt.newly_applied.len(), 2);
    assert_eq!(workbook.pending_transaction_count(), 0);
    assert_eq!(cell_text(&workbook), Some("third"));
    assert_eq!(workbook.frontier().counter(replica(1)), 3);
}

#[test]
fn authored_causal_base_must_include_dependencies_of_every_observed_dot() {
    let mut workbook = CollaborativeWorkbook::new(77).expect("workbook");
    workbook
        .apply_transaction(create_sheet_transaction())
        .expect("create");
    workbook
        .apply_transaction(set_cell_transaction(2, 2, 2, 1, &[(1, 1)], "observed"))
        .expect("dependent write");
    let before = encode_collaboration_snapshot(&workbook).expect("before");

    let invalid = transaction(
        3,
        3,
        1,
        &[(2, 1)],
        vec![operation(
            3,
            CollaborationCommand::CreateSheet {
                sheet_id: sheet_id(11),
                name: "Impossible cut".into(),
                after: None,
            },
        )],
    );
    assert_eq!(
        workbook.apply_transaction(invalid),
        Err(CollaborationError::CausalBaseNotClosed {
            dependency: dot(2, 1),
            missing: dot(1, 1),
        })
    );
    assert_eq!(
        encode_collaboration_snapshot(&workbook).expect("after"),
        before
    );
}

#[test]
fn long_reversed_offline_chain_drains_from_dependency_index() {
    const CHAIN: u64 = 2_000;
    let mut workbook = CollaborativeWorkbook::new(77).expect("workbook");
    workbook
        .apply_transaction(create_sheet_transaction())
        .expect("create");
    let mut transactions = Vec::with_capacity(CHAIN as usize);
    for counter in 1..=CHAIN {
        let mut base = vec![(1, 1)];
        if counter > 1 {
            base.push((2, counter - 1));
        }
        transactions.push(set_cell_transaction(
            10_000 + counter,
            20_000 + counter,
            2,
            counter,
            &base,
            &counter.to_string(),
        ));
    }
    for transaction in transactions.into_iter().rev() {
        let receipt = workbook
            .apply_transaction(transaction)
            .expect("offline transaction");
        if receipt.transaction_id == TransactionId::from_stable_id(StableId::from_parts(90, 10_001))
        {
            assert_eq!(receipt.newly_applied.len(), CHAIN as usize);
        }
    }
    assert_eq!(workbook.pending_transaction_count(), 0);
    assert_eq!(workbook.frontier().counter(replica(2)), CHAIN);
    assert_eq!(cell_text(&workbook), Some("2000"));
}

#[test]
fn one_dot_makes_overlapping_suboperations_visible_as_one_revision() {
    let mut workbook = CollaborativeWorkbook::new(77).expect("workbook");
    let sheet = sheet_id(10);
    let create_id = OperationId::from_stable_id(StableId::from_parts(91, 1));
    let transaction = transaction(
        1,
        1,
        1,
        &[],
        vec![
            CollaborationOperation::new(
                create_id,
                CollaborationCommand::CreateSheet {
                    sheet_id: sheet,
                    name: "Atomic".into(),
                    after: None,
                },
            ),
            operation(
                2,
                CollaborationCommand::SetCells {
                    sheet: SheetGeneration::new(sheet, create_id),
                    anchor: CellCoord::new(0, 0),
                    cells: CellBlock::new(
                        2,
                        2,
                        vec![
                            Cell::from("a"),
                            Cell::from("b"),
                            Cell::from("c"),
                            Cell::from("d"),
                        ],
                    )
                    .expect("block"),
                },
            ),
            operation(
                3,
                CollaborationCommand::ClearRange {
                    sheet: SheetGeneration::new(sheet, create_id),
                    range: CellRange::new(CellCoord::new(0, 0), CellCoord::new(0, 0)),
                },
            ),
        ],
    );
    let receipt = workbook
        .apply_transaction(transaction)
        .expect("atomic apply");
    assert_eq!(receipt.newly_applied.len(), 1);
    assert_eq!(workbook.workbook().revision(), 1);
    assert_eq!(workbook.frontier().counter(replica(1)), 1);
    assert_eq!(
        workbook
            .workbook()
            .sheet(sheet)
            .expect("sheet")
            .non_empty_cell_count(),
        3
    );
    assert_eq!(
        workbook
            .operations
            .values()
            .map(|record| record.dot)
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([dot(1, 1)])
    );
}

#[test]
fn exact_duplicates_are_noops_and_conflicting_reuse_is_rejected() {
    let mut workbook = CollaborativeWorkbook::new(77).expect("workbook");
    let create = create_sheet_transaction();
    workbook.apply_transaction(create.clone()).expect("create");
    let revision = workbook.workbook().revision();
    let duplicate = workbook
        .apply_transaction(create.clone())
        .expect("duplicate");
    assert_eq!(
        duplicate.disposition,
        TransactionDisposition::DuplicateApplied
    );
    assert_eq!(workbook.workbook().revision(), revision);

    let conflicting = CollaborationTransaction::new(
        create.id(),
        create.dot(),
        create.base().clone(),
        vec![operation(
            99,
            CollaborationCommand::CreateSheet {
                sheet_id: sheet_id(11),
                name: "Other".into(),
                after: None,
            },
        )],
    );
    assert!(matches!(
        workbook.apply_transaction(conflicting),
        Err(CollaborationError::TransactionIdConflict(_))
    ));
}

#[test]
fn explicit_local_entity_ids_fence_the_model_allocator() {
    let mut workbook = CollaborativeWorkbook::new(77).expect("workbook");
    workbook
        .apply_transaction(create_sheet_transaction())
        .expect("create");
    assert_eq!(
        workbook
            .workbook
            .allocate_id()
            .expect("next model id")
            .counter(),
        11
    );
}

#[test]
fn invalid_deferred_transaction_is_settled_without_poisoning_the_queue() {
    let mut workbook = CollaborativeWorkbook::new(77).expect("workbook");
    workbook
        .apply_transaction(create_sheet_transaction())
        .expect("create");
    let invalid = transaction(
        30,
        3,
        2,
        &[(1, 1), (3, 1)],
        vec![operation(
            30,
            CollaborationCommand::SetCells {
                sheet: SheetGeneration::new(
                    sheet_id(999),
                    OperationId::from_stable_id(StableId::from_parts(91, 999)),
                ),
                anchor: CellCoord::new(0, 0),
                cells: CellBlock::new(1, 1, vec![Cell::from("invalid")]).expect("cell"),
            },
        )],
    );
    assert_eq!(
        workbook
            .apply_transaction(invalid.clone())
            .expect("defer")
            .disposition,
        TransactionDisposition::Deferred
    );
    let predecessor = set_cell_transaction(31, 31, 3, 1, &[(1, 1)], "valid");
    let receipt = workbook
        .apply_transaction(predecessor)
        .expect("predecessor");
    assert_eq!(receipt.rejected_deferred.len(), 1);
    assert_eq!(receipt.rejected_deferred[0].transaction_id, invalid.id());
    assert_eq!(workbook.pending_transaction_count(), 0);
    assert_eq!(workbook.frontier().counter(replica(3)), 1);
    assert!(matches!(
        workbook.apply_transaction(invalid),
        Err(CollaborationError::UnknownSheetGeneration(_))
    ));
    assert_eq!(cell_text(&workbook), Some("valid"));
}

#[test]
fn concurrent_same_cell_writes_converge_without_clock_time() {
    let create = create_sheet_transaction();
    let left = set_cell_transaction(2, 2, 1, 2, &[(1, 1)], "left");
    let right = set_cell_transaction(3, 3, 2, 1, &[(1, 1)], "right");

    let mut first = CollaborativeWorkbook::new(77).expect("first");
    let mut second = CollaborativeWorkbook::new(77).expect("second");
    for state in [&mut first, &mut second] {
        state.apply_transaction(create.clone()).expect("create");
    }
    first.apply_transaction(left.clone()).expect("left");
    first.apply_transaction(right.clone()).expect("right");
    second.apply_transaction(right).expect("right");
    second.apply_transaction(left).expect("left");

    assert_eq!(cell_text(&first), Some("right"));
    assert_eq!(first, second);
    assert_eq!(
        encode_collaboration_snapshot(&first).expect("first snapshot"),
        encode_collaboration_snapshot(&second).expect("second snapshot")
    );
}

#[test]
fn range_clear_and_delayed_concurrent_write_converge_sparsely() {
    let create = create_sheet_transaction();
    let clear = transaction(
        2,
        1,
        2,
        &[(1, 1)],
        vec![operation(
            2,
            CollaborationCommand::ClearRange {
                sheet: generation(sheet_id(10), 1),
                range: CellRange::new(CellCoord::new(0, 0), CellCoord::new(u32::MAX, u32::MAX)),
            },
        )],
    );
    let write = set_cell_transaction(3, 3, 2, 1, &[(1, 1)], "concurrent");

    let mut clear_first = CollaborativeWorkbook::new(77).expect("state");
    let mut write_first = CollaborativeWorkbook::new(77).expect("state");
    for state in [&mut clear_first, &mut write_first] {
        state.apply_transaction(create.clone()).expect("create");
    }
    clear_first.apply_transaction(clear.clone()).expect("clear");
    assert_eq!(clear_first.causal_cell_count(), 0);
    clear_first.apply_transaction(write.clone()).expect("write");
    write_first.apply_transaction(write).expect("write");
    write_first.apply_transaction(clear).expect("clear");

    assert_eq!(clear_first, write_first);
    assert_eq!(clear_first.causal_cell_count(), 1);
}

#[test]
fn selective_undo_never_overwrites_later_work() {
    let mut workbook = CollaborativeWorkbook::new(77).expect("workbook");
    workbook
        .apply_transaction(create_sheet_transaction())
        .expect("create");
    let first = set_cell_transaction(2, 2, 1, 2, &[(1, 1)], "first");
    workbook.apply_transaction(first).expect("first");
    let later = set_cell_transaction(3, 3, 1, 3, &[(1, 2)], "later");
    workbook.apply_transaction(later).expect("later");
    let undo = transaction(
        4,
        1,
        4,
        &[(1, 3)],
        vec![operation(
            4,
            CollaborationCommand::Undo {
                target: OperationId::from_stable_id(StableId::from_parts(91, 2)),
            },
        )],
    );
    workbook.apply_transaction(undo).expect("undo");
    assert_eq!(cell_text(&workbook), Some("later"));
}

#[test]
fn selective_undo_of_rename_reveals_the_previous_name() {
    let mut workbook = CollaborativeWorkbook::new(77).expect("workbook");
    workbook
        .apply_transaction(create_sheet_transaction())
        .expect("create");
    let rename = transaction(
        2,
        1,
        2,
        &[(1, 1)],
        vec![operation(
            2,
            CollaborationCommand::RenameSheet {
                sheet: generation(sheet_id(10), 1),
                name: "Renamed".into(),
            },
        )],
    );
    workbook.apply_transaction(rename).expect("rename");
    assert_eq!(
        workbook.workbook().sheet(sheet_id(10)).unwrap().name(),
        "Renamed"
    );
    let undo = transaction(
        3,
        1,
        3,
        &[(1, 2)],
        vec![operation(
            3,
            CollaborationCommand::Undo {
                target: OperationId::from_stable_id(StableId::from_parts(91, 2)),
            },
        )],
    );
    workbook.apply_transaction(undo).expect("undo rename");
    assert_eq!(
        workbook.workbook().sheet(sheet_id(10)).unwrap().name(),
        "Data"
    );
}

#[test]
fn delete_and_concurrent_edit_converge_and_undo_resurrects_edit() {
    let create = create_sheet_transaction();
    let delete = transaction(
        2,
        1,
        2,
        &[(1, 1)],
        vec![operation(
            2,
            CollaborationCommand::DeleteSheet {
                sheet: generation(sheet_id(10), 1),
            },
        )],
    );
    let edit = set_cell_transaction(3, 3, 2, 1, &[(1, 1)], "preserved");
    let mut first = CollaborativeWorkbook::new(77).expect("state");
    let mut second = CollaborativeWorkbook::new(77).expect("state");
    for state in [&mut first, &mut second] {
        state.apply_transaction(create.clone()).expect("create");
    }
    first.apply_transaction(delete.clone()).expect("delete");
    first.apply_transaction(edit.clone()).expect("edit");
    second.apply_transaction(edit).expect("edit");
    second.apply_transaction(delete).expect("delete");
    assert_eq!(first, second);
    assert!(first.workbook().sheet(sheet_id(10)).is_none());

    let undo = transaction(
        4,
        1,
        3,
        &[(1, 2), (2, 1)],
        vec![operation(
            4,
            CollaborationCommand::Undo {
                target: OperationId::from_stable_id(StableId::from_parts(91, 2)),
            },
        )],
    );
    first.apply_transaction(undo).expect("undo delete");
    assert_eq!(cell_text(&first), Some("preserved"));
}

#[test]
fn tombstoned_predecessor_remains_a_stable_offline_sequence_anchor() {
    let mut workbook = CollaborativeWorkbook::new(77).expect("workbook");
    let first_sheet = create_sheet_transaction();
    workbook.apply_transaction(first_sheet).expect("first");
    let child = transaction(
        2,
        2,
        1,
        &[(1, 1)],
        vec![operation(
            2,
            CollaborationCommand::CreateSheet {
                sheet_id: sheet_id(20),
                name: "Offline child".into(),
                after: Some(generation(sheet_id(10), 1)),
            },
        )],
    );
    let delete = transaction(
        3,
        1,
        2,
        &[(1, 1)],
        vec![operation(
            3,
            CollaborationCommand::DeleteSheet {
                sheet: generation(sheet_id(10), 1),
            },
        )],
    );
    workbook.apply_transaction(delete).expect("delete");
    workbook.apply_transaction(child).expect("offline insert");
    let visible: Vec<_> = workbook.workbook().sheets().map(Sheet::id).collect();
    assert_eq!(visible, vec![sheet_id(20)]);
}

#[test]
fn snapshot_round_trip_preserves_tombstones_undo_and_pending_metadata() {
    let mut workbook = CollaborativeWorkbook::new(77).expect("workbook");
    workbook
        .apply_transaction(create_sheet_transaction())
        .expect("create");
    workbook
        .apply_transaction(set_cell_transaction(2, 2, 1, 2, &[(1, 1)], "value"))
        .expect("write");
    let clear = transaction(
        3,
        1,
        3,
        &[(1, 2)],
        vec![operation(
            3,
            CollaborationCommand::ClearRange {
                sheet: generation(sheet_id(10), 1),
                range: CellRange::new(CellCoord::new(0, 0), CellCoord::new(10, 10)),
            },
        )],
    );
    workbook.apply_transaction(clear).expect("clear");
    let undo = transaction(
        4,
        1,
        4,
        &[(1, 3)],
        vec![operation(
            4,
            CollaborationCommand::Undo {
                target: OperationId::from_stable_id(StableId::from_parts(91, 3)),
            },
        )],
    );
    workbook.apply_transaction(undo).expect("undo");
    assert_eq!(cell_text(&workbook), Some("value"));
    let delayed = set_cell_transaction(6, 6, 3, 2, &[(1, 4), (3, 1)], "delayed");
    assert_eq!(
        workbook
            .apply_transaction(delayed)
            .expect("deferred")
            .disposition,
        TransactionDisposition::Deferred
    );

    let metadata = workbook.retention_metadata();
    assert_eq!(
        metadata.retained_history_bytes,
        workbook.retained_history_bytes()
    );
    assert_eq!(
        metadata.maximum_retained_history_bytes,
        CollaborativeWorkbook::MAX_RETAINED_HISTORY_BYTES
    );
    assert_eq!(
        metadata.maximum_retained_transactions,
        MAX_RETAINED_TRANSACTIONS
    );
    assert!(metadata
        .tombstones
        .iter()
        .any(|entry| entry.kind == TombstoneKind::RangeClear));
    assert_eq!(metadata.undo_links.len(), 1);
    assert_eq!(metadata.pending_bases.len(), 1);

    let bytes = encode_collaboration_snapshot(&workbook).expect("encode");
    let decoded = decode_collaboration_snapshot(&bytes).expect("decode");
    assert_eq!(decoded, workbook);
    assert_eq!(
        encode_collaboration_snapshot(&decoded).expect("re-encode"),
        bytes
    );
}

#[test]
fn snapshot_restore_uses_causal_order_instead_of_encoded_dot_order() {
    let mut workbook = CollaborativeWorkbook::new(77).expect("workbook");
    let sheet = sheet_id(10);
    workbook
        .apply_transaction(transaction(
            1,
            9,
            1,
            &[],
            vec![operation(
                1,
                CollaborationCommand::CreateSheet {
                    sheet_id: sheet,
                    name: "Root".into(),
                    after: None,
                },
            )],
        ))
        .expect("high-replica root");
    for counter in 1..=512u64 {
        let mut base = vec![(9, 1)];
        if counter > 1 {
            base.push((1, counter - 1));
        }
        workbook
            .apply_transaction(transaction(
                10_000 + counter,
                1,
                counter,
                &base,
                vec![operation(
                    20_000 + counter,
                    CollaborationCommand::RenameSheet {
                        sheet: generation(sheet, 1),
                        name: format!("Name {counter}"),
                    },
                )],
            ))
            .expect("low-replica dependent chain");
    }

    let bytes = encode_collaboration_snapshot(&workbook).expect("encode");
    let decoded = decode_collaboration_snapshot(&bytes).expect("causal restore");
    assert_eq!(decoded, workbook);
    assert_eq!(
        encode_collaboration_snapshot(&decoded).expect("re-encode"),
        bytes
    );
}

#[test]
fn invalid_ready_transaction_does_not_reserve_ids_or_mutate_state() {
    let mut workbook = CollaborativeWorkbook::new(77).expect("workbook");
    workbook
        .apply_transaction(create_sheet_transaction())
        .expect("create");
    let before = encode_collaboration_snapshot(&workbook).expect("before");
    let invalid = transaction(
        2,
        1,
        2,
        &[(1, 1)],
        vec![operation(
            2,
            CollaborationCommand::SetCells {
                sheet: SheetGeneration::new(
                    sheet_id(10),
                    OperationId::from_stable_id(StableId::from_parts(91, 999)),
                ),
                anchor: CellCoord::new(0, 0),
                cells: CellBlock::new(1, 1, vec![Cell::from("bad")]).expect("cell"),
            },
        )],
    );
    assert!(workbook.apply_transaction(invalid).is_err());
    assert_eq!(
        encode_collaboration_snapshot(&workbook).expect("after"),
        before
    );
}

#[test]
fn deterministic_property_holds_for_many_permutations_and_duplicates() {
    let create = create_sheet_transaction();
    let mut transactions: Vec<_> = (2..=7)
        .map(|replica_id| {
            set_cell_transaction(
                10 + replica_id,
                10 + replica_id,
                replica_id,
                1,
                &[(1, 1)],
                &format!("replica-{replica_id}"),
            )
        })
        .collect();
    transactions.extend((8..=10).map(|replica_id| {
        transaction(
            100 + replica_id,
            replica_id,
            1,
            &[(1, 1)],
            vec![operation(
                100 + replica_id,
                CollaborationCommand::ClearRange {
                    sheet: generation(sheet_id(10), 1),
                    range: CellRange::new(CellCoord::new(0, 0), CellCoord::new(1, 1)),
                },
            )],
        )
    }));
    transactions.push(create);
    let mut expected = None;
    for seed in 1..=64u64 {
        let mut order: Vec<_> = (0..transactions.len()).collect();
        let mut state = seed;
        for index in (1..order.len()).rev() {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            order.swap(index, (state as usize) % (index + 1));
        }
        let mut workbook = CollaborativeWorkbook::new(77).expect("workbook");
        for index in order {
            let transaction = transactions[index].clone();
            workbook
                .apply_transaction(transaction.clone())
                .expect("transaction");
            workbook
                .apply_transaction(transaction)
                .expect("exact duplicate");
        }
        assert_eq!(workbook.pending_transaction_count(), 0);
        let snapshot = encode_collaboration_snapshot(&workbook).expect("snapshot");
        if let Some(expected) = &expected {
            assert_eq!(&snapshot, expected);
        } else {
            expected = Some(snapshot);
        }
    }
}

#[test]
fn retained_wire_budget_fails_closed_without_mutation_or_silent_gc() {
    let create = create_sheet_transaction();
    let create_bytes = snapshot::retained_transaction_wire_bytes(&create).expect("wire size");
    let mut workbook = CollaborativeWorkbook::new(77).expect("workbook");
    let receipt = workbook
        .apply_transaction_with_limits(create.clone(), true, 8, create_bytes)
        .expect("exact boundary applies");
    assert_eq!(receipt.disposition, TransactionDisposition::Applied);
    assert_eq!(workbook.retained_history_bytes(), create_bytes);

    // Idempotent retry remains a no-op even when no retention capacity remains.
    assert_eq!(
        workbook
            .apply_transaction_with_limits(create, true, 8, create_bytes)
            .expect("duplicate at boundary")
            .disposition,
        TransactionDisposition::DuplicateApplied
    );

    let before = encode_collaboration_snapshot(&workbook).expect("boundary is snapshotable");
    let next = set_cell_transaction(2, 2, 1, 2, &[(1, 1)], "would overflow");
    let next_bytes = snapshot::retained_transaction_wire_bytes(&next).expect("wire size");
    assert_eq!(
        workbook.apply_transaction_with_limits(next, true, 8, create_bytes),
        Err(CollaborationError::CompactionRequired {
            retained_transactions: 1,
            retained_bytes: create_bytes,
            incoming_bytes: next_bytes,
            maximum_transactions: 8,
            maximum_bytes: create_bytes,
        })
    );
    assert_eq!(workbook.retained_transaction_count(), 1);
    assert_eq!(workbook.retained_history_bytes(), create_bytes);
    assert_eq!(
        encode_collaboration_snapshot(&workbook).expect("unchanged snapshot"),
        before
    );
}

#[test]
fn retained_transaction_count_requests_explicit_compaction() {
    let create = create_sheet_transaction();
    let create_bytes = snapshot::retained_transaction_wire_bytes(&create).expect("wire size");
    let mut workbook = CollaborativeWorkbook::new(77).expect("workbook");
    workbook
        .apply_transaction_with_limits(create, true, 1, usize::MAX)
        .expect("first transaction");
    let next = set_cell_transaction(2, 2, 1, 2, &[(1, 1)], "next");
    let next_bytes = snapshot::retained_transaction_wire_bytes(&next).expect("wire size");
    assert_eq!(
        workbook.apply_transaction_with_limits(next, true, 1, usize::MAX),
        Err(CollaborationError::CompactionRequired {
            retained_transactions: 1,
            retained_bytes: create_bytes,
            incoming_bytes: next_bytes,
            maximum_transactions: 1,
            maximum_bytes: usize::MAX,
        })
    );
}

#[test]
fn rejected_deferred_work_releases_its_retained_wire_budget() {
    let mut workbook = CollaborativeWorkbook::new(77).expect("workbook");
    let create = create_sheet_transaction();
    let create_bytes = snapshot::retained_transaction_wire_bytes(&create).expect("create size");
    workbook.apply_transaction(create).expect("create");

    let invalid = transaction(
        30,
        3,
        2,
        &[(1, 1), (3, 1)],
        vec![operation(
            30,
            CollaborationCommand::SetCells {
                sheet: SheetGeneration::new(
                    sheet_id(999),
                    OperationId::from_stable_id(StableId::from_parts(91, 999)),
                ),
                anchor: CellCoord::new(0, 0),
                cells: CellBlock::new(1, 1, vec![Cell::from("invalid")]).expect("cell"),
            },
        )],
    );
    let invalid_bytes = snapshot::retained_transaction_wire_bytes(&invalid).expect("invalid size");
    workbook
        .apply_transaction(invalid)
        .expect("deferred before validation");
    assert_eq!(
        workbook.retained_history_bytes(),
        create_bytes + invalid_bytes
    );

    let predecessor = set_cell_transaction(31, 31, 3, 1, &[(1, 1)], "valid");
    let predecessor_bytes =
        snapshot::retained_transaction_wire_bytes(&predecessor).expect("predecessor size");
    let receipt = workbook
        .apply_transaction(predecessor)
        .expect("settle deferred transaction");
    assert_eq!(receipt.rejected_deferred.len(), 1);
    assert_eq!(
        workbook.retained_history_bytes(),
        create_bytes + predecessor_bytes
    );
    assert_eq!(workbook.retained_transaction_count(), 2);
    encode_collaboration_snapshot(&workbook).expect("post-rejection snapshot");
}

#[test]
fn applied_and_deferred_arrival_permutations_round_trip_to_one_causal_snapshot() {
    let transactions = [
        create_sheet_transaction(),
        set_cell_transaction(10, 10, 2, 1, &[(1, 1)], "independent"),
        set_cell_transaction(20, 20, 3, 1, &[(1, 1)], "one"),
        set_cell_transaction(22, 22, 3, 3, &[(1, 1), (3, 2)], "still pending"),
    ];

    let mut expected = None;
    for seed in 1..=64u64 {
        let mut order = [0, 1, 2, 3];
        let mut random = seed;
        for index in (1..order.len()).rev() {
            random = random
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            order.swap(index, (random as usize) % (index + 1));
        }
        let mut workbook = CollaborativeWorkbook::new(77).expect("workbook");
        for index in order {
            let transaction = transactions[index].clone();
            workbook
                .apply_transaction(transaction.clone())
                .expect("permuted transaction");
            assert!(matches!(
                workbook
                    .apply_transaction(transaction)
                    .expect("duplicate transaction")
                    .disposition,
                TransactionDisposition::DuplicateApplied
                    | TransactionDisposition::DuplicateDeferred
            ));
        }
        assert_eq!(workbook.pending_transaction_count(), 1);
        assert_eq!(workbook.frontier().counter(replica(3)), 1);
        let bytes = encode_collaboration_snapshot(&workbook).expect("snapshot");
        let decoded = decode_collaboration_snapshot(&bytes).expect("round trip");
        assert_eq!(decoded, workbook);
        assert_eq!(decoded.pending_transaction_count(), 1);
        assert_eq!(decoded.frontier(), workbook.frontier());
        if let Some(expected) = &expected {
            assert_eq!(&bytes, expected);
        } else {
            expected = Some(bytes);
        }
    }
}

#[test]
fn formulas_recalculate_through_collaboration_undo_and_snapshot_restore() {
    let mut workbook = CollaborativeWorkbook::new(77).expect("workbook");
    workbook
        .apply_transaction(create_sheet_transaction())
        .expect("create");
    workbook
        .apply_transaction(transaction(
            2,
            1,
            2,
            &[(1, 1)],
            vec![operation(
                2,
                CollaborationCommand::SetCells {
                    sheet: generation(sheet_id(10), 1),
                    anchor: CellCoord::new(0, 0),
                    cells: CellBlock::new(
                        1,
                        2,
                        vec![
                            Cell::from_value(finite(2.0)),
                            Cell::formula("=A1*3", finite(999.0)).expect("formula"),
                        ],
                    )
                    .expect("cells"),
                },
            )],
        ))
        .expect("seed formula");
    let formula_value = |state: &CollaborativeWorkbook| {
        state
            .workbook()
            .sheet(sheet_id(10))
            .and_then(|sheet| sheet.cell(CellCoord::new(0, 1)))
            .map(Cell::value)
            .cloned()
    };
    assert_eq!(formula_value(&workbook), Some(finite(6.0)));

    let edit_operation = 3;
    workbook
        .apply_transaction(transaction(
            3,
            1,
            3,
            &[(1, 2)],
            vec![operation(
                edit_operation,
                CollaborationCommand::SetCells {
                    sheet: generation(sheet_id(10), 1),
                    anchor: CellCoord::new(0, 0),
                    cells: CellBlock::new(1, 1, vec![Cell::from_value(finite(4.0))]).expect("edit"),
                },
            )],
        ))
        .expect("edit input");
    assert_eq!(formula_value(&workbook), Some(finite(12.0)));

    workbook
        .apply_transaction(transaction(
            4,
            1,
            4,
            &[(1, 3)],
            vec![operation(
                4,
                CollaborationCommand::Undo {
                    target: OperationId::from_stable_id(StableId::from_parts(91, edit_operation)),
                },
            )],
        ))
        .expect("undo input edit");
    assert_eq!(formula_value(&workbook), Some(finite(6.0)));

    let restored = decode_collaboration_snapshot(
        &encode_collaboration_snapshot(&workbook).expect("encode collaboration"),
    )
    .expect("restore collaboration");
    assert_eq!(formula_value(&restored), Some(finite(6.0)));
    assert_eq!(restored, workbook);
}
