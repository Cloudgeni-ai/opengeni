use napi::bindgen_prelude::Buffer;
use napi::Result;
use napi_derive::napi;
use opengeni_artifact_kernel_binding_protocol as protocol;

use super::binding_error;

#[napi(js_name = "createPresentation", strict)]
pub fn create_presentation(namespace_envelope: Buffer) -> Result<Buffer> {
    protocol::create_presentation(namespace_envelope.as_ref())
        .map(Buffer::from)
        .map_err(binding_error)
}

#[napi(js_name = "applyPresentationCommands", strict)]
pub fn apply_presentation_commands(snapshot: Buffer, command_envelope: Buffer) -> Result<Buffer> {
    protocol::apply_presentation_commands(snapshot.as_ref(), command_envelope.as_ref())
        .map(Buffer::from)
        .map_err(binding_error)
}

#[napi(js_name = "queryPresentation", strict)]
pub fn query_presentation(snapshot: Buffer, query_envelope: Buffer) -> Result<Buffer> {
    protocol::query_presentation_snapshot(snapshot.as_ref(), query_envelope.as_ref())
        .map(Buffer::from)
        .map_err(binding_error)
}

#[napi(js_name = "canonicalizePresentationSnapshot", strict)]
pub fn canonicalize_presentation_snapshot(snapshot: Buffer) -> Result<Buffer> {
    protocol::canonicalize_presentation_snapshot(snapshot.as_ref())
        .map(Buffer::from)
        .map_err(binding_error)
}

/// Stateful presentation kernel handle. All semantic work remains in the
/// shared safe-Rust protocol crate; Node receives owned byte envelopes only.
#[napi]
pub struct ArtifactPresentationSession {
    inner: protocol::PresentationBindingSession,
}

#[napi]
impl ArtifactPresentationSession {
    #[napi(factory, js_name = "create", strict)]
    pub fn create(namespace_envelope: Buffer) -> Result<Self> {
        protocol::PresentationBindingSession::create(namespace_envelope.as_ref())
            .map(|inner| Self { inner })
            .map_err(binding_error)
    }

    #[napi(factory, js_name = "open", strict)]
    pub fn open(snapshot: Buffer) -> Result<Self> {
        protocol::PresentationBindingSession::open(snapshot.as_ref())
            .map(|inner| Self { inner })
            .map_err(binding_error)
    }

    #[napi(js_name = "applyCommands", strict)]
    pub fn apply_commands(&mut self, command_envelope: Buffer) -> Result<Buffer> {
        self.inner
            .apply_commands(command_envelope.as_ref())
            .map(Buffer::from)
            .map_err(binding_error)
    }

    #[napi(js_name = "snapshot", strict)]
    pub fn snapshot(&self) -> Result<Buffer> {
        self.inner
            .snapshot()
            .map(Buffer::from)
            .map_err(binding_error)
    }

    #[napi(js_name = "revision", strict)]
    pub fn revision(&self) -> Result<u64> {
        self.inner.revision().map_err(binding_error)
    }

    #[napi(js_name = "query", strict)]
    pub fn query(&self, query_envelope: Buffer) -> Result<Buffer> {
        self.inner
            .query(query_envelope.as_ref())
            .map(Buffer::from)
            .map_err(binding_error)
    }

    #[napi(js_name = "stateHash", strict)]
    pub fn state_hash(&self) -> Result<String> {
        self.inner.state_hash().map_err(binding_error)
    }

    #[napi(js_name = "fork", strict)]
    pub fn fork(&self) -> Result<Self> {
        self.inner
            .fork()
            .map(|inner| Self { inner })
            .map_err(binding_error)
    }

    #[napi(js_name = "isClosed", strict)]
    pub fn is_closed(&self) -> bool {
        self.inner.is_closed()
    }

    #[napi(js_name = "close", strict)]
    pub fn close(&mut self) {
        self.inner.close();
    }

    #[napi(js_name = "dispose", strict)]
    pub fn dispose(&mut self) {
        self.inner.close();
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
                title: "Native parity".to_owned(),
                layout_id: None,
                background: Fill::Solid(Color::WHITE),
            },
        ]))
        .expect("presentation command")
    }

    #[test]
    fn presentation_native_surface_matches_protocol_exactly() {
        let namespace_value = 44;
        let namespace_bytes = protocol::encode_namespace(namespace_value);
        let command = seeded_command(namespace_value);
        let initial = create_presentation(Buffer::from(namespace_bytes.clone()))
            .expect("stateless presentation");
        assert_eq!(
            initial.as_ref(),
            protocol::create_presentation(&namespace_bytes)
                .expect("protocol create")
                .as_slice()
        );
        let updated = apply_presentation_commands(
            Buffer::from(initial.as_ref().to_vec()),
            Buffer::from(command.clone()),
        )
        .expect("stateless apply");
        let expected = protocol::apply_presentation_commands(initial.as_ref(), &command)
            .expect("protocol apply");
        assert_eq!(updated.as_ref(), expected.as_slice());

        let query =
            protocol::encode_presentation_metadata_query(protocol::PresentationMetadataQuery {
                max_bytes: 1_024,
            })
            .expect("query");
        let native_query = query_presentation(
            Buffer::from(updated.as_ref().to_vec()),
            Buffer::from(query.clone()),
        )
        .expect("native query");
        assert_eq!(
            native_query.as_ref(),
            protocol::query_presentation_snapshot(&expected, &query)
                .expect("protocol query")
                .as_slice()
        );
        assert!(matches!(
            protocol::decode_presentation_query_response(native_query.as_ref())
                .expect("decode metadata"),
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
                query_presentation(
                    Buffer::from(updated.as_ref().to_vec()),
                    Buffer::from(query.clone()),
                )
                .expect("native projection")
                .as_ref(),
                protocol::query_presentation_snapshot(&expected, &query)
                    .expect("protocol projection")
                    .as_slice()
            );
        }
        assert_eq!(
            canonicalize_presentation_snapshot(Buffer::from(updated.as_ref().to_vec()))
                .expect("canonical")
                .as_ref(),
            expected.as_slice()
        );

        let mut session =
            ArtifactPresentationSession::create(Buffer::from(namespace_bytes)).expect("session");
        session
            .apply_commands(Buffer::from(command))
            .expect("session apply");
        assert_eq!(
            session.snapshot().expect("session snapshot").as_ref(),
            expected.as_slice()
        );
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
