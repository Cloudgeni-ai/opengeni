use napi::bindgen_prelude::Buffer;
use napi::Result;
use napi_derive::napi;
use opengeni_artifact_kernel_binding_protocol as protocol;

use crate::binding_error;

#[napi(js_name = "layoutText", strict)]
pub fn layout_text(font_bundle: Buffer, request: Buffer) -> Result<Buffer> {
    protocol::layout_text(font_bundle.as_ref(), request.as_ref())
        .map(Buffer::from)
        .map_err(binding_error)
}

#[napi(js_name = "canonicalizeRenderTile", strict)]
pub fn canonicalize_render_tile(bytes: Buffer) -> Result<Buffer> {
    protocol::canonicalize_render_tile(bytes.as_ref())
        .map(Buffer::from)
        .map_err(binding_error)
}

#[napi(js_name = "canonicalizeRenderPatch", strict)]
pub fn canonicalize_render_patch(bytes: Buffer) -> Result<Buffer> {
    protocol::canonicalize_render_patch(bytes.as_ref())
        .map(Buffer::from)
        .map_err(binding_error)
}

/// Stateful text-layout worker. Explicit font assets are parsed once and the
/// bounded shaping/layout cache remains warm across requests.
#[napi]
pub struct ArtifactTextLayoutSession {
    inner: protocol::TextLayoutBindingSession,
}

#[napi]
impl ArtifactTextLayoutSession {
    #[napi(factory, js_name = "open", strict)]
    pub fn open(font_bundle: Buffer) -> Result<Self> {
        protocol::TextLayoutBindingSession::open(font_bundle.as_ref())
            .map(|inner| Self { inner })
            .map_err(binding_error)
    }

    #[napi(strict)]
    pub fn layout(&mut self, request: Buffer) -> Result<Buffer> {
        self.inner
            .layout(request.as_ref())
            .map(Buffer::from)
            .map_err(binding_error)
    }

    #[napi(js_name = "isClosed", strict)]
    pub fn is_closed(&self) -> bool {
        self.inner.is_closed()
    }

    #[napi(strict)]
    pub fn close(&mut self) {
        self.inner.close();
    }

    #[napi(strict)]
    pub fn dispose(&mut self) {
        self.inner.close();
    }
}

#[cfg(test)]
mod tests {
    use opengeni_artifact_kernel::text_layout::{
        encode_render_patch, encode_render_tile, LayoutUnit, RenderCommand, RenderCommandId,
        RenderPatch, RenderRect, RenderTile, RenderTileKey, RetainedRenderLimits,
    };
    use sha2::{Digest, Sha256};

    use super::*;

    #[test]
    fn napi_text_layout_wrapper_matches_protocol_golden() {
        let fonts = unhex(include_str!("../../fixtures/text-layout-font.hex"));
        let request = unhex(include_str!("../../fixtures/text-layout-request.hex"));
        let expected_hash = include_str!("../../fixtures/text-layout-response.sha256").trim();
        let direct = layout_text(Buffer::from(fonts.clone()), Buffer::from(request.clone()))
            .expect("direct layout");
        let expected = protocol::layout_text(&fonts, &request).expect("protocol layout");
        assert_eq!(direct.as_ref(), expected);
        assert_eq!(
            format!("{:x}", Sha256::digest(direct.as_ref())),
            expected_hash
        );

        let mut session = ArtifactTextLayoutSession::open(Buffer::from(fonts)).expect("session");
        assert_eq!(
            session
                .layout(Buffer::from(request))
                .expect("session")
                .as_ref(),
            expected
        );
        session.close();
        session.dispose();
        assert!(session.is_closed());
    }

    #[test]
    fn napi_retained_render_wrappers_preserve_canonical_vectors() {
        let (tile, patch) = render_vectors();
        let tile = encode_render_tile(&tile, RetainedRenderLimits::default()).expect("tile");
        let patch = encode_render_patch(&patch, RetainedRenderLimits::default()).expect("patch");
        assert_eq!(
            canonicalize_render_tile(Buffer::from(tile.clone()))
                .expect("canonical tile")
                .as_ref(),
            tile
        );
        assert_eq!(
            canonicalize_render_patch(Buffer::from(patch.clone()))
                .expect("canonical patch")
                .as_ref(),
            patch
        );
    }

    fn render_vectors() -> (RenderTile, RenderPatch) {
        let command = RenderCommand::FillRect {
            id: RenderCommandId::new(7).expect("id"),
            bounds: RenderRect::new(
                LayoutUnit::ZERO,
                LayoutUnit::ZERO,
                LayoutUnit::from_raw(64),
                LayoutUnit::from_raw(64),
            )
            .expect("bounds"),
            rgba: 0x1234_56ff,
        };
        (
            RenderTile {
                revision: 2,
                key: RenderTileKey { x: 0, y: 0 },
                tile_edge: LayoutUnit::from_raw(32_768),
                commands: vec![command.clone()],
            },
            RenderPatch {
                base_revision: 1,
                revision: 2,
                removed: Vec::new(),
                upserted: vec![command],
                invalidated_tiles: vec![RenderTileKey { x: 0, y: 0 }],
            },
        )
    }

    fn unhex(input: &str) -> Vec<u8> {
        let input = input.trim().as_bytes();
        assert_eq!(input.len() % 2, 0);
        input
            .chunks_exact(2)
            .map(|pair| {
                let high = (pair[0] as char).to_digit(16).expect("hex") as u8;
                let low = (pair[1] as char).to_digit(16).expect("hex") as u8;
                (high << 4) | low
            })
            .collect()
    }
}
