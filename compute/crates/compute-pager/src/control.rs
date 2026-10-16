//! What a pager process and the host agent that fills its image tell each
//! other, one JSON object per line over the pager's control socket.
//!
//! The pager owns everything about the VM's memory (the userfaultfd, which
//! pages are in place and which the guest discarded); the host only fetches
//! image bytes into the memory file and says which ranges it has filled. So
//! the host can go away at any moment and a new one reconnects: the pager
//! greets every connection with what it still misses, and faults on missing
//! bytes simply wait meanwhile.

use serde::{Deserialize, Serialize};

/// From the pager to the host.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToHost {
    /// Sent first on every connection.
    Hello {
        /// The image the pager serves, as the host named it at launch.
        tag: String,
        /// Device and inode of the memory file the pager reads, so a host
        /// filling it by name can prove it fills the same file.
        device: u64,
        inode: u64,
        /// Byte ranges of the image the pager may not read yet.
        missing: Vec<(u64, u64)>,
        /// Whether the wake's prefetch is already in place.
        prefetched: bool,
    },
    /// Please fill these bytes; `urgent` when a guest processor waits.
    Want { offset: u64, len: u64, urgent: bool },
    /// The pages the wake waits for are in place.
    Prefetched,
    /// Every page is in place and the guest's memory no longer has a
    /// fault handler: the pager is exiting and the VM needs it no more.
    Done,
}

/// From the host to the pager.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToPager {
    /// These byte ranges of the memory file now hold the image's bytes and
    /// will never change again.
    Filled { ranges: Vec<(u64, u64)> },
}

/// Parses one line, ignoring surrounding whitespace.
///
/// # Errors
///
/// The line is not a message of type `T`.
pub fn parse<'a, T: Deserialize<'a>>(line: &'a [u8]) -> serde_json::Result<T> {
    serde_json::from_slice(line.trim_ascii())
}

/// One message as a line.
///
/// # Errors
///
/// Never for these message types; kept for the encoder's signature.
pub fn line<T: Serialize>(message: &T) -> serde_json::Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec(message)?;
    bytes.push(b'\n');
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_are_single_lines_that_round_trip() {
        let hello = ToHost::Hello {
            tag: "7".into(),
            device: 1,
            inode: 2,
            missing: vec![(0, 4096)],
            prefetched: false,
        };
        let bytes = line(&hello).unwrap();
        assert_eq!(
            bytes.iter().position(|byte| *byte == b'\n'),
            Some(bytes.len() - 1)
        );
        assert_eq!(parse::<ToHost>(&bytes).unwrap(), hello);
        let filled = ToPager::Filled {
            ranges: vec![(4096, 8192)],
        };
        assert_eq!(parse::<ToPager>(&line(&filled).unwrap()).unwrap(), filled);
        assert!(parse::<ToPager>(b"{\"filled\":3}").is_err());
    }
}
