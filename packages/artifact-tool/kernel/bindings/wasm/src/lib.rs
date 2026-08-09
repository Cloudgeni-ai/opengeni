//! WebAssembly byte-envelope adapter for the OpenGeni artifact kernel.
//!
//! This crate intentionally contains no artifact semantics. Native and browser
//! runtimes both call the same shared binding-protocol crate, keeping command
//! validation, canonicalization, safety limits, and error codes identical.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

#[cfg(feature = "document")]
mod document;
#[cfg(feature = "presentation")]
mod presentation;
#[cfg(feature = "text-layout")]
mod text_layout;

#[cfg(feature = "document")]
pub use document::*;
#[cfg(feature = "presentation")]
pub use presentation::*;
#[cfg(feature = "text-layout")]
pub use text_layout::*;

use opengeni_artifact_kernel_binding_protocol as protocol;
use wasm_bindgen::prelude::wasm_bindgen;
#[cfg(any(feature = "spreadsheet", feature = "legacy-spreadsheet", test))]
use wasm_bindgen::JsError;

/// Returns the canonical encoded capability envelope.
///
/// JavaScript receives a fresh `Uint8Array`; callers may mutate it without
/// affecting subsequent calls.
#[wasm_bindgen]
#[must_use]
pub fn capabilities() -> Vec<u8> {
    protocol::capabilities_for_features(
        protocol::WASM_LIMITS,
        protocol::BindingFeatures {
            spreadsheet: cfg!(feature = "spreadsheet"),
            document: cfg!(feature = "document"),
            presentation: cfg!(feature = "presentation"),
            text_layout: cfg!(feature = "text-layout"),
        },
    )
}

/// Returns the canonical encoded build-identity envelope.
///
/// The identity lets loaders fail closed when the operation protocol, snapshot
/// schema, or kernel implementation is incompatible.
#[wasm_bindgen(js_name = buildIdentity)]
#[must_use]
pub fn build_identity() -> Vec<u8> {
    protocol::build_identity().to_vec()
}

/// Creates a new workbook from an encoded replica namespace.
///
/// On success JavaScript receives the workbook's canonical snapshot as a
/// `Uint8Array`. Invalid or non-canonical inputs throw a JavaScript `Error`
/// whose message retains the protocol's stable error code.
#[wasm_bindgen(js_name = createWorkbook)]
#[cfg(feature = "legacy-spreadsheet")]
pub fn create_workbook(namespace_envelope: &[u8]) -> Result<Vec<u8>, JsError> {
    create_workbook_bytes(namespace_envelope).map_err(to_js_error)
}

/// Atomically applies an encoded command batch to a canonical snapshot.
///
/// Neither input is mutated. A rejected command leaves the supplied snapshot
/// untouched and is surfaced as a JavaScript `Error`.
#[wasm_bindgen(js_name = applyCommands)]
#[cfg(feature = "legacy-spreadsheet")]
pub fn apply_commands(snapshot: &[u8], command_envelope: &[u8]) -> Result<Vec<u8>, JsError> {
    apply_commands_bytes(snapshot, command_envelope).map_err(to_js_error)
}

/// Executes one bounded OGAKQ001 read against a canonical snapshot.
#[wasm_bindgen(js_name = query)]
#[cfg(feature = "legacy-spreadsheet")]
pub fn query(snapshot: &[u8], query_envelope: &[u8]) -> Result<Vec<u8>, JsError> {
    query_bytes(snapshot, query_envelope).map_err(to_js_error)
}

/// Strictly validates and re-encodes a snapshot in canonical form.
#[wasm_bindgen(js_name = canonicalizeSnapshot)]
#[cfg(feature = "legacy-spreadsheet")]
pub fn canonicalize_snapshot(snapshot: &[u8]) -> Result<Vec<u8>, JsError> {
    canonicalize_snapshot_bytes(snapshot).map_err(to_js_error)
}

/// Strictly validates and re-encodes a full OGACRD01 collaboration snapshot.
#[wasm_bindgen(js_name = canonicalizeCollaborationSnapshot)]
#[cfg(feature = "spreadsheet")]
pub fn canonicalize_collaboration_snapshot(snapshot: &[u8]) -> Result<Vec<u8>, JsError> {
    protocol::canonicalize_collaboration_snapshot_with_limits(snapshot, protocol::WASM_LIMITS)
        .map_err(to_js_error)
}

/// Stateful, in-memory kernel handle for interactive editing.
///
/// A session validates/decodes once, applies many command envelopes directly
/// to the in-memory model, and serializes only when `snapshot()` is requested.
/// It remains synchronous so one Web Worker observes mutations in program
/// order without locks or asynchronous re-entrancy.
#[wasm_bindgen]
#[cfg(feature = "legacy-spreadsheet")]
pub struct ArtifactKernelSession {
    inner: protocol::BindingSession,
}

#[wasm_bindgen]
#[cfg(feature = "legacy-spreadsheet")]
impl ArtifactKernelSession {
    /// Creates an empty in-memory workbook from a canonical namespace envelope.
    #[wasm_bindgen(js_name = create)]
    pub fn create(namespace_envelope: &[u8]) -> Result<ArtifactKernelSession, JsError> {
        protocol::BindingSession::create_with_limits(namespace_envelope, protocol::WASM_LIMITS)
            .map(|inner| Self { inner })
            .map_err(to_js_error)
    }

    /// Opens and validates one canonical snapshot into memory.
    #[wasm_bindgen(js_name = open)]
    pub fn open(snapshot: &[u8]) -> Result<ArtifactKernelSession, JsError> {
        protocol::BindingSession::open_with_limits(snapshot, protocol::WASM_LIMITS)
            .map(|inner| Self { inner })
            .map_err(to_js_error)
    }

    /// Atomically applies a command envelope and returns its canonical receipt.
    #[wasm_bindgen(js_name = applyCommands)]
    pub fn apply_commands(&mut self, command_envelope: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner
            .apply_commands(command_envelope)
            .map_err(to_js_error)
    }

    /// Serializes the current workbook as a canonical snapshot.
    pub fn snapshot(&self) -> Result<Vec<u8>, JsError> {
        self.inner.snapshot().map_err(to_js_error)
    }

    /// Returns the current workbook revision as a JavaScript `bigint`.
    pub fn revision(&self) -> Result<u64, JsError> {
        self.inner.revision().map_err(to_js_error)
    }

    /// Executes one bounded viewport or workbook-metadata projection.
    pub fn query(&self, query_envelope: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner.query(query_envelope).map_err(to_js_error)
    }

    /// Creates an independent in-memory branch without snapshot round trips.
    pub fn fork(&self) -> Result<ArtifactKernelSession, JsError> {
        self.inner
            .fork()
            .map(|inner| Self { inner })
            .map_err(to_js_error)
    }

    /// Returns SHA-256 of the exact canonical snapshot as lowercase text.
    #[wasm_bindgen(js_name = stateHash)]
    pub fn state_hash(&self) -> Result<String, JsError> {
        self.inner.state_hash().map_err(to_js_error)
    }

    /// Releases the in-memory workbook while retaining a closed JS handle.
    ///
    /// Calling this method repeatedly is safe. Further model operations return
    /// the stable `ARTIFACT_SESSION_CLOSED` protocol error.
    pub fn close(&mut self) {
        self.inner.close();
    }

    /// Idempotent lifecycle alias for `close()`.
    ///
    /// JavaScript may call `free()` afterward to release the small Wasm handle
    /// itself; generated explicit-resource-management support does that
    /// automatically for `using` declarations.
    pub fn dispose(&mut self) {
        self.inner.close();
    }

    /// Reports whether the workbook state has already been released.
    #[wasm_bindgen(js_name = isClosed)]
    pub fn is_closed(&self) -> bool {
        self.inner.is_closed()
    }
}

/// Stateful authoritative collaboration/CRDT kernel handle.
#[wasm_bindgen]
#[cfg(feature = "spreadsheet")]
pub struct ArtifactCollaborationSession {
    inner: protocol::CollaborationBindingSession,
}

#[wasm_bindgen]
#[cfg(feature = "spreadsheet")]
impl ArtifactCollaborationSession {
    /// Creates an empty CRDT workbook from a canonical namespace envelope.
    #[wasm_bindgen(js_name = create)]
    pub fn create(namespace_envelope: &[u8]) -> Result<ArtifactCollaborationSession, JsError> {
        protocol::CollaborationBindingSession::create_with_limits(
            namespace_envelope,
            protocol::WASM_LIMITS,
        )
        .map(|inner| Self { inner })
        .map_err(to_js_error)
    }

    /// Opens one canonical OGACRD01 full-state snapshot.
    #[wasm_bindgen(js_name = open)]
    pub fn open(snapshot: &[u8]) -> Result<ArtifactCollaborationSession, JsError> {
        protocol::CollaborationBindingSession::open_with_limits(snapshot, protocol::WASM_LIMITS)
            .map(|inner| Self { inner })
            .map_err(to_js_error)
    }

    /// Authors and applies one canonical OGATX001 transaction.
    #[wasm_bindgen(js_name = authorTransaction)]
    pub fn author_transaction(
        &mut self,
        intent_bytes: &[u8],
        resolved_base: &[u8],
    ) -> Result<Vec<u8>, JsError> {
        self.inner
            .author_transaction(intent_bytes, resolved_base)
            .map_err(to_js_error)
    }

    /// Replays one whole canonical committed transaction atomically.
    #[wasm_bindgen(js_name = applyCommitted)]
    pub fn apply_committed(&mut self, operation_envelope: &[u8]) -> Result<(), JsError> {
        self.inner
            .apply_committed(operation_envelope)
            .map_err(to_js_error)
    }

    /// Executes one bounded viewport or workbook-metadata projection.
    pub fn query(&self, query_envelope: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner.query(query_envelope).map_err(to_js_error)
    }

    /// Returns the full canonical OGACRD01 snapshot.
    pub fn snapshot(&self) -> Result<Vec<u8>, JsError> {
        self.inner.snapshot().map_err(to_js_error)
    }

    /// Returns the canonical OGACF001 causal frontier.
    pub fn frontier(&self) -> Result<Vec<u8>, JsError> {
        self.inner.frontier().map_err(to_js_error)
    }

    /// Returns SHA-256 of the exact canonical OGACRD01 snapshot.
    #[wasm_bindgen(js_name = stateHash)]
    pub fn state_hash(&self) -> Result<String, JsError> {
        self.inner.state_hash().map_err(to_js_error)
    }

    /// Returns the materialized workbook revision as a JavaScript `bigint`.
    pub fn revision(&self) -> Result<u64, JsError> {
        self.inner.revision().map_err(to_js_error)
    }

    /// Creates an independent in-memory collaboration branch.
    pub fn fork(&self) -> Result<ArtifactCollaborationSession, JsError> {
        self.inner
            .fork()
            .map(|inner| Self { inner })
            .map_err(to_js_error)
    }

    /// Releases the in-memory collaboration state.
    pub fn close(&mut self) {
        self.inner.close();
    }

    /// Idempotent lifecycle alias for `close()`.
    pub fn dispose(&mut self) {
        self.inner.close();
    }

    /// Reports whether the collaboration state has been released.
    #[wasm_bindgen(js_name = isClosed)]
    pub fn is_closed(&self) -> bool {
        self.inner.is_closed()
    }
}

#[cfg(any(feature = "legacy-spreadsheet", test))]
fn create_workbook_bytes(namespace_envelope: &[u8]) -> Result<Vec<u8>, protocol::BindingError> {
    protocol::create_workbook_with_limits(namespace_envelope, protocol::WASM_LIMITS)
}

#[cfg(any(feature = "legacy-spreadsheet", test))]
fn apply_commands_bytes(
    snapshot: &[u8],
    command_envelope: &[u8],
) -> Result<Vec<u8>, protocol::BindingError> {
    protocol::apply_commands_with_limits(snapshot, command_envelope, protocol::WASM_LIMITS)
}

#[cfg(any(feature = "legacy-spreadsheet", test))]
fn canonicalize_snapshot_bytes(snapshot: &[u8]) -> Result<Vec<u8>, protocol::BindingError> {
    protocol::canonicalize_snapshot_with_limits(snapshot, protocol::WASM_LIMITS)
}

#[cfg(any(feature = "legacy-spreadsheet", test))]
fn query_bytes(snapshot: &[u8], query_envelope: &[u8]) -> Result<Vec<u8>, protocol::BindingError> {
    protocol::query_with_limits(snapshot, query_envelope, protocol::WASM_LIMITS)
}

#[cfg(any(feature = "spreadsheet", feature = "legacy-spreadsheet", test))]
fn to_js_error(error: protocol::BindingError) -> JsError {
    JsError::new(&error_message(&error))
}

#[cfg(any(feature = "spreadsheet", feature = "legacy-spreadsheet", test))]
fn error_message(error: &protocol::BindingError) -> String {
    // Match the native adapter exactly so diagnostics remain comparable.
    format!("[{}] {error}", error.code())
}

#[cfg(test)]
mod tests {
    use super::{
        apply_commands_bytes, build_identity, canonicalize_snapshot_bytes, capabilities,
        create_workbook_bytes, error_message, protocol, query_bytes, ArtifactCollaborationSession,
        ArtifactKernelSession,
    };
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
    fn metadata_returns_owned_nonempty_envelopes() {
        let mut first_capabilities = capabilities();
        let expected_capabilities = first_capabilities.clone();
        assert!(!first_capabilities.is_empty());
        assert!(!build_identity().is_empty());
        let text = core::str::from_utf8(&first_capabilities).expect("capabilities are UTF-8");
        assert!(text.contains("\"maxSnapshotBytes\":67108864"));
        assert!(text.contains("\"maxCommandBytes\":8388608"));
        assert!(text.contains("\"maxCellsPerBatch\":500000"));
        assert!(text.contains("\"sessionForks\":true"));

        first_capabilities.fill(0);
        assert_eq!(capabilities(), expected_capabilities);
    }

    #[test]
    fn creates_and_canonicalizes_a_workbook() {
        let namespace = protocol::encode_namespace(0x1234_5678_9abc_def0);
        let snapshot = create_workbook_bytes(&namespace).expect("namespace envelope is valid");
        let canonical =
            canonicalize_snapshot_bytes(&snapshot).expect("created snapshot is canonical");
        assert_eq!(canonical, snapshot);
    }

    #[test]
    fn applies_an_atomic_batch_without_semantic_drift() {
        let namespace_value = 7;
        let namespace = protocol::encode_namespace(namespace_value);
        let snapshot = create_workbook_bytes(&namespace).expect("namespace envelope is valid");
        let sheet_id = StableId::from_parts(namespace_value, 2);
        let batch = AtomicBatch::from_commands(vec![Command::CreateSheet {
            id: sheet_id,
            name: "Summary".into(),
        }]);
        let commands = protocol::encode_command_batch(&batch).expect("command batch is encodable");
        let applied = apply_commands_bytes(&snapshot, &commands).expect("atomic batch is valid");
        let canonical =
            canonicalize_snapshot_bytes(&applied).expect("apply result must be canonical");
        assert_eq!(applied, canonical);
        let workbook = decode_snapshot(&applied).expect("decode applied snapshot");
        assert_eq!(workbook.revision(), 1);
        assert_eq!(
            workbook.sheet(sheet_id).expect("created sheet").name(),
            "Summary"
        );
    }

    #[test]
    fn malformed_inputs_preserve_stable_error_codes() {
        let error = create_workbook_bytes(&[0xff]).expect_err("invalid envelope must fail");
        assert!(!error.code().is_empty());
        assert!(error_message(&error).starts_with('['));
        assert!(error_message(&error).contains("] "));

        let error = canonicalize_snapshot_bytes(&[0xff]).expect_err("invalid snapshot must fail");
        assert!(!error.code().is_empty());
        assert!(error_message(&error).starts_with('['));
        assert!(error_message(&error).contains("] "));
    }

    #[test]
    fn stateful_session_applies_without_snapshot_round_trips() {
        let namespace_value = 84;
        let namespace = protocol::encode_namespace(namespace_value);
        let mut session = ArtifactKernelSession::create(&namespace).expect("create session");
        let initial = session.snapshot().expect("initial snapshot");

        let sheet_id = StableId::from_parts(namespace_value, 2);
        let batch = AtomicBatch::from_commands(vec![Command::CreateSheet {
            id: sheet_id,
            name: "Data".into(),
        }]);
        let commands = protocol::encode_command_batch(&batch).expect("encode commands");
        let receipt = session
            .apply_commands(&commands)
            .expect("apply commands to session");
        assert!(!receipt.is_empty());

        let updated = session.snapshot().expect("updated snapshot");
        assert_ne!(initial, updated);
        let workbook = decode_snapshot(&updated).expect("decode updated snapshot");
        assert_eq!(workbook.revision(), 1);
        assert_eq!(workbook.sheet(sheet_id).expect("sheet").name(), "Data");

        let reopened = ArtifactKernelSession::open(&updated).expect("reopen session");
        assert_eq!(
            reopened.snapshot().expect("reopened snapshot"),
            session.snapshot().expect("source snapshot")
        );
        assert_eq!(session.revision().expect("revision"), 1);

        let stateless = apply_commands_bytes(&initial, &commands).expect("stateless apply");
        assert_eq!(updated, stateless);
    }

    #[test]
    fn bounded_query_matches_shared_protocol_and_native_limits() {
        let namespace_value = 0x4343;
        let namespace = protocol::encode_namespace(namespace_value);
        let sheet_id = StableId::from_parts(namespace_value, 9);
        let mut session = ArtifactKernelSession::create(&namespace).expect("session");
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
        session.apply_commands(&commands).expect("seed");
        let request = protocol::encode_viewport_query(protocol::ViewportQuery {
            sheet_id,
            start: CellCoord::new(20, 30),
            rows: 1,
            columns: 2,
            max_cells: u32::MAX,
            max_bytes: u32::MAX,
        })
        .expect("query");
        let wasm = session.query(&request).expect("session query");
        let stateless =
            query_bytes(&session.snapshot().expect("snapshot"), &request).expect("stateless query");
        assert_eq!(wasm, stateless);

        let native = protocol::query(&session.snapshot().expect("snapshot"), &request)
            .expect("native-profile query");
        assert_eq!(wasm, native);
    }

    #[test]
    fn collaboration_query_and_lifecycle_match_native_binding() {
        let namespace = protocol::encode_namespace(0x4545);
        let mut wasm = ArtifactCollaborationSession::create(&namespace).expect("wasm session");
        let mut native =
            protocol::CollaborationBindingSession::create(&namespace).expect("native session");
        let intent = unhex(COLLABORATION_PARITY_INTENT);
        let base = unhex(EMPTY_FRONTIER);
        let wasm_committed = wasm
            .author_transaction(&intent, &base)
            .expect("wasm author");
        let native_committed = native
            .author_transaction(&intent, &base)
            .expect("native author");
        assert_eq!(wasm_committed, native_committed);
        assert_eq!(
            wasm.snapshot().expect("wasm snapshot"),
            native.snapshot().expect("native snapshot")
        );
        assert_eq!(
            wasm.frontier().expect("wasm frontier"),
            native.frontier().expect("native frontier")
        );
        assert_eq!(
            wasm.state_hash().expect("wasm hash"),
            native.state_hash().expect("native hash")
        );

        let mut wasm_replay =
            ArtifactCollaborationSession::create(&namespace).expect("wasm replay");
        let mut native_replay =
            protocol::CollaborationBindingSession::create(&namespace).expect("native replay");
        wasm_replay
            .apply_committed(&wasm_committed)
            .expect("wasm replay committed");
        native_replay
            .apply_committed(&native_committed)
            .expect("native replay committed");
        assert_eq!(
            wasm_replay.snapshot().expect("wasm replay snapshot"),
            native_replay.snapshot().expect("native replay snapshot")
        );
        wasm_replay
            .apply_committed(&wasm_committed)
            .expect("wasm duplicate is idempotent");
        native_replay
            .apply_committed(&native_committed)
            .expect("native duplicate is idempotent");
        let request = protocol::encode_workbook_metadata_query(protocol::WorkbookMetadataQuery {
            max_sheets: u32::MAX,
            max_bytes: u32::MAX,
        })
        .expect("metadata query");
        assert_eq!(
            wasm.query(&request).expect("wasm query"),
            native.query(&request).expect("native query")
        );
        let branch = wasm.fork().expect("fork");
        assert_eq!(
            branch.snapshot().expect("branch snapshot"),
            wasm.snapshot().expect("source snapshot")
        );
        assert_eq!(
            branch.frontier().expect("branch frontier"),
            wasm.frontier().expect("source frontier")
        );
        wasm.close();
        wasm.dispose();
        assert!(wasm.is_closed());
        assert!(matches!(
            wasm.inner.query(&request),
            Err(protocol::BindingError::Closed)
        ));
    }

    #[test]
    fn session_lifecycle_and_namespace_errors_are_typed() {
        let zero_namespace = protocol::encode_namespace(0);
        let error = create_workbook_bytes(&zero_namespace).expect_err("zero namespace must fail");
        assert_eq!(error.code(), "ARTIFACT_INVALID_NAMESPACE");

        let namespace = protocol::encode_namespace(99);
        let mut session = protocol::BindingSession::create(&namespace).expect("session");
        session.close();
        session.close();
        assert!(session.is_closed());
        let error = session.snapshot().expect_err("closed session must fail");
        assert_eq!(error.code(), "ARTIFACT_SESSION_CLOSED");
    }

    #[test]
    fn session_fork_and_hash_are_independent() {
        use sha2::{Digest, Sha256};

        let namespace_value = 5150;
        let namespace = protocol::encode_namespace(namespace_value);
        let source = ArtifactKernelSession::create(&namespace).expect("source");
        let mut branch = source.fork().expect("fork");
        assert_eq!(
            source.state_hash().expect("source hash"),
            branch.state_hash().expect("branch hash")
        );

        let sheet_id = StableId::from_parts(namespace_value, 2);
        let commands = protocol::encode_command_batch(&AtomicBatch::from_commands(vec![
            Command::CreateSheet {
                id: sheet_id,
                name: "Branch".into(),
            },
        ]))
        .expect("commands");
        branch.apply_commands(&commands).expect("branch mutation");
        assert_eq!(source.revision().expect("source revision"), 0);
        assert_eq!(branch.revision().expect("branch revision"), 1);
        assert_ne!(
            source.state_hash().expect("source hash"),
            branch.state_hash().expect("branch hash")
        );

        let snapshot = source.snapshot().expect("snapshot");
        assert_eq!(
            source.state_hash().expect("state hash"),
            format!("sha256:{:x}", Sha256::digest(snapshot))
        );
    }
}
