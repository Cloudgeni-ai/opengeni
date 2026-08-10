//! Deterministic, runtime-neutral model kernel for OpenGeni artifacts.

#![forbid(unsafe_code)]

mod collaboration;
mod command;
pub mod document;
pub mod formula;
mod id;
pub mod presentation;
mod sheet;
mod snapshot;
pub mod text_layout;
mod value;
mod workbook;

pub use collaboration::{
    decode_collaboration_snapshot, encode_collaboration_snapshot, CausalDot, CausalFrontier,
    CollaborationCommand, CollaborationError, CollaborationOperation, CollaborationReceipt,
    CollaborationSnapshotError, CollaborationTransaction, CollaborativeWorkbook, OperationId,
    RejectedTransaction, ReplicaId, RetentionMetadata, SheetGeneration, TombstoneKind,
    TombstoneRetention, TransactionDisposition, TransactionId, UndoRetention,
    COLLABORATION_SNAPSHOT_VERSION, MAX_CAUSAL_REPLICAS, MAX_CELLS_PER_TRANSACTION,
    MAX_OPERATIONS_PER_TRANSACTION, MAX_PENDING_DEPENDENCIES, MAX_PENDING_TRANSACTIONS,
    MAX_RETAINED_TRANSACTIONS, MAX_TRANSACTION_TEXT_BYTES,
};
pub use command::{
    AtomicBatch, BatchError, BatchReceipt, BatchTransaction, Command, CommandErrorKind,
};
pub use id::{IdError, IdGenerator, StableId};
pub use sheet::{
    CellBlock, CellBlockError, CellCoord, CellRange, Sheet, TileCoord, TILE_CELL_COUNT, TILE_EDGE,
};
pub use snapshot::{decode_snapshot, encode_snapshot, SnapshotError, SNAPSHOT_VERSION};
pub use value::{Cell, CellValue, DateValue, FormulaError, Number, ValueError};
pub use workbook::{Workbook, WorkbookError};
