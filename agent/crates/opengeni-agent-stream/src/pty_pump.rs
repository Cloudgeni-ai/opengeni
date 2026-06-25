//! The PTY pump: bridges a [`PtyProcess`] and a [`RelayChannel`] both directions.
//!
//! * **Output** (tty → relay): a blocking task reads the PTY master and forwards
//!   chunks over a bounded channel to the relay-send loop, which ships each as a
//!   [`StreamFrame`](opengeni_agent_proto::v1::StreamFrame). The bounded channel is
//!   the backpressure point — a slow viewer cannot make the agent buffer
//!   unboundedly (dossier §10.5).
//! * **Input** (relay → tty): inbound [`StreamFrame`]s are raw keystrokes written
//!   to the PTY writer. A [`DesktopInput`] on a PTY channel is ignored (it belongs
//!   to a desktop channel).
//!
//! On a relay transport drop the pump's send loop returns; the owner re-registers
//! the channel (resume-from-seq) and resumes — the PTY process keeps running, so a
//! relay blip never kills the terminal (§10.6).
//!
//! portable-pty's master IO is blocking `std::io`, so the read/write touch the
//! blocking pool; the agent's async runtime is never stalled on tty IO.

use std::io::{Read as _, Write as _};

use opengeni_agent_platform::{PlatformResult, PtyProcess};
use tokio::sync::mpsc;

use crate::channel::RelayChannel;
use crate::codec::RelayMessage;
use crate::error::StreamResult;

/// The bound on in-flight PTY output chunks (the backpressure point). A slow relay
/// blocks the blocking reader once this fills, so the agent never buffers tty
/// output unboundedly.
const OUTPUT_CHANNEL_BOUND: usize = 256;
/// The PTY read chunk size.
const READ_CHUNK: usize = 8 * 1024;

/// A control command sent to a live PTY pump out-of-band of the relay stream — the
/// programmatic `pty_write`/`pty_resize`/`pty_close` control ops (which arrive over
/// NATS, not the relay byte stream). The pump applies it against the owned
/// [`PtyProcess`].
#[derive(Debug)]
pub enum PtyCommand {
    /// Write input bytes to the PTY (programmatic injection).
    Write(Vec<u8>),
    /// Resize the PTY window (the viewer reflowed its terminal).
    Resize {
        /// New column count.
        cols: u16,
        /// New row count.
        rows: u16,
    },
    /// Kill the PTY child, replying its exit code (if known) on the oneshot.
    Close(tokio::sync::oneshot::Sender<i32>),
}

/// The sender half of a PTY's control channel, held by the hub registry so the
/// `pty_write`/`pty_resize`/`pty_close` ops reach the running pump.
pub type PtyControlTx = mpsc::Sender<PtyCommand>;

/// Runs the PTY pump until the PTY process exits or the relay transport drops.
///
/// Pumps tty output → relay frames, relay input frames → tty, and applies the
/// out-of-band [`PtyCommand`]s (the `pty_write`/`pty_resize`/`pty_close` control
/// ops) against the owned process. Returns `Ok(())` on a clean PTY exit (the caller
/// closes the channel `PROCESS_EXIT`); a transport error propagates so the caller
/// can reconnect + resume and re-enter the pump.
///
/// # Errors
///
/// Propagates a [`StreamError::Transport`](crate::error::StreamError::Transport)
/// from the relay send/recv so the owner reconnects.
pub async fn run(
    process: &mut PtyProcess,
    channel: &mut RelayChannel,
    commands: &mut mpsc::Receiver<PtyCommand>,
) -> StreamResult<()> {
    // --- output: blocking reader → bounded channel ---------------------------
    let reader = process.take_reader();
    let (out_tx, mut out_rx) = mpsc::channel::<Vec<u8>>(OUTPUT_CHANNEL_BOUND);
    let reader_task = reader.map(|mut reader| {
        tokio::task::spawn_blocking(move || {
            let mut buf = [0u8; READ_CHUNK];
            loop {
                match reader.read(&mut buf) {
                    Ok(n) if n > 0 => {
                        // A full bounded channel blocks here = backpressure.
                        if out_tx.blocking_send(buf[..n].to_vec()).is_err() {
                            break; // the pump dropped the receiver.
                        }
                    }
                    // EOF (Ok(0): child exited + closed the master) or a read error
                    // both end the reader.
                    _ => break,
                }
            }
        })
    });

    // --- input: PTY writer driven on the blocking pool -----------------------
    // The writer is moved into a blocking task fed by a channel so async-side
    // inbound frames never block on the synchronous write.
    let writer = process.take_writer();
    let (in_tx, mut in_rx) = mpsc::channel::<Vec<u8>>(OUTPUT_CHANNEL_BOUND);
    let writer_task = writer.map(|mut writer| {
        tokio::task::spawn_blocking(move || {
            while let Some(bytes) = in_rx.blocking_recv() {
                if writer.write_all(&bytes).is_err() || writer.flush().is_err() {
                    break;
                }
            }
        })
    });

    let result = pump_loop(process, channel, commands, &mut out_rx, &in_tx).await;

    // Tear down: dropping the senders/receivers ends the blocking tasks.
    drop(in_tx);
    drop(out_rx);
    if let Some(t) = reader_task {
        t.abort();
    }
    if let Some(t) = writer_task {
        let _ = t.await;
    }
    result
}

/// The select loop: forward tty output frames out, apply inbound frames + control
/// commands to the PTY. Ends when output EOFs (PTY exit) or the relay drops.
async fn pump_loop(
    process: &mut PtyProcess,
    channel: &mut RelayChannel,
    commands: &mut mpsc::Receiver<PtyCommand>,
    out_rx: &mut mpsc::Receiver<Vec<u8>>,
    in_tx: &mpsc::Sender<Vec<u8>>,
) -> StreamResult<()> {
    // Once the command sender is dropped, stop selecting on it so a closed channel
    // (which resolves immediately) does not spin the loop.
    let mut commands_open = true;
    loop {
        tokio::select! {
            // tty output → relay frame.
            chunk = out_rx.recv() => {
                match chunk {
                    Some(bytes) => {
                        channel.send_frame(bytes::Bytes::from(bytes)).await?;
                    }
                    None => {
                        // The reader task ended (PTY EOF) — clean exit.
                        return Ok(());
                    }
                }
            }
            // relay inbound → tty input (or ignore non-frame control).
            inbound = channel.recv() => {
                match inbound? {
                    Some(RelayMessage::Frame(frame)) => {
                        // Best-effort: if the writer task ended, stop pumping input.
                        if in_tx.send(frame.data.to_vec()).await.is_err() {
                            return Ok(());
                        }
                    }
                    Some(RelayMessage::Close(_)) | None => return Ok(()),
                    // Open/OpenAck/DesktopInput are not expected on a live PTY data
                    // channel; ignore them defensively rather than tearing down.
                    Some(_) => {}
                }
            }
            // out-of-band control op (pty_write/resize/close over NATS). Disabled
            // once the sender drops so a closed channel does not spin the select.
            command = commands.recv(), if commands_open => {
                match command {
                    Some(PtyCommand::Write(bytes)) => {
                        let _ = in_tx.send(bytes).await;
                    }
                    Some(PtyCommand::Resize { cols, rows }) => {
                        let _ = apply_resize(process, cols, rows);
                    }
                    Some(PtyCommand::Close(reply)) => {
                        let code = process.try_exit_code().unwrap_or(-1);
                        let _ = process.kill();
                        let _ = reply.send(code);
                        return Ok(());
                    }
                    // The control sender was dropped; keep pumping the stream
                    // (control ops are optional) but stop selecting on the channel.
                    None => commands_open = false,
                }
            }
        }
    }
}

/// Applies a resize to the PTY, surfacing the result for logs.
fn apply_resize(process: &PtyProcess, cols: u16, rows: u16) -> PlatformResult<()> {
    process.resize(cols, rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use opengeni_agent_platform::{spawn_pty, PlatformError};
    use opengeni_agent_proto::v1;

    use crate::channel::{ChannelConfig, RelayChannel};
    use crate::transport::mock::MockTransport;
    use crate::transport::RelayTransport as _;

    /// TEST-ONLY NixOS-sandbox fork/exec transient-ENOENT mitigation for
    /// [`spawn_pty`]. Under the default parallel `cargo test`, this sandbox
    /// intermittently fails the `fork`/`exec` of the *known-present* shell with
    /// `ENOENT` purely from concurrent subprocess churn (it passes every time at
    /// `--test-threads=1`). `spawn_pty` surfaces a spawn `ENOENT` as a
    /// [`PlatformError::Os`] whose message contains the spawn context, so we retry
    /// a few times on exactly that signature. This is NOT production logic — the
    /// real `spawn_pty` returns its error immediately; only the test harness
    /// retries, and only for a shell it knows is installed (`/bin/sh`, `cmd.exe`).
    fn spawn_pty_resilient(
        req: &v1::PtyOpenRequest,
        default_shell: &[String],
    ) -> Result<PtyProcess, PlatformError> {
        const MAX_ATTEMPTS: u32 = 6;
        let is_transient_spawn_enoent = |err: &PlatformError| -> bool {
            let message = match err {
                PlatformError::NotFound(m) => m.as_str(),
                PlatformError::Os { message, .. } => message.as_str(),
                _ => return false,
            };
            message.contains("spawn")
                && (message.contains("os error 2") || message.contains("No such file or directory"))
        };
        for attempt in 1..=MAX_ATTEMPTS {
            match spawn_pty(req, default_shell) {
                Ok(proc) => return Ok(proc),
                Err(err) if attempt < MAX_ATTEMPTS && is_transient_spawn_enoent(&err) => {
                    std::thread::sleep(std::time::Duration::from_millis(5 * u64::from(attempt)));
                }
                Err(err) => return Err(err),
            }
        }
        unreachable!("the loop returns on the final attempt")
    }

    fn pty_channel_config() -> ChannelConfig {
        ChannelConfig {
            channel: v1::StreamChannel {
                channel_id: "pty-ch".to_string(),
                workspace_id: "ws".to_string(),
                agent_id: "ag".to_string(),
                kind: v1::StreamKind::Pty as i32,
                port: 7681,
            },
            token: "ogs_x".to_string(),
            relay_url: "wss://relay/stream".to_string(),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pty_output_is_framed_to_the_relay() {
        // Spawn a PTY that prints a marker and exits; the pump should ship at least
        // one frame whose bytes contain the marker, then end on EOF.
        let req = v1::PtyOpenRequest {
            command: if cfg!(windows) {
                vec![
                    "cmd.exe".to_string(),
                    "/C".to_string(),
                    "echo pumpmark".to_string(),
                ]
            } else {
                vec![
                    "/bin/sh".to_string(),
                    "-c".to_string(),
                    "printf pumpmark".to_string(),
                ]
            },
            cols: 80,
            rows: 24,
            ..Default::default()
        };
        let mut proc = spawn_pty_resilient(&req, &["/bin/sh".to_string()]).expect("spawn");

        let (agent_side, mut relay_side) = MockTransport::pair();
        let mut channel = RelayChannel::with_transport(pty_channel_config(), Box::new(agent_side));

        // Run the pump; collect what the relay side receives concurrently.
        let collector = tokio::spawn(async move {
            let mut seen = Vec::new();
            // Read a few frames until EOF/close.
            for _ in 0..64 {
                match relay_side.recv().await {
                    Ok(Some(RelayMessage::Frame(f))) => seen.extend_from_slice(&f.data),
                    Ok(Some(_)) => {}
                    Ok(None) | Err(_) => break,
                }
                if String::from_utf8_lossy(&seen).contains("pumpmark") {
                    break;
                }
            }
            seen
        });

        let (_cmd_tx, mut cmd_rx) = mpsc::channel::<PtyCommand>(8);
        let pump = run(&mut proc, &mut channel, &mut cmd_rx);
        // The PTY exits quickly; bound the test so a hang fails loudly.
        let _ = tokio::time::timeout(std::time::Duration::from_secs(10), pump).await;
        let seen = tokio::time::timeout(std::time::Duration::from_secs(2), collector)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default();
        assert!(
            String::from_utf8_lossy(&seen).contains("pumpmark"),
            "relay never saw the pty marker; saw {:?}",
            String::from_utf8_lossy(&seen)
        );
    }
}
