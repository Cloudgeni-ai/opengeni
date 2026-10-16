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
//! A third thing matters for sandboxes started from a template: every one
//! of them wakes with the template's memory, so none knows which sandbox it
//! is. (Their kernels reseed their random number generators by themselves:
//! the VMM changes the VM generation id on every restore.)
//!
//! So right after a restore, before anything else may use the sandbox, the
//! host connects to the guest's notice port and sends one line:
//!
//! ```text
//! restored <unix time in nanoseconds> sandbox=<sandbox id>
//! ```
//!
//! The guest sets its clock, drops connections it opened before the
//! restore, takes the sandbox id as its own, and answers `ok`. Later
//! `key=value` fields may follow; a guest ignores those it does not know.
//! The host retries until the guest answers or a deadline passes, so set a
//! notice port only for guest images that listen on it; a guest that never
//! answers costs every restore the whole deadline (and still runs).
//!
//! A guest booted from its disk instead finds the same id on its kernel
//! command line, as `opengeni.sandbox=<sandbox id>`.

use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::{fmt, io};

use compute_engine::vsock;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// The line a guest sends back once it has acted on the notice.
const ACK: &[u8; 3] = b"ok\n";

/// Formats the notice to sandbox `sandbox` for the current time.
fn notice(now: SystemTime, sandbox: impl fmt::Display) -> io::Result<String> {
    let nanos = now
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_nanos();
    Ok(format!("restored {nanos} sandbox={sandbox}\n"))
}

/// Longest a single attempt waits for the guest's answer at first; each
/// attempt after a timeout waits twice as long. A guest just restored can
/// take a few hundred milliseconds to answer (more in a burst of restores),
/// and giving up on an attempt it is already handling only gives it more
/// work.
const FIRST_ATTEMPT: Duration = Duration::from_secs(1);

/// Pause before trying again after the guest dropped the connection.
const RETRY_PAUSE: Duration = Duration::from_millis(5);

/// Tells the guest of sandbox `sandbox` through the VM's vsock socket and
/// waits for its answer, trying again until `deadline` has passed. Returns
/// how many attempts it took.
///
/// Retrying matters right after a restore: the guest kernel first handles
/// the VMM's vsock transport reset, and a connection that arrives in that
/// instant is dropped or never answered, although the listener is there.
/// The notice is idempotent, so a guest that acted on an attempt whose
/// answer came too late only sets the same clock and id again.
///
/// # Errors
///
/// The guest answered something else, or did not answer before `deadline`
/// (the last attempt's error).
pub async fn tell_restored(
    vsock_socket: &Path,
    port: u32,
    sandbox: impl fmt::Display,
    deadline: Duration,
) -> io::Result<u32> {
    let sandbox = sandbox.to_string();
    let give_up = Instant::now() + deadline;
    let mut wait = FIRST_ATTEMPT;
    let mut attempts = 0;
    loop {
        attempts += 1;
        let left = give_up.saturating_duration_since(Instant::now());
        let error = match tokio::time::timeout(
            wait.min(left),
            exchange(vsock_socket, port, &sandbox),
        )
        .await
        {
            Ok(Ok(())) => return Ok(attempts),
            Ok(Err(error)) if error.kind() == io::ErrorKind::InvalidData => return Err(error),
            Ok(Err(error)) => error,
            Err(_) => {
                wait = wait.saturating_mul(2);
                io::Error::new(
                    io::ErrorKind::TimedOut,
                    "the guest did not answer the restore notice",
                )
            }
        };
        tracing::debug!(attempts, %error, "restore notice attempt failed");
        if Instant::now() + RETRY_PAUSE >= give_up {
            return Err(error);
        }
        tokio::time::sleep(RETRY_PAUSE).await;
    }
}

/// One connection: the notice out, the guest's answer back.
async fn exchange(vsock_socket: &Path, port: u32, sandbox: &str) -> io::Result<()> {
    let mut stream = vsock::connect(vsock_socket, port).await?;
    stream
        .write_all(notice(SystemTime::now(), sandbox)?.as_bytes())
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::net::UnixListener;

    #[test]
    fn the_notice_carries_unix_nanoseconds() {
        let at = UNIX_EPOCH + Duration::new(1_700_000_000, 5);
        assert_eq!(
            notice(at, "00ab").unwrap(),
            "restored 1700000000000000005 sandbox=00ab\n"
        );
    }

    /// A stand-in for a VMM's vsock socket with one guest behind it, which
    /// answers its successive connections with `answers`; `None` drops the
    /// connection unanswered, as a guest does during its transport reset.
    fn guest(name: &str, answers: &'static [Option<&'static [u8]>]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("notice-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("vsock.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        tokio::spawn(async move {
            let mut held = Vec::new();
            for answer in answers {
                let (stream, _) = listener.accept().await.unwrap();
                let (read, mut write) = stream.into_split();
                let mut lines = BufReader::new(read).lines();
                assert_eq!(lines.next_line().await.unwrap().unwrap(), "CONNECT 53");
                write.write_all(b"OK 1073741824\n").await.unwrap();
                let line = lines.next_line().await.unwrap().unwrap();
                assert!(line.starts_with("restored "), "{line}");
                assert!(line.ends_with(" sandbox=7"), "{line}");
                if let Some(answer) = answer {
                    write.write_all(answer).await.unwrap();
                    // Hold the connection open so a missing answer times out.
                    held.push((lines, write));
                }
            }
            std::future::pending::<()>().await;
        });
        socket
    }

    #[tokio::test]
    async fn a_guest_that_answers_ok_is_told() {
        let socket = guest("ok", &[Some(b"ok\n")]);
        let attempts = tell_restored(&socket, 53, 7, Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(attempts, 1);
    }

    #[tokio::test]
    async fn a_guest_resetting_its_transport_is_told_on_a_later_attempt() {
        let socket = guest("reset", &[None, Some(b""), Some(b"ok\n")]);
        let attempts = tell_restored(&socket, 53, 7, Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(attempts, 3);
    }

    #[tokio::test]
    async fn a_wrong_answer_is_not_retried() {
        let socket = guest("wrong", &[Some(b"no\n"), Some(b"ok\n")]);
        let error = tell_restored(&socket, 53, 7, Duration::from_secs(5))
            .await
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[tokio::test]
    async fn a_silent_guest_times_out() {
        let socket = guest("silent", &[Some(b""), Some(b""), Some(b"")]);
        let error = tell_restored(&socket, 53, 7, Duration::from_millis(200))
            .await
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    }
}
