use opengeni_artifact_kernel_binding_protocol as protocol;
use wasm_bindgen::{prelude::wasm_bindgen, JsError};

use crate::to_js_error;

/// Shapes one paragraph using an explicit canonical font bundle.
#[wasm_bindgen(js_name = layoutText)]
pub fn layout_text(font_bundle: &[u8], request: &[u8]) -> Result<Vec<u8>, JsError> {
    layout_text_bytes(font_bundle, request).map_err(to_js_error)
}

/// Validates and canonicalizes one retained render tile.
#[wasm_bindgen(js_name = canonicalizeRenderTile)]
pub fn canonicalize_render_tile(bytes: &[u8]) -> Result<Vec<u8>, JsError> {
    protocol::canonicalize_render_tile(bytes).map_err(to_js_error)
}

/// Validates and canonicalizes one retained render patch.
#[wasm_bindgen(js_name = canonicalizeRenderPatch)]
pub fn canonicalize_render_patch(bytes: &[u8]) -> Result<Vec<u8>, JsError> {
    protocol::canonicalize_render_patch(bytes).map_err(to_js_error)
}

pub(crate) fn layout_text_bytes(
    font_bundle: &[u8],
    request: &[u8],
) -> Result<Vec<u8>, protocol::BindingError> {
    let mut session = protocol::TextLayoutBindingSession::open_with_limits(
        font_bundle,
        protocol::WASM_TEXT_LAYOUT_LIMITS,
    )?;
    session.layout(request)
}

/// Stateful Wasm text-layout worker with explicit fonts and a warm bounded
/// shaping/layout cache.
#[wasm_bindgen]
pub struct ArtifactTextLayoutSession {
    inner: protocol::TextLayoutBindingSession,
}

#[wasm_bindgen]
impl ArtifactTextLayoutSession {
    /// Opens a bounded layout session from explicit content-addressed fonts.
    #[wasm_bindgen(js_name = open)]
    pub fn open(font_bundle: &[u8]) -> Result<ArtifactTextLayoutSession, JsError> {
        protocol::TextLayoutBindingSession::open_with_limits(
            font_bundle,
            protocol::WASM_TEXT_LAYOUT_LIMITS,
        )
        .map(|inner| Self { inner })
        .map_err(to_js_error)
    }

    /// Shapes one canonical paragraph request.
    pub fn layout(&mut self, request: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner.layout(request).map_err(to_js_error)
    }

    /// Reports whether the session's font registry and caches were released.
    #[wasm_bindgen(js_name = isClosed)]
    pub fn is_closed(&self) -> bool {
        self.inner.is_closed()
    }

    /// Releases the font registry and all layout caches.
    pub fn close(&mut self) {
        self.inner.close();
    }

    /// Idempotent explicit-resource-management alias for `close`.
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
    fn wasm_text_layout_wrapper_matches_native_golden() {
        let fonts = unhex(include_str!("../../fixtures/text-layout-font.hex"));
        let request = unhex(include_str!("../../fixtures/text-layout-request.hex"));
        let expected_hash = include_str!("../../fixtures/text-layout-response.sha256").trim();
        let wasm = layout_text_bytes(&fonts, &request).expect("wasm-profile layout");
        let native = protocol::layout_text(&fonts, &request).expect("native-profile layout");
        assert_eq!(wasm, native);
        assert_eq!(format!("{:x}", Sha256::digest(&wasm)), expected_hash);

        let mut session = ArtifactTextLayoutSession::open(&fonts).expect("session");
        assert_eq!(session.layout(&request).expect("session layout"), wasm);
        session.close();
        session.dispose();
        assert!(session.is_closed());
    }

    #[test]
    fn wasm_retained_render_wrappers_preserve_canonical_vectors() {
        let (tile, patch) = render_vectors();
        let tile = encode_render_tile(&tile, RetainedRenderLimits::default()).expect("tile");
        let patch = encode_render_patch(&patch, RetainedRenderLimits::default()).expect("patch");
        assert_eq!(
            canonicalize_render_tile(&tile).expect("canonical tile"),
            tile
        );
        assert_eq!(
            canonicalize_render_patch(&patch).expect("canonical patch"),
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
