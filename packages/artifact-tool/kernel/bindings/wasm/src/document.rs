//! WebAssembly byte adapter for the structured-document kernel.

use opengeni_artifact_kernel_binding_protocol as protocol;
use wasm_bindgen::{prelude::wasm_bindgen, JsError};

fn to_js_error(error: protocol::BindingError) -> JsError {
    JsError::new(&format!("[{}] {error}", error.code()))
}

pub(crate) fn create_document_bytes(
    namespace_envelope: &[u8],
) -> Result<Vec<u8>, protocol::BindingError> {
    protocol::create_document_with_limits(namespace_envelope, protocol::WASM_LIMITS)
}

pub(crate) fn apply_document_commands_bytes(
    snapshot: &[u8],
    command_envelope: &[u8],
) -> Result<Vec<u8>, protocol::BindingError> {
    protocol::apply_document_commands_with_limits(snapshot, command_envelope, protocol::WASM_LIMITS)
}

pub(crate) fn query_document_bytes(
    snapshot: &[u8],
    query_envelope: &[u8],
) -> Result<Vec<u8>, protocol::BindingError> {
    protocol::query_document_with_limits(snapshot, query_envelope, protocol::WASM_LIMITS)
}

pub(crate) fn canonicalize_document_snapshot_bytes(
    snapshot: &[u8],
) -> Result<Vec<u8>, protocol::BindingError> {
    protocol::canonicalize_document_snapshot_with_limits(snapshot, protocol::WASM_LIMITS)
}

/// Creates an empty document from a canonical namespace envelope.
#[wasm_bindgen(js_name = createDocument)]
pub fn create_document(namespace_envelope: &[u8]) -> Result<Vec<u8>, JsError> {
    create_document_bytes(namespace_envelope).map_err(to_js_error)
}

/// Atomically applies one OGADC001 command envelope to an OGADOC01 snapshot.
#[wasm_bindgen(js_name = applyDocumentCommands)]
pub fn apply_document_commands(
    snapshot: &[u8],
    command_envelope: &[u8],
) -> Result<Vec<u8>, JsError> {
    apply_document_commands_bytes(snapshot, command_envelope).map_err(to_js_error)
}

/// Executes one bounded OGADQ001 document projection query.
#[wasm_bindgen(js_name = queryDocument)]
pub fn query_document(snapshot: &[u8], query_envelope: &[u8]) -> Result<Vec<u8>, JsError> {
    query_document_bytes(snapshot, query_envelope).map_err(to_js_error)
}

/// Strictly validates and re-encodes one canonical OGADOC01 snapshot.
#[wasm_bindgen(js_name = canonicalizeDocumentSnapshot)]
pub fn canonicalize_document_snapshot(snapshot: &[u8]) -> Result<Vec<u8>, JsError> {
    canonicalize_document_snapshot_bytes(snapshot).map_err(to_js_error)
}

/// Stateful WebAssembly structured-document kernel handle.
#[wasm_bindgen]
pub struct ArtifactDocumentSession {
    inner: protocol::DocumentBindingSession,
}

#[wasm_bindgen]
impl ArtifactDocumentSession {
    /// Creates an empty in-memory document from a canonical namespace envelope.
    #[wasm_bindgen(js_name = create)]
    pub fn create(namespace_envelope: &[u8]) -> Result<ArtifactDocumentSession, JsError> {
        protocol::DocumentBindingSession::create_with_limits(
            namespace_envelope,
            protocol::WASM_LIMITS,
        )
        .map(|inner| Self { inner })
        .map_err(to_js_error)
    }

    /// Opens one validated canonical OGADOC01 snapshot.
    #[wasm_bindgen(js_name = open)]
    pub fn open(snapshot: &[u8]) -> Result<ArtifactDocumentSession, JsError> {
        protocol::DocumentBindingSession::open_with_limits(snapshot, protocol::WASM_LIMITS)
            .map(|inner| Self { inner })
            .map_err(to_js_error)
    }

    /// Applies one complete transaction and returns an OGADR001 receipt.
    #[wasm_bindgen(js_name = applyCommands)]
    pub fn apply_commands(&mut self, command_envelope: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner
            .apply_commands(command_envelope)
            .map_err(to_js_error)
    }

    /// Serializes the exact canonical document snapshot.
    pub fn snapshot(&self) -> Result<Vec<u8>, JsError> {
        self.inner.snapshot().map_err(to_js_error)
    }

    /// Returns the current document revision as a JavaScript bigint.
    pub fn revision(&self) -> Result<u64, JsError> {
        self.inner.revision().map_err(to_js_error)
    }

    /// Executes one bounded document projection query.
    pub fn query(&self, query_envelope: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner.query(query_envelope).map_err(to_js_error)
    }

    /// Creates an independent in-memory branch.
    pub fn fork(&self) -> Result<ArtifactDocumentSession, JsError> {
        self.inner
            .fork()
            .map(|inner| Self { inner })
            .map_err(to_js_error)
    }

    /// Returns SHA-256 of the exact canonical snapshot.
    #[wasm_bindgen(js_name = stateHash)]
    pub fn state_hash(&self) -> Result<String, JsError> {
        self.inner.state_hash().map_err(to_js_error)
    }

    /// Releases the in-memory document state.
    pub fn close(&mut self) {
        self.inner.close();
    }

    /// Idempotent explicit-resource-management alias for close.
    pub fn dispose(&mut self) {
        self.inner.close();
    }

    /// Reports whether document state has been released.
    #[wasm_bindgen(js_name = isClosed)]
    pub fn is_closed(&self) -> bool {
        self.inner.is_closed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opengeni_artifact_kernel::document::{
        DocumentBatch, DocumentCommand, DocumentId, DocumentIdKind, DocumentProjectionItem,
        DocumentQuery, DocumentQueryLimits, PageGeometry, PageGeometryProjection, ParagraphStyle,
        StoryTarget, TextRun,
    };

    fn seeded_command(namespace: u64) -> Vec<u8> {
        protocol::encode_document_command_batch(&DocumentBatch::from_commands(vec![
            DocumentCommand::AddParagraph {
                target: StoryTarget::Body,
                id: DocumentId::new(DocumentIdKind::Paragraph, namespace, 8).expect("id"),
                runs: vec![TextRun::plain("wasm parity")],
                style: ParagraphStyle::default(),
            },
            DocumentCommand::SetSectionPage {
                id: DocumentId::new(DocumentIdKind::Section, namespace, 1).expect("section id"),
                page: PageGeometry {
                    width_pt: 792.0,
                    height_pt: 612.0,
                    margin_top_pt: 54.0,
                    margin_right_pt: 54.0,
                    margin_bottom_pt: 54.0,
                    margin_left_pt: 54.0,
                    header_pt: 27.5,
                    footer_pt: 31.25,
                    gutter_pt: 9.5,
                },
            },
        ]))
        .expect("command")
    }

    #[test]
    fn document_wasm_profile_matches_native_protocol_bytes_exactly() {
        let namespace_value = 0x5741534d;
        let namespace = protocol::encode_namespace(namespace_value);
        let command = seeded_command(namespace_value);
        let wasm_initial = create_document_bytes(&namespace).expect("wasm create");
        let native_initial = protocol::create_document(&namespace).expect("native create");
        assert_eq!(wasm_initial, native_initial);

        let wasm_updated =
            apply_document_commands_bytes(&wasm_initial, &command).expect("wasm apply");
        let native_updated =
            protocol::apply_document_commands(&native_initial, &command).expect("native apply");
        assert_eq!(wasm_updated, native_updated);

        let query = protocol::encode_document_query(DocumentQuery::Body {
            start_block: 0,
            limits: DocumentQueryLimits::default(),
        })
        .expect("query");
        assert_eq!(
            query_document_bytes(&wasm_updated, &query).expect("wasm query"),
            protocol::query_document(&native_updated, &query).expect("native query")
        );
        let summary_query =
            protocol::encode_document_query(DocumentQuery::Summary).expect("summary query");
        let summary = query_document_bytes(&wasm_updated, &summary_query).expect("wasm summary");
        assert!(matches!(
            protocol::decode_document_query_response(&summary)
                .expect("decode wasm summary")
                .items
                .as_slice(),
            [DocumentProjectionItem::Summary(item)]
                if item.page == PageGeometryProjection::from(PageGeometry {
                    width_pt: 792.0,
                    height_pt: 612.0,
                    margin_top_pt: 54.0,
                    margin_right_pt: 54.0,
                    margin_bottom_pt: 54.0,
                    margin_left_pt: 54.0,
                    header_pt: 27.5,
                    footer_pt: 31.25,
                    gutter_pt: 9.5,
                })
        ));
        assert_eq!(
            canonicalize_document_snapshot_bytes(&wasm_updated).expect("wasm canonical"),
            native_updated
        );

        let mut session = ArtifactDocumentSession::create(&namespace).expect("session");
        session.apply_commands(&command).expect("session apply");
        assert_eq!(session.snapshot().expect("session snapshot"), wasm_updated);
        let branch = session.fork().expect("fork");
        assert_eq!(
            branch.state_hash().expect("branch hash"),
            session.state_hash().expect("hash")
        );
        session.close();
        session.dispose();
        assert!(session.is_closed());
        assert!(matches!(
            session.inner.snapshot(),
            Err(protocol::BindingError::Closed)
        ));
    }
}
