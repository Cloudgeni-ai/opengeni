//! Node-API adapter for the OpenGeni artifact kernel binding protocol.
//!
//! This crate intentionally exposes only owned byte buffers. The shared
//! protocol crate remains the single authority for decoding, validation,
//! mutation, canonicalization, capability negotiation, and error codes.

#![deny(unsafe_code)]

mod document;
mod presentation;
mod text_layout;

pub use document::*;
pub use presentation::*;
pub use text_layout::*;

use napi::bindgen_prelude::Buffer;
use napi::{Error, Result, Status};
use napi_derive::napi;
use opengeni_artifact_kernel_binding_protocol as protocol;

/// Returns the canonical capability envelope for this binding.
#[napi(js_name = "capabilities", strict)]
pub fn capabilities() -> Buffer {
    Buffer::from(protocol::capabilities().to_vec())
}

/// Returns the canonical kernel/protocol build identity envelope.
#[napi(js_name = "buildIdentity", strict)]
pub fn build_identity() -> Buffer {
    Buffer::from(protocol::build_identity().to_vec())
}

/// Creates an empty workbook from a canonical namespace envelope.
#[napi(js_name = "createWorkbook", strict)]
pub fn create_workbook(namespace_envelope: Buffer) -> Result<Buffer> {
    protocol::create_workbook(namespace_envelope.as_ref())
        .map(Buffer::from)
        .map_err(binding_error)
}

/// Atomically applies a canonical command envelope to a canonical snapshot.
#[napi(js_name = "applyCommands", strict)]
pub fn apply_commands(snapshot: Buffer, command_envelope: Buffer) -> Result<Buffer> {
    protocol::apply_commands(snapshot.as_ref(), command_envelope.as_ref())
        .map(Buffer::from)
        .map_err(binding_error)
}

/// Executes one bounded OGAKQ001 read against a canonical snapshot.
#[napi(js_name = "query", strict)]
pub fn query(snapshot: Buffer, query_envelope: Buffer) -> Result<Buffer> {
    protocol::query(snapshot.as_ref(), query_envelope.as_ref())
        .map(Buffer::from)
        .map_err(binding_error)
}

/// Strictly decodes and deterministically re-encodes a kernel snapshot.
#[napi(js_name = "canonicalizeSnapshot", strict)]
pub fn canonicalize_snapshot(snapshot: Buffer) -> Result<Buffer> {
    protocol::canonicalize_snapshot(snapshot.as_ref())
        .map(Buffer::from)
        .map_err(binding_error)
}

/// Strictly decodes and deterministically re-encodes a full CRDT snapshot.
#[napi(js_name = "canonicalizeCollaborationSnapshot", strict)]
pub fn canonicalize_collaboration_snapshot(snapshot: Buffer) -> Result<Buffer> {
    protocol::canonicalize_collaboration_snapshot(snapshot.as_ref())
        .map(Buffer::from)
        .map_err(binding_error)
}

fn binding_error(error: protocol::BindingError) -> Error {
    Error::new(Status::InvalidArg, format!("[{}] {error}", error.code()))
}

/// Stateful hot-path kernel handle.
///
/// A session decodes a workbook once, applies many command envelopes directly
/// to the in-memory model, and serializes only when `snapshot()` is requested.
/// It is deliberately synchronous so one JavaScript owner observes mutations
/// in program order; hosts should place it in their artifact worker.
#[napi]
pub struct ArtifactKernelSession {
    inner: protocol::BindingSession,
}

/// Stateful authoritative collaboration/CRDT kernel handle.
#[napi]
pub struct ArtifactCollaborationSession {
    inner: protocol::CollaborationBindingSession,
}

#[napi]
impl ArtifactCollaborationSession {
    /// Creates an empty CRDT workbook from a canonical namespace envelope.
    #[napi(factory, js_name = "create", strict)]
    pub fn create(namespace_envelope: Buffer) -> Result<Self> {
        protocol::CollaborationBindingSession::create(namespace_envelope.as_ref())
            .map(|inner| Self { inner })
            .map_err(binding_error)
    }

    /// Opens one canonical OGACRD01 full-state snapshot.
    #[napi(factory, js_name = "open", strict)]
    pub fn open(snapshot: Buffer) -> Result<Self> {
        protocol::CollaborationBindingSession::open(snapshot.as_ref())
            .map(|inner| Self { inner })
            .map_err(binding_error)
    }

    /// Authors and applies one canonical OGATX001 transaction.
    #[napi(js_name = "authorTransaction", strict)]
    pub fn author_transaction(
        &mut self,
        intent_bytes: Buffer,
        resolved_base: Buffer,
    ) -> Result<Buffer> {
        self.inner
            .author_transaction(intent_bytes.as_ref(), resolved_base.as_ref())
            .map(Buffer::from)
            .map_err(binding_error)
    }

    /// Replays one whole canonical OGACO001 committed transaction atomically.
    #[napi(js_name = "applyCommitted", strict)]
    pub fn apply_committed(&mut self, operation_envelope: Buffer) -> Result<()> {
        self.inner
            .apply_committed(operation_envelope.as_ref())
            .map_err(binding_error)
    }

    /// Returns the full canonical OGACRD01 snapshot.
    #[napi(js_name = "snapshot", strict)]
    pub fn snapshot(&self) -> Result<Buffer> {
        self.inner
            .snapshot()
            .map(Buffer::from)
            .map_err(binding_error)
    }

    /// Returns the canonical OGACF001 causal frontier.
    #[napi(js_name = "frontier", strict)]
    pub fn frontier(&self) -> Result<Buffer> {
        self.inner
            .frontier()
            .map(Buffer::from)
            .map_err(binding_error)
    }

    /// Returns SHA-256 of the exact canonical OGACRD01 snapshot.
    #[napi(js_name = "stateHash", strict)]
    pub fn state_hash(&self) -> Result<String> {
        self.inner.state_hash().map_err(binding_error)
    }

    /// Returns the materialized workbook revision.
    #[napi(js_name = "revision", strict)]
    pub fn revision(&self) -> Result<u64> {
        self.inner.revision().map_err(binding_error)
    }

    /// Executes one bounded viewport or workbook-metadata projection.
    #[napi(js_name = "query", strict)]
    pub fn query(&self, query_envelope: Buffer) -> Result<Buffer> {
        self.inner
            .query(query_envelope.as_ref())
            .map(Buffer::from)
            .map_err(binding_error)
    }

    /// Creates an independent in-memory collaboration branch.
    #[napi(js_name = "fork", strict)]
    pub fn fork(&self) -> Result<Self> {
        self.inner
            .fork()
            .map(|inner| Self { inner })
            .map_err(binding_error)
    }

    /// Reports whether collaboration state has been released.
    #[napi(js_name = "isClosed", strict)]
    pub fn is_closed(&self) -> bool {
        self.inner.is_closed()
    }

    /// Releases the in-memory collaboration state.
    #[napi(js_name = "close", strict)]
    pub fn close(&mut self) {
        self.inner.close();
    }

    /// Explicit-resource-management alias for close.
    #[napi(js_name = "dispose", strict)]
    pub fn dispose(&mut self) {
        self.inner.close();
    }
}

#[napi]
impl ArtifactKernelSession {
    /// Creates an empty in-memory workbook from a canonical namespace envelope.
    #[napi(factory, js_name = "create", strict)]
    pub fn create(namespace_envelope: Buffer) -> Result<Self> {
        protocol::BindingSession::create(namespace_envelope.as_ref())
            .map(|inner| Self { inner })
            .map_err(binding_error)
    }

    /// Opens and validates one canonical snapshot into memory.
    #[napi(factory, js_name = "open", strict)]
    pub fn open(snapshot: Buffer) -> Result<Self> {
        protocol::BindingSession::open(snapshot.as_ref())
            .map(|inner| Self { inner })
            .map_err(binding_error)
    }

    /// Atomically applies a command envelope and returns its canonical receipt.
    #[napi(js_name = "applyCommands", strict)]
    pub fn apply_commands(&mut self, command_envelope: Buffer) -> Result<Buffer> {
        self.inner
            .apply_commands(command_envelope.as_ref())
            .map(Buffer::from)
            .map_err(binding_error)
    }

    /// Serializes the current in-memory workbook as a canonical snapshot.
    #[napi(js_name = "snapshot", strict)]
    pub fn snapshot(&self) -> Result<Buffer> {
        self.inner
            .snapshot()
            .map(Buffer::from)
            .map_err(binding_error)
    }

    /// Returns the exact workbook revision as a JavaScript `bigint`.
    #[napi(js_name = "revision", strict)]
    pub fn revision(&self) -> Result<u64> {
        self.inner.revision().map_err(binding_error)
    }

    /// Executes one bounded viewport or workbook-metadata projection.
    #[napi(js_name = "query", strict)]
    pub fn query(&self, query_envelope: Buffer) -> Result<Buffer> {
        self.inner
            .query(query_envelope.as_ref())
            .map(Buffer::from)
            .map_err(binding_error)
    }

    /// Creates an independent branch without snapshot serialization.
    #[napi(js_name = "fork", strict)]
    pub fn fork(&self) -> Result<Self> {
        self.inner
            .fork()
            .map(|inner| Self { inner })
            .map_err(binding_error)
    }

    /// Returns SHA-256 of the exact canonical snapshot.
    #[napi(js_name = "stateHash", strict)]
    pub fn state_hash(&self) -> Result<String> {
        self.inner.state_hash().map_err(binding_error)
    }

    /// Reports whether the native model has been released.
    #[napi(getter, js_name = "closed")]
    pub fn closed(&self) -> bool {
        self.inner.is_closed()
    }

    /// Releases the in-memory workbook. Repeated calls are harmless.
    #[napi(js_name = "close", strict)]
    pub fn close(&mut self) {
        self.inner.close();
    }

    /// Explicit-resource-management alias for `close()`. Repeated calls are
    /// harmless; consumers may call either method from a `finally` block.
    #[napi(js_name = "dispose", strict)]
    pub fn dispose(&mut self) {
        self.inner.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opengeni_artifact_kernel::{
        decode_snapshot, AtomicBatch, Cell, CellBlock, CellCoord, Command, StableId,
    };

    const COLLABORATION_PARITY_INTENT: &str = "4f47415458303031010001000100010020003131313131313131313131313131313131313131313131313131313131313131110062696e64696e672e7061726974792e76311000303030303030303030303030343534350100000000000000000000000000000000000000003c0000004f4741534330303101000000010000001c0000000000000000020000000000000045450000000000000600000050617269747900d2d2aa22ef1d9d0a";
    const EMPTY_FRONTIER: &str = "4f4741434630303101000000000000003fb3b04f29ccf857";

    fn unhex(value: &str) -> Vec<u8> {
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                u8::from_str_radix(core::str::from_utf8(pair).expect("ASCII hex"), 16)
                    .expect("canonical hex")
            })
            .collect()
    }

    #[test]
    fn metadata_is_owned_and_deterministic() {
        let first_capabilities = capabilities();
        let second_capabilities = capabilities();
        assert!(!first_capabilities.is_empty());
        assert_eq!(first_capabilities.as_ref(), second_capabilities.as_ref());

        let first_identity = build_identity();
        let second_identity = build_identity();
        assert!(!first_identity.is_empty());
        assert_eq!(first_identity.as_ref(), second_identity.as_ref());
    }

    #[test]
    fn workbook_round_trips_and_applies_commands() {
        let namespace = 42;
        let snapshot = create_workbook(Buffer::from(protocol::encode_namespace(namespace)))
            .expect("create workbook");
        let canonical = canonicalize_snapshot(Buffer::from(snapshot.as_ref().to_vec()))
            .expect("canonicalize snapshot");
        assert_eq!(snapshot.as_ref(), canonical.as_ref());

        let sheet_id = StableId::from_parts(namespace, 2);
        let batch = AtomicBatch::from_commands(vec![Command::CreateSheet {
            id: sheet_id,
            name: "Summary".into(),
        }]);
        let commands = protocol::encode_command_batch(&batch).expect("encode commands");
        let updated = apply_commands(snapshot, Buffer::from(commands)).expect("apply commands");
        let workbook = decode_snapshot(updated.as_ref()).expect("decode updated snapshot");

        assert_eq!(workbook.revision(), 1);
        assert_eq!(workbook.sheet_count(), 1);
        assert_eq!(workbook.sheet(sheet_id).expect("sheet").name(), "Summary");
    }

    #[test]
    fn protocol_error_code_survives_the_napi_boundary() {
        let result = canonicalize_snapshot(Buffer::from(vec![0_u8]));
        let error = match result {
            Ok(_) => panic!("invalid snapshot must fail"),
            Err(error) => error,
        };

        assert_eq!(error.status, Status::InvalidArg);
        assert!(error.reason.starts_with('['));
        assert!(error.reason.contains("] "));
    }

    #[test]
    fn stateful_session_applies_without_snapshot_round_trips() {
        let namespace = 84;
        let mut session =
            ArtifactKernelSession::create(Buffer::from(protocol::encode_namespace(namespace)))
                .expect("create session");
        let initial = session.snapshot().expect("initial snapshot");

        let sheet_id = StableId::from_parts(namespace, 2);
        let batch = AtomicBatch::from_commands(vec![Command::CreateSheet {
            id: sheet_id,
            name: "Data".into(),
        }]);
        let commands = protocol::encode_command_batch(&batch).expect("encode commands");
        let receipt = session
            .apply_commands(Buffer::from(commands.clone()))
            .expect("apply commands");
        let decoded_receipt = protocol::decode_receipt(receipt.as_ref()).expect("decode receipt");
        assert_eq!(decoded_receipt.revision, 1);
        assert_eq!(session.revision().expect("revision"), 1);

        let updated = session.snapshot().expect("updated snapshot");
        assert_ne!(initial.as_ref(), updated.as_ref());
        let stateless = super::apply_commands(initial, Buffer::from(commands))
            .expect("stateless apply commands");
        assert_eq!(updated.as_ref(), stateless.as_ref());
        let workbook = decode_snapshot(updated.as_ref()).expect("decode updated snapshot");
        assert_eq!(workbook.revision(), 1);
        assert_eq!(workbook.sheet(sheet_id).expect("sheet").name(), "Data");

        let reopened = ArtifactKernelSession::open(updated).expect("reopen session");
        assert_eq!(
            reopened.snapshot().expect("reopened snapshot").as_ref(),
            session.snapshot().expect("source snapshot").as_ref()
        );

        assert!(!session.closed());
        session.close();
        session.dispose();
        assert!(session.closed());
        let closed_error = match session.snapshot() {
            Ok(_) => panic!("closed session must reject"),
            Err(error) => error,
        };
        assert!(closed_error
            .reason
            .starts_with("[ARTIFACT_SESSION_CLOSED] "));
    }

    #[test]
    fn bounded_query_is_byte_identical_to_the_shared_protocol() {
        let namespace = 0x4242;
        let sheet_id = StableId::from_parts(namespace, 9);
        let mut session =
            ArtifactKernelSession::create(Buffer::from(protocol::encode_namespace(namespace)))
                .expect("session");
        let commands = protocol::encode_command_batch(&AtomicBatch::from_commands(vec![
            Command::CreateSheet {
                id: sheet_id,
                name: "Data".into(),
            },
            Command::SetCells {
                sheet_id,
                anchor: CellCoord::new(20, 30),
                cells: CellBlock::new(1, 2, vec![Cell::from(true), Cell::from("x")])
                    .expect("cells"),
            },
        ]))
        .expect("commands");
        session
            .apply_commands(Buffer::from(commands))
            .expect("seed");
        let request = protocol::encode_viewport_query(protocol::ViewportQuery {
            sheet_id,
            start: CellCoord::new(20, 30),
            rows: 1,
            columns: 2,
            max_cells: u32::MAX,
            max_bytes: u32::MAX,
        })
        .expect("query");
        let actual = session
            .query(Buffer::from(request.clone()))
            .expect("session query");
        let expected = protocol::query(session.snapshot().expect("snapshot").as_ref(), &request)
            .expect("stateless query");
        assert_eq!(actual.as_ref(), expected);
        let protocol::ArtifactQueryResponse::Viewport(response) =
            protocol::decode_query_response(actual.as_ref()).expect("response")
        else {
            panic!("viewport response")
        };
        assert_eq!(response.cells.len(), 2);
    }

    #[test]
    fn collaboration_author_replay_query_and_lifecycle_match_protocol() {
        let namespace = Buffer::from(protocol::encode_namespace(0x4545));
        let intent = unhex(COLLABORATION_PARITY_INTENT);
        let base = unhex(EMPTY_FRONTIER);
        let mut binding =
            ArtifactCollaborationSession::create(Buffer::from(namespace.as_ref().to_vec()))
                .expect("binding session");
        let mut protocol_session =
            protocol::CollaborationBindingSession::create(namespace.as_ref())
                .expect("protocol session");
        let binding_committed = binding
            .author_transaction(Buffer::from(intent.clone()), Buffer::from(base.clone()))
            .expect("binding author");
        let protocol_committed = protocol_session
            .author_transaction(&intent, &base)
            .expect("protocol author");
        assert_eq!(binding_committed.as_ref(), protocol_committed);
        assert_eq!(
            binding.snapshot().expect("binding snapshot").as_ref(),
            protocol_session.snapshot().expect("protocol snapshot")
        );
        assert_eq!(
            binding.frontier().expect("binding frontier").as_ref(),
            protocol_session.frontier().expect("protocol frontier")
        );
        assert_eq!(
            binding.state_hash().expect("binding hash"),
            protocol_session.state_hash().expect("protocol hash")
        );

        let mut replay =
            ArtifactCollaborationSession::create(Buffer::from(namespace.as_ref().to_vec()))
                .expect("binding replay");
        replay
            .apply_committed(Buffer::from(protocol_committed.clone()))
            .expect("binding replay committed");
        replay
            .apply_committed(Buffer::from(protocol_committed))
            .expect("binding duplicate is idempotent");
        assert_eq!(
            replay.snapshot().expect("replay snapshot").as_ref(),
            binding.snapshot().expect("author snapshot").as_ref()
        );
        let query = protocol::encode_workbook_metadata_query(protocol::WorkbookMetadataQuery {
            max_sheets: u32::MAX,
            max_bytes: u32::MAX,
        })
        .expect("query");
        assert_eq!(
            binding
                .query(Buffer::from(query.clone()))
                .expect("binding query")
                .as_ref(),
            protocol_session.query(&query).expect("protocol query")
        );
        let branch = binding.fork().expect("binding fork");
        assert_eq!(
            branch.snapshot().expect("branch snapshot").as_ref(),
            binding.snapshot().expect("source snapshot").as_ref()
        );
        binding.close();
        binding.dispose();
        assert!(binding.is_closed());
    }

    #[test]
    fn fork_is_independent_and_state_hash_matches_snapshot() {
        use sha2::{Digest, Sha256};

        let namespace = 5150;
        let mut source =
            ArtifactKernelSession::create(Buffer::from(protocol::encode_namespace(namespace)))
                .expect("source");
        let mut branch = source.fork().expect("fork");
        assert_eq!(
            source.state_hash().expect("source hash"),
            branch.state_hash().expect("branch hash")
        );

        let sheet_id = StableId::from_parts(namespace, 2);
        let commands = protocol::encode_command_batch(&AtomicBatch::from_commands(vec![
            Command::CreateSheet {
                id: sheet_id,
                name: "Branch".into(),
            },
        ]))
        .expect("commands");
        branch
            .apply_commands(Buffer::from(commands))
            .expect("branch mutation");
        assert_eq!(source.revision().expect("source revision"), 0);
        assert_eq!(branch.revision().expect("branch revision"), 1);
        assert_ne!(
            source.state_hash().expect("source hash"),
            branch.state_hash().expect("branch hash")
        );

        let snapshot = source.snapshot().expect("snapshot");
        let expected = format!("sha256:{:x}", Sha256::digest(snapshot.as_ref()));
        assert_eq!(source.state_hash().expect("state hash"), expected);
        source.close();
        assert!(source.fork().is_err());
        assert!(source.state_hash().is_err());
    }

    #[test]
    fn zero_namespace_is_rejected_with_typed_code() {
        let error = match ArtifactKernelSession::create(Buffer::from(protocol::encode_namespace(0)))
        {
            Ok(_) => panic!("zero namespace must fail"),
            Err(error) => error,
        };
        assert!(error.reason.starts_with("[ARTIFACT_INVALID_NAMESPACE] "));
    }
}
