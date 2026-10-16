//! Compositor screen-cast frames from the session PipeWire daemon.
//!
//! Wayland compositors do not let clients read the screen directly. GNOME's
//! Mutter publishes a screen-cast stream as a PipeWire node instead; this crate
//! connects one video consumer to such a node and hands back the latest frame
//! as tightly packed RGBA.
//!
//! `libpipewire-0.3.so.0` is opened at runtime with `dlopen`, so hosts without
//! PipeWire (X11 desktops, containers) and statically linked builds keep
//! working: [`ScreenCastStream::connect`] then fails with
//! [`PipeWireError::Unavailable`].
//!
//! The stream holds the newest buffer instead of copying every frame, so an
//! animated screen costs nothing here until a caller actually asks for a frame.

#[cfg(target_os = "linux")]
#[allow(unsafe_code)]
mod ffi;
mod pod;

use std::time::Duration;

/// A failure to receive screen-cast frames.
#[derive(Debug, thiserror::Error)]
pub enum PipeWireError {
    /// The PipeWire client library or daemon cannot be used on this host.
    #[error("PipeWire is unavailable: {0}")]
    Unavailable(String),
    /// The stream failed or produced an unusable frame.
    #[error("PipeWire screen cast failed: {0}")]
    Failed(String),
    /// No frame arrived within the allowed time.
    #[error("PipeWire screen cast produced no frame within {0:?}")]
    Timeout(Duration),
}

/// One captured frame, tightly packed RGBA8.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoFrame {
    /// RGBA8 pixels, `width * height * 4` bytes.
    pub rgba: Vec<u8>,
    /// Frame width in pixels.
    pub width: u32,
    /// Frame height in pixels.
    pub height: u32,
    /// Monotonic per-stream sequence of the delivered compositor frame.
    pub sequence: u64,
}

/// How long [`ScreenCastStream::frame`] waits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameWait {
    /// Longest wait for a frame at least as new as the requested sequence.
    pub first: Duration,
    /// Once one arrived, keep taking newer frames until none arrives for this
    /// long, so an animation started by input is shown finished. Zero returns
    /// the first qualifying frame.
    pub quiet: Duration,
    /// Upper bound on the whole wait while following newer frames.
    pub settle: Duration,
}

impl FrameWait {
    /// Return the first frame at least as new as requested, waiting up to `first`.
    #[must_use]
    pub fn first(first: Duration) -> Self {
        Self {
            first,
            quiet: Duration::ZERO,
            settle: first,
        }
    }
}

/// One connected video consumer of a compositor screen-cast node.
pub struct ScreenCastStream {
    #[cfg(target_os = "linux")]
    inner: ffi::Stream,
}

impl std::fmt::Debug for ScreenCastStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScreenCastStream").finish_non_exhaustive()
    }
}

impl ScreenCastStream {
    /// Connects to PipeWire node `node_id` on the session daemon, asking the
    /// producer for at most `max_fps` frames per second.
    ///
    /// # Errors
    ///
    /// [`PipeWireError::Unavailable`] when libpipewire cannot be loaded or the
    /// daemon is unreachable; [`PipeWireError::Failed`] when the stream cannot
    /// be created.
    pub fn connect(node_id: u32, max_fps: u32) -> Result<Self, PipeWireError> {
        #[cfg(target_os = "linux")]
        {
            Ok(Self {
                inner: ffi::Stream::connect(node_id, max_fps.max(1))?,
            })
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (node_id, max_fps);
            Err(PipeWireError::Unavailable(
                "PipeWire screen cast is only available on Linux".to_string(),
            ))
        }
    }

    /// Sequence of the newest frame received so far (0 before the first one).
    #[must_use]
    pub fn latest_sequence(&self) -> u64 {
        #[cfg(target_os = "linux")]
        {
            self.inner.latest_sequence()
        }
        #[cfg(not(target_os = "linux"))]
        {
            0
        }
    }

    /// Returns the newest frame once its sequence is at least `min_sequence`,
    /// following any further frames as described by [`FrameWait`]. When no
    /// such frame arrives in time but an older one exists, that frame is
    /// returned: compositors only send frames when the screen changes, so no
    /// newer frame means nothing visible changed.
    ///
    /// # Errors
    ///
    /// [`PipeWireError::Timeout`] when no frame at all arrived in time, or
    /// [`PipeWireError::Failed`] when the stream errored or the frame is unusable.
    pub fn frame(&self, min_sequence: u64, wait: FrameWait) -> Result<VideoFrame, PipeWireError> {
        #[cfg(target_os = "linux")]
        {
            self.inner.frame(min_sequence, wait)
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (min_sequence, wait);
            Err(PipeWireError::Unavailable(
                "PipeWire screen cast is only available on Linux".to_string(),
            ))
        }
    }

    /// The terminal stream error, if the producer or daemon ended the stream.
    #[must_use]
    pub fn failure(&self) -> Option<String> {
        #[cfg(target_os = "linux")]
        {
            self.inner.failure()
        }
        #[cfg(not(target_os = "linux"))]
        {
            None
        }
    }
}

/// Converts one 32-bit RGB frame whose rows are `stride` bytes apart (0 means
/// tightly packed) into tightly packed, opaque RGBA.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn to_rgba(
    bytes: &[u8],
    stride: usize,
    format: pod::VideoFormat,
) -> Result<Vec<u8>, PipeWireError> {
    let width = usize::try_from(format.width).unwrap_or(usize::MAX);
    let height = usize::try_from(format.height).unwrap_or(usize::MAX);
    let row = width
        .checked_mul(4)
        .ok_or_else(|| PipeWireError::Failed("frame width overflows".to_string()))?;
    let stride = if stride == 0 { row } else { stride };
    let needed = stride
        .checked_mul(height.saturating_sub(1))
        .and_then(|value| value.checked_add(row));
    if stride < row || needed.is_none_or(|needed| needed > bytes.len()) {
        return Err(PipeWireError::Failed(format!(
            "screen-cast buffer ({} bytes, stride {stride}) is smaller than its {}x{} format",
            bytes.len(),
            format.width,
            format.height
        )));
    }
    let (red, green, blue) = format.layout.rgb_offsets();
    let mut rgba = Vec::with_capacity(row * height);
    for line in bytes.chunks(stride).take(height) {
        for pixel in line[..row].chunks_exact(4) {
            rgba.extend_from_slice(&[pixel[red], pixel[green], pixel[blue], 0xff]);
        }
    }
    Ok(rgba)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pod::{PixelLayout, VideoFormat};

    #[test]
    fn converts_padded_bgrx_rows_to_opaque_rgba() {
        let format = VideoFormat {
            layout: PixelLayout::Bgrx,
            width: 2,
            height: 2,
        };
        // stride 12: two pixels plus four padding bytes per row
        let bytes = [
            1, 2, 3, 0, 4, 5, 6, 0, 9, 9, 9, 9, //
            7, 8, 9, 0, 10, 11, 12, 0,
        ];
        assert_eq!(
            to_rgba(&bytes, 12, format).unwrap(),
            vec![3, 2, 1, 255, 6, 5, 4, 255, 9, 8, 7, 255, 12, 11, 10, 255]
        );
    }

    #[test]
    fn rejects_buffers_shorter_than_the_format() {
        let format = VideoFormat {
            layout: PixelLayout::Rgba,
            width: 4,
            height: 4,
        };
        assert!(to_rgba(&[0; 60], 0, format).is_err());
        assert!(to_rgba(&[0; 64], 8, format).is_err());
    }
}
