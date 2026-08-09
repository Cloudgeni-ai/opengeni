//! Node-API byte adapter for the structured-document kernel.

use napi::bindgen_prelude::Buffer;
use napi::{Error, Result, Status};
use napi_derive::napi;
use opengeni_artifact_kernel_binding_protocol as protocol;

fn binding_error(error: protocol::BindingError) -> Error {
    Error::new(Status::InvalidArg, format!("[{}] {error}", error.code()))
}

/// Creates an empty structured document from a canonical namespace envelope.
#[napi(js_name = "createDocument", strict)]
pub fn create_document(namespace_envelope: Buffer) -> Result<Buffer> {
    protocol::create_document(namespace_envelope.as_ref())
        .map(Buffer::from)
        .map_err(binding_error)
}

/// Atomically applies one OGADC001 command envelope to an OGADOC01 snapshot.
#[napi(js_name = "applyDocumentCommands", strict)]
pub fn apply_document_commands(snapshot: Buffer, command_envelope: Buffer) -> Result<Buffer> {
    protocol::apply_document_commands(snapshot.as_ref(), command_envelope.as_ref())
        .map(Buffer::from)
        .map_err(binding_error)
}

/// Executes one bounded OGADQ001 document projection query.
#[napi(js_name = "queryDocument", strict)]
pub fn query_document(snapshot: Buffer, query_envelope: Buffer) -> Result<Buffer> {
    protocol::query_document(snapshot.as_ref(), query_envelope.as_ref())
        .map(Buffer::from)
        .map_err(binding_error)
}

/// Strictly validates and re-encodes one canonical OGADOC01 snapshot.
#[napi(js_name = "canonicalizeDocumentSnapshot", strict)]
pub fn canonicalize_document_snapshot(snapshot: Buffer) -> Result<Buffer> {
    protocol::canonicalize_document_snapshot(snapshot.as_ref())
        .map(Buffer::from)
        .map_err(binding_error)
}

/// Stateful native structured-document kernel handle.
#[napi]
pub struct ArtifactDocumentSession {
    inner: protocol::DocumentBindingSession,
}

#[napi]
impl ArtifactDocumentSession {
    /// Creates an empty in-memory document from a canonical namespace envelope.
    #[napi(factory, js_name = "create", strict)]
    pub fn create(namespace_envelope: Buffer) -> Result<Self> {
        protocol::DocumentBindingSession::create(namespace_envelope.as_ref())
            .map(|inner| Self { inner })
            .map_err(binding_error)
    }

    /// Opens one validated canonical OGADOC01 snapshot.
    #[napi(factory, js_name = "open", strict)]
    pub fn open(snapshot: Buffer) -> Result<Self> {
        protocol::DocumentBindingSession::open(snapshot.as_ref())
            .map(|inner| Self { inner })
            .map_err(binding_error)
    }

    /// Applies one complete transaction and returns an OGADR001 receipt.
    #[napi(js_name = "applyCommands", strict)]
    pub fn apply_commands(&mut self, command_envelope: Buffer) -> Result<Buffer> {
        self.inner
            .apply_commands(command_envelope.as_ref())
            .map(Buffer::from)
            .map_err(binding_error)
    }

    /// Serializes the exact canonical document snapshot.
    #[napi(js_name = "snapshot", strict)]
    pub fn snapshot(&self) -> Result<Buffer> {
        self.inner
            .snapshot()
            .map(Buffer::from)
            .map_err(binding_error)
    }

    /// Returns the current document revision as a JavaScript bigint.
    #[napi(js_name = "revision", strict)]
    pub fn revision(&self) -> Result<u64> {
        self.inner.revision().map_err(binding_error)
    }

    /// Executes one bounded document projection query.
    #[napi(js_name = "query", strict)]
    pub fn query(&self, query_envelope: Buffer) -> Result<Buffer> {
        self.inner
            .query(query_envelope.as_ref())
            .map(Buffer::from)
            .map_err(binding_error)
    }

    /// Creates an independent in-memory branch.
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

    /// Releases the in-memory document state.
    #[napi(js_name = "close", strict)]
    pub fn close(&mut self) {
        self.inner.close();
    }

    /// Idempotent explicit-resource-management alias for close.
    #[napi(js_name = "dispose", strict)]
    pub fn dispose(&mut self) {
        self.inner.close();
    }

    /// Reports whether document state has been released.
    #[napi(js_name = "isClosed", strict)]
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
                runs: vec![TextRun::plain("native parity")],
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
    fn document_stateless_and_session_bytes_match_protocol_exactly() {
        let namespace_value = 0x444f43;
        let namespace = protocol::encode_namespace(namespace_value);
        let command = seeded_command(namespace_value);
        let initial = create_document(Buffer::from(namespace.clone())).expect("create");
        assert_eq!(
            initial.as_ref(),
            protocol::create_document(&namespace).expect("protocol create")
        );

        let updated = apply_document_commands(
            Buffer::from(initial.as_ref().to_vec()),
            Buffer::from(command.clone()),
        )
        .expect("apply");
        let expected =
            protocol::apply_document_commands(initial.as_ref(), &command).expect("protocol apply");
        assert_eq!(updated.as_ref(), expected);

        let query = protocol::encode_document_query(DocumentQuery::Body {
            start_block: 0,
            limits: DocumentQueryLimits::default(),
        })
        .expect("query");
        assert_eq!(
            query_document(
                Buffer::from(updated.as_ref().to_vec()),
                Buffer::from(query.clone()),
            )
            .expect("binding query")
            .as_ref(),
            protocol::query_document(updated.as_ref(), &query).expect("protocol query")
        );
        let summary_query =
            protocol::encode_document_query(DocumentQuery::Summary).expect("summary query");
        let summary = query_document(
            Buffer::from(updated.as_ref().to_vec()),
            Buffer::from(summary_query),
        )
        .expect("binding summary");
        assert!(matches!(
            protocol::decode_document_query_response(summary.as_ref())
                .expect("decode binding summary")
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

        let mut session =
            ArtifactDocumentSession::create(Buffer::from(namespace)).expect("session");
        let receipt = session
            .apply_commands(Buffer::from(command))
            .expect("session apply");
        assert_eq!(
            protocol::decode_document_receipt(receipt.as_ref())
                .expect("receipt")
                .revision,
            1
        );
        assert_eq!(
            session.snapshot().expect("snapshot").as_ref(),
            updated.as_ref()
        );
        let branch = session.fork().expect("fork");
        assert_eq!(
            branch.state_hash().expect("branch hash"),
            session.state_hash().expect("hash")
        );
        session.close();
        session.dispose();
        assert!(session.is_closed());
        assert!(session.snapshot().is_err());
    }
}
