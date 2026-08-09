//! WebAssembly byte adapter for the deterministic presentation kernel.

use opengeni_artifact_kernel_binding_protocol as protocol;
use wasm_bindgen::{prelude::wasm_bindgen, JsError};

fn to_js_error(error: protocol::BindingError) -> JsError {
    JsError::new(&format!("[{}] {error}", error.code()))
}

pub(crate) fn create_presentation_bytes(
    namespace_envelope: &[u8],
) -> Result<Vec<u8>, protocol::BindingError> {
    protocol::PresentationBindingSession::create_with_limits(
        namespace_envelope,
        protocol::WASM_LIMITS,
    )?
    .snapshot()
}

pub(crate) fn apply_presentation_commands_bytes(
    snapshot: &[u8],
    command_envelope: &[u8],
) -> Result<Vec<u8>, protocol::BindingError> {
    let mut session =
        protocol::PresentationBindingSession::open_with_limits(snapshot, protocol::WASM_LIMITS)?;
    session.apply_commands(command_envelope)?;
    session.snapshot()
}

pub(crate) fn query_presentation_bytes(
    snapshot: &[u8],
    query_envelope: &[u8],
) -> Result<Vec<u8>, protocol::BindingError> {
    protocol::PresentationBindingSession::open_with_limits(snapshot, protocol::WASM_LIMITS)?
        .query(query_envelope)
}

pub(crate) fn canonicalize_presentation_snapshot_bytes(
    snapshot: &[u8],
) -> Result<Vec<u8>, protocol::BindingError> {
    protocol::PresentationBindingSession::open_with_limits(snapshot, protocol::WASM_LIMITS)?
        .snapshot()
}

/// Creates an empty presentation from a canonical namespace envelope.
#[wasm_bindgen(js_name = createPresentation)]
pub fn create_presentation(namespace_envelope: &[u8]) -> Result<Vec<u8>, JsError> {
    create_presentation_bytes(namespace_envelope).map_err(to_js_error)
}

/// Atomically applies one OGAPC001 command envelope to an OGAPRS01 snapshot.
#[wasm_bindgen(js_name = applyPresentationCommands)]
pub fn apply_presentation_commands(
    snapshot: &[u8],
    command_envelope: &[u8],
) -> Result<Vec<u8>, JsError> {
    apply_presentation_commands_bytes(snapshot, command_envelope).map_err(to_js_error)
}

/// Executes one bounded OGAPQ001 presentation projection query.
#[wasm_bindgen(js_name = queryPresentation)]
pub fn query_presentation(snapshot: &[u8], query_envelope: &[u8]) -> Result<Vec<u8>, JsError> {
    query_presentation_bytes(snapshot, query_envelope).map_err(to_js_error)
}

/// Strictly validates and re-encodes one canonical OGAPRS01 snapshot.
#[wasm_bindgen(js_name = canonicalizePresentationSnapshot)]
pub fn canonicalize_presentation_snapshot(snapshot: &[u8]) -> Result<Vec<u8>, JsError> {
    canonicalize_presentation_snapshot_bytes(snapshot).map_err(to_js_error)
}

/// Stateful WebAssembly presentation-kernel handle.
#[wasm_bindgen]
pub struct ArtifactPresentationSession {
    inner: protocol::PresentationBindingSession,
}

#[wasm_bindgen]
impl ArtifactPresentationSession {
    /// Creates an empty in-memory presentation from a canonical namespace envelope.
    #[wasm_bindgen(js_name = create)]
    pub fn create(namespace_envelope: &[u8]) -> Result<ArtifactPresentationSession, JsError> {
        protocol::PresentationBindingSession::create_with_limits(
            namespace_envelope,
            protocol::WASM_LIMITS,
        )
        .map(|inner| Self { inner })
        .map_err(to_js_error)
    }

    /// Opens one validated canonical OGAPRS01 snapshot.
    #[wasm_bindgen(js_name = open)]
    pub fn open(snapshot: &[u8]) -> Result<ArtifactPresentationSession, JsError> {
        protocol::PresentationBindingSession::open_with_limits(snapshot, protocol::WASM_LIMITS)
            .map(|inner| Self { inner })
            .map_err(to_js_error)
    }

    /// Applies one complete command transaction and returns its OGAPR001 receipt.
    #[wasm_bindgen(js_name = applyCommands)]
    pub fn apply_commands(&mut self, command_envelope: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner
            .apply_commands(command_envelope)
            .map_err(to_js_error)
    }

    /// Serializes the exact canonical presentation snapshot.
    pub fn snapshot(&self) -> Result<Vec<u8>, JsError> {
        self.inner.snapshot().map_err(to_js_error)
    }

    /// Returns the current presentation revision as a JavaScript bigint.
    pub fn revision(&self) -> Result<u64, JsError> {
        self.inner.revision().map_err(to_js_error)
    }

    /// Executes one bounded presentation projection query.
    pub fn query(&self, query_envelope: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner.query(query_envelope).map_err(to_js_error)
    }

    /// Returns SHA-256 of the exact canonical snapshot.
    #[wasm_bindgen(js_name = stateHash)]
    pub fn state_hash(&self) -> Result<String, JsError> {
        self.inner.state_hash().map_err(to_js_error)
    }

    /// Creates an independent in-memory presentation branch.
    pub fn fork(&self) -> Result<ArtifactPresentationSession, JsError> {
        self.inner
            .fork()
            .map(|inner| Self { inner })
            .map_err(to_js_error)
    }

    /// Releases the in-memory presentation state.
    pub fn close(&mut self) {
        self.inner.close();
    }

    /// Idempotent explicit-resource-management alias for close.
    pub fn dispose(&mut self) {
        self.inner.close();
    }

    /// Reports whether presentation state has been released.
    #[wasm_bindgen(js_name = isClosed)]
    pub fn is_closed(&self) -> bool {
        self.inner.is_closed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opengeni_artifact_kernel::presentation::{
        Color, Fill, PresentationBatch, PresentationCommand, SlideSize, EMU_PER_CSS_PIXEL,
    };
    use opengeni_artifact_kernel::StableId;

    fn seeded_command(namespace: u64) -> Vec<u8> {
        protocol::encode_presentation_command_batch(&PresentationBatch::from_commands(vec![
            PresentationCommand::SetPresentationSize {
                size: SlideSize::new(960 * EMU_PER_CSS_PIXEL, 540 * EMU_PER_CSS_PIXEL)
                    .expect("custom size"),
            },
            PresentationCommand::CreateSlide {
                id: StableId::from_parts(namespace, 2),
                index: 0,
                title: "Wasm parity".to_owned(),
                layout_id: None,
                background: Fill::Solid(Color::WHITE),
            },
        ]))
        .expect("presentation command")
    }

    #[test]
    fn presentation_wasm_profile_matches_native_protocol_bytes_exactly() {
        let namespace_value = 0x5052_4553;
        let namespace = protocol::encode_namespace(namespace_value);
        let command = seeded_command(namespace_value);
        let wasm_initial = create_presentation_bytes(&namespace).expect("wasm create");
        let native_initial = protocol::create_presentation(&namespace).expect("native create");
        assert_eq!(wasm_initial, native_initial);

        let wasm_updated =
            apply_presentation_commands_bytes(&wasm_initial, &command).expect("wasm apply");
        let native_updated =
            protocol::apply_presentation_commands(&native_initial, &command).expect("native apply");
        assert_eq!(wasm_updated, native_updated);

        let query =
            protocol::encode_presentation_metadata_query(protocol::PresentationMetadataQuery {
                max_bytes: 1_024,
            })
            .expect("metadata query");
        let wasm_query = query_presentation_bytes(&wasm_updated, &query).expect("wasm query");
        assert_eq!(
            wasm_query,
            protocol::query_presentation_snapshot(&native_updated, &query).expect("native query")
        );
        assert!(matches!(
            protocol::decode_presentation_query_response(&wasm_query).expect("decode metadata"),
            protocol::PresentationQueryResponse::Metadata(metadata)
                if metadata.slide_size
                    == SlideSize::new(960 * EMU_PER_CSS_PIXEL, 540 * EMU_PER_CSS_PIXEL)
                        .expect("custom size")
        ));
        for query in [
            protocol::encode_presentation_slide_catalog_query(
                protocol::PresentationSlideCatalogQuery {
                    start_slide: 0,
                    max_slides: 8,
                    max_text_bytes: 1_024,
                    max_bytes: 4_096,
                },
            )
            .expect("catalog query"),
            protocol::encode_presentation_editor_slide_query(
                protocol::PresentationEditorSlideQuery {
                    slide_id: StableId::from_parts(namespace_value, 2),
                    max_nodes: 16,
                    max_text_bytes: 4_096,
                    max_bytes: 16_384,
                },
            )
            .expect("editor query"),
        ] {
            assert_eq!(
                query_presentation_bytes(&wasm_updated, &query).expect("wasm projection"),
                protocol::query_presentation_snapshot(&native_updated, &query)
                    .expect("native projection")
            );
        }
        assert_eq!(
            canonicalize_presentation_snapshot_bytes(&wasm_updated).expect("wasm canonical"),
            native_updated
        );

        let mut session = ArtifactPresentationSession::create(&namespace).expect("session");
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
