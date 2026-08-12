use std::sync::{Arc, Mutex};

use arboard::{Clipboard, Error as ClipboardError};

use crate::{
    NativeAdapterError, NativeAdapterErrorCode, NativeAdapterResult, NativeClipboard,
    NativeClipboardAction,
};

const MAX_CLIPBOARD_BYTES: usize = 1024 * 1024;

/// Long-lived text clipboard handle for one native helper/graphical seat.
///
/// Retaining the handle is correctness-critical on X11: selection contents are
/// served by the owning process and can disappear when its last handle exits.
/// The mutex also serializes macOS/Windows-style system clipboard access.
#[derive(Clone)]
pub(crate) struct NativeClipboardController {
    inner: Arc<Mutex<Clipboard>>,
}

impl NativeClipboardController {
    pub(crate) fn open() -> NativeAdapterResult<Self> {
        let clipboard = Clipboard::new().map_err(map_read_error)?;
        Ok(Self {
            inner: Arc::new(Mutex::new(clipboard)),
        })
    }

    pub(crate) async fn read(&self) -> NativeAdapterResult<NativeClipboard> {
        let inner = Arc::clone(&self.inner);
        tokio::task::spawn_blocking(move || {
            let mut clipboard = inner.lock().map_err(|_| poisoned())?;
            match clipboard.get_text() {
                Ok(text) => {
                    let (text, truncated) = bounded_text(text);
                    Ok(NativeClipboard {
                        text: Some(text),
                        truncated,
                    })
                }
                Err(ClipboardError::ContentNotAvailable) => Ok(NativeClipboard {
                    text: None,
                    truncated: false,
                }),
                Err(error) => Err(map_read_error(error)),
            }
        })
        .await
        .map_err(|error| {
            NativeAdapterError::definite(
                NativeAdapterErrorCode::DriverFailed,
                format!("native clipboard task failed: {error}"),
                true,
            )
        })?
    }

    pub(crate) async fn mutate(
        &self,
        operation: NativeClipboardAction,
        text: Option<String>,
    ) -> NativeAdapterResult<()> {
        match operation {
            NativeClipboardAction::Write => {
                self.write(text.ok_or_else(|| {
                    NativeAdapterError::definite(
                        NativeAdapterErrorCode::InvalidAction,
                        "native clipboard write requires text",
                        false,
                    )
                })?)
                .await
            }
            NativeClipboardAction::Clear => self.clear().await,
            NativeClipboardAction::Copy | NativeClipboardAction::Paste => {
                Err(NativeAdapterError::unsupported(
                    "copy and paste are input operations, not clipboard storage mutations",
                ))
            }
        }
    }

    async fn write(&self, text: String) -> NativeAdapterResult<()> {
        if text.len() > MAX_CLIPBOARD_BYTES {
            return Err(NativeAdapterError::definite(
                NativeAdapterErrorCode::InvalidAction,
                "native clipboard text exceeds its UTF-8 byte envelope",
                false,
            ));
        }
        let inner = Arc::clone(&self.inner);
        tokio::task::spawn_blocking(move || {
            inner
                .lock()
                .map_err(|_| poisoned())?
                .set_text(text)
                .map_err(map_mutation_error)
        })
        .await
        .map_err(|error| {
            NativeAdapterError::outcome_unknown(format!(
                "native clipboard write task failed after dispatch: {error}"
            ))
        })?
    }

    async fn clear(&self) -> NativeAdapterResult<()> {
        let inner = Arc::clone(&self.inner);
        tokio::task::spawn_blocking(move || {
            inner
                .lock()
                .map_err(|_| poisoned())?
                .clear()
                .map_err(map_mutation_error)
        })
        .await
        .map_err(|error| {
            NativeAdapterError::outcome_unknown(format!(
                "native clipboard clear task failed after dispatch: {error}"
            ))
        })?
    }
}

fn bounded_text(mut text: String) -> (String, bool) {
    if text.len() <= MAX_CLIPBOARD_BYTES {
        return (text, false);
    }
    let mut boundary = MAX_CLIPBOARD_BYTES;
    while !text.is_char_boundary(boundary) {
        boundary -= 1;
    }
    text.truncate(boundary);
    (text, true)
}

fn map_read_error(error: ClipboardError) -> NativeAdapterError {
    match error {
        ClipboardError::ClipboardNotSupported => NativeAdapterError::unsupported(
            "native text clipboard is unsupported by this graphical seat",
        ),
        ClipboardError::ClipboardOccupied => NativeAdapterError::unavailable(
            "native clipboard is temporarily occupied by another application",
            true,
        ),
        ClipboardError::ContentNotAvailable => NativeAdapterError::definite(
            NativeAdapterErrorCode::DriverFailed,
            "native clipboard content became unavailable while reading",
            true,
        ),
        ClipboardError::ConversionFailure => NativeAdapterError::definite(
            NativeAdapterErrorCode::DriverFailed,
            "native clipboard text conversion failed",
            false,
        ),
        ClipboardError::Unknown { description } => NativeAdapterError::definite(
            NativeAdapterErrorCode::DriverFailed,
            format!("native clipboard failed: {description}"),
            true,
        ),
        _ => NativeAdapterError::definite(
            NativeAdapterErrorCode::DriverFailed,
            format!("native clipboard failed: {error}"),
            true,
        ),
    }
}

fn map_mutation_error(error: ClipboardError) -> NativeAdapterError {
    match error {
        ClipboardError::ClipboardNotSupported => NativeAdapterError::unsupported(
            "native text clipboard is unsupported by this graphical seat",
        ),
        ClipboardError::ClipboardOccupied => NativeAdapterError::unavailable(
            "native clipboard is temporarily occupied by another application",
            true,
        ),
        ClipboardError::ConversionFailure | ClipboardError::ContentNotAvailable => {
            NativeAdapterError::definite(
                NativeAdapterErrorCode::DriverFailed,
                "native clipboard rejected the text mutation",
                false,
            )
        }
        ClipboardError::Unknown { description } => NativeAdapterError::outcome_unknown(format!(
            "native clipboard mutation failed: {description}"
        )),
        _ => NativeAdapterError::outcome_unknown(format!(
            "native clipboard mutation failed: {error}"
        )),
    }
}

fn poisoned() -> NativeAdapterError {
    NativeAdapterError::definite(
        NativeAdapterErrorCode::DriverFailed,
        "native clipboard lock was poisoned",
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipboard_text_is_truncated_on_a_utf8_boundary() {
        let mut input = "a".repeat(MAX_CLIPBOARD_BYTES - 1);
        input.push('é');
        let (output, truncated) = bounded_text(input);
        assert!(truncated);
        assert_eq!(output.len(), MAX_CLIPBOARD_BYTES - 1);
        assert!(output.is_char_boundary(output.len()));
    }
}
