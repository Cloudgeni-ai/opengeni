//! Deterministic presentation scene model shared by native workers and Wasm.
//!
//! Commands in this module are pure modality commands. Artifact/actor identity,
//! transaction identity, and causality belong exclusively to the outer OGATX
//! collaboration envelope.

mod model;
mod snapshot;
mod spatial;
mod text_layout_adapter;
mod types;

pub use model::{
    Presentation, PresentationBatchTransaction, ResolvedSceneNode, ResolvedSlideScene, SlideSize,
};
pub use snapshot::{
    decode_presentation_snapshot, encode_presentation_snapshot, presentation_state_hash,
    MAX_PRESENTATION_SNAPSHOT_BYTES, PRESENTATION_SNAPSHOT_VERSION,
};
pub use spatial::{ProjectedSceneNode, ViewportProjection};
pub use text_layout_adapter::{
    PresentationParagraphPlacement, PresentationTextFrameLayout, PresentationTextFrameLimits,
    PresentationTextLayoutError,
};
pub use types::*;

#[cfg(test)]
mod tests;
