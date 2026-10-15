//! Telling a guest that it was restored from a memory image.
//!
//! A restored guest carries on exactly where its image was taken, and two
//! things inside it are then wrong without it noticing:
//!
//! - Its wall clock still shows the moment the image was saved. The clock
//!   only advances while the VM runs, so after an hour asleep it is an hour
//!   behind. (A paused VM whose process stayed alive keeps correct time.)
//! - Every connection it opened to the host still looks open to it, although
//!   the VM process that carried them is gone. Nothing resets them, so a
//!   client only finds out the next time it writes, which for an idle
//!   control link can be a minute of the guest's own running time.
//!
//! So right after a restore, before anything else may use the sandbox, the
//! host connects to the guest's notice port and sends one line:
//!
//! ```text
//! restored <unix time in nanoseconds>
//! ```
//!
//! The guest sets its clock, drops connections it opened before the
//! restore, and answers `ok`. A guest with nothing listening on the port is
//! fine: the connection is refused at once and the host carries on.

use std::io;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use compute_engine::vsock;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// The line a guest sends back once it has acted on the notice.
const ACK: &[u8; 3] = b"ok\n";

/// Formats the notice for the current time.
fn notice(now: SystemTime) -> io::Result<String> {
    let nanos = now
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_nanos();
    Ok(format!("restored {nanos}\n"))
}

/// Sends the notice through the VM's vsock socket and waits for the guest's
/// answer, for at most `timeout` in total.
///
/// # Errors
///
/// The guest does not listen on `port`, answered something else, or did not
/// answer in time.
pub async fn tell_restored(vsock_socket: &Path, port: u32, timeout: Duration) -> io::Result<()> {
    let exchange = async {
        let mut stream = vsock::connect(vsock_socket, port).await?;
        stream
            .write_all(notice(SystemTime::now())?.as_bytes())
            .await?;
        let mut answer = [0_u8; ACK.len()];
        stream.read_exact(&mut answer).await?;
        if &answer == ACK {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "unexpected answer to the restore notice",
            ))
        }
    };
    tokio::time::timeout(timeout, exchange)
        .await
        .unwrap_or_else(|_| {
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "the guest did not answer the restore notice",
            ))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::net::UnixListener;

    #[test]
    fn the_notice_carries_unix_nanoseconds() {
        let at = UNIX_EPOCH + Duration::new(1_700_000_000, 5);
        assert_eq!(notice(at).unwrap(), "restored 1700000000000000005\n");
    }

    /// A stand-in for a VMM's vsock socket with one guest behind it.
    fn guest(name: &str, answer: &'static [u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("notice-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("vsock.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (read, mut write) = stream.into_split();
            let mut lines = BufReader::new(read).lines();
            assert_eq!(lines.next_line().await.unwrap().unwrap(), "CONNECT 53");
            write.write_all(b"OK 1073741824\n").await.unwrap();
            let line = lines.next_line().await.unwrap().unwrap();
            assert!(line.starts_with("restored "), "{line}");
            write.write_all(answer).await.unwrap();
            // Hold the connection open so a missing answer times out.
            let _ = lines.next_line().await;
        });
        socket
    }

    #[tokio::test]
    async fn a_guest_that_answers_ok_is_told() {
        let socket = guest("ok", b"ok\n");
        tell_restored(&socket, 53, Duration::from_secs(5))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_silent_guest_times_out() {
        let socket = guest("silent", b"");
        let error = tell_restored(&socket, 53, Duration::from_millis(50))
            .await
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    }
}
