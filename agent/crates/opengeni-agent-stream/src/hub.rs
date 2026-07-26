//! The relay hub: the agent's [`StreamRegistry`] implementation.
//!
//! [`RelayHub`] is what the agent supervisor wires into the platform
//! (`NativePlatform::with_stream_registry`). When the control plane resolves a
//! stream port (`pty_open` / `desktop_ensure`), the platform hands the hub a
//! freshly-allocated PTY or the desktop backend; the hub:
//!
//! 1. mints a [`StreamChannel`] descriptor (a fresh `channel_id`, the channel key,
//!    the kind + port),
//! 2. opens a [`RelayChannel`] (dials the relay, registers as the producing AGENT,
//!    presenting the agent's relay token),
//! 3. spawns the matching pump ([`crate::pty_pump`] / [`crate::framebuffer_pump`])
//!    as a supervised background task that auto-reconnects + resumes on a relay
//!    blip (§10.6),
//! 4. returns the channel descriptor the control plane mints the viewer `ogs_`
//!    token against + returns to the browser.
//!
//! # The two tokens (a documented seam for M8b)
//!
//! The relay pairs a *producer* (agent) registration with a *consumer* (viewer)
//! attach by the channel key `{workspaceId, agentId, port}`. The viewer presents
//! the control-plane-minted scoped `ogs_` token (`mintStreamToken`); the AGENT
//! presents its enrollment-scoped relay token here. The proto `StreamOpen.token`
//! carries whichever side is registering. M8b's relay MUST validate BOTH sides'
//! tokens and only splice a producer↔consumer pair when the keys match and both
//! tokens pass (see the crate-level relay-dial protocol doc).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use opengeni_agent_platform::{
    DesktopBackend, PlatformError, PlatformResult, PtyProcess, StreamRegistry,
};
use opengeni_agent_proto::v1::{self, DesktopEnsureRequest, PtyOpenResponse, StreamChannel};
use tokio::sync::{mpsc, oneshot};

use crate::backoff::ChannelBackoff;
use crate::channel::{ChannelConfig, RelayChannel};
use crate::framebuffer_pump::{self, InputPolicy};
use crate::pty_pump::{self, PtyCommand, PtyControlTx};

/// The control-channel buffer per PTY (write/resize/close commands).
const PTY_COMMAND_BUFFER: usize = 32;

/// How long `register_pty`/`register_desktop` wait for the spawned pump to confirm
/// it is LIVE and has buffered its first real byte(s)/frame before giving up. The
/// mint is gated on this so a consumer dialing the minted URL always finds
/// replayable bytes; on a timeout the op returns a typed error rather than minting a
/// dead URL (or hanging forever). Generous enough for a cold Xvfb/X11 to settle and
/// a login shell to print a prompt, tight enough that a wedged pump fails the mint
/// fast.
const PUMP_READY_TIMEOUT: Duration = Duration::from_secs(5);

/// The logical port a PTY (terminal) stream maps to. Mirrors the in-box ttyd port
/// the existing terminal-server uses, so `resolveExposedPort(7681)` addresses it.
pub const PTY_STREAM_PORT: u32 = 7681;
/// The logical port a desktop (framebuffer) stream maps to (the noVNC port).
pub const DESKTOP_STREAM_PORT: u32 = 6080;

/// Static configuration for the relay hub: the agent identity, the relay URL, and
/// the agent's relay token + consent policy.
#[derive(Debug, Clone)]
pub struct RelayHubConfig {
    /// The workspace this agent is scoped to (the channel key + token scope).
    pub workspace_id: String,
    /// The agent (machine) id.
    pub agent_id: String,
    /// The relay base URL to dial (from enrollment; `wss://relay…`).
    pub relay_url: String,
    /// The agent's relay token presented on producer registration (enrollment
    /// scoped). NEVER logged. The viewer's `ogs_` token is a SEPARATE control-plane
    /// mint (see the module + crate docs).
    pub agent_token: String,
    /// Whether the user consented to screen-control (computer-use input). When
    /// false, desktop channels are view-only (inbound input is dropped).
    pub allow_screen_control: bool,
}

/// The agent-side relay hub. Cheap to clone (an `Arc` over the immutable config +
/// the shared PTY control table), so it can be shared with the platform and spawned
/// tasks.
#[derive(Clone)]
pub struct RelayHub {
    config: Arc<RelayHubConfig>,
    /// Live PTYs by `pty_id`, each with the control-channel sender the
    /// `pty_write`/`pty_resize`/`pty_close` ops reach. Entries are removed when the
    /// pump ends.
    ptys: Arc<Mutex<HashMap<String, PtyControlTx>>>,
}

impl std::fmt::Debug for RelayHub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RelayHub")
            .field("workspace_id", &self.config.workspace_id)
            .field("agent_id", &self.config.agent_id)
            .field("live_ptys", &self.ptys.lock().map_or(0, |m| m.len()))
            .finish_non_exhaustive()
    }
}

impl RelayHub {
    /// Builds a hub over the static config.
    #[must_use]
    pub fn new(config: RelayHubConfig) -> Self {
        Self {
            config: Arc::new(config),
            ptys: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Builds a [`StreamChannel`] descriptor for `(kind, port)` with a fresh
    /// channel id.
    fn descriptor(&self, kind: v1::StreamKind, port: u32) -> StreamChannel {
        StreamChannel {
            channel_id: new_channel_id(),
            workspace_id: self.config.workspace_id.clone(),
            agent_id: self.config.agent_id.clone(),
            kind: kind as i32,
            port,
        }
    }

    /// The channel config (descriptor + token + relay url) for a descriptor.
    fn channel_config(&self, channel: StreamChannel) -> ChannelConfig {
        ChannelConfig {
            channel,
            token: self.config.agent_token.clone(),
            relay_url: self.config.relay_url.clone(),
        }
    }
}

#[async_trait]
impl StreamRegistry for RelayHub {
    async fn register_pty(&self, process: PtyProcess) -> PlatformResult<PtyOpenResponse> {
        let descriptor = self.descriptor(v1::StreamKind::Pty, PTY_STREAM_PORT);
        let config = self.channel_config(descriptor.clone());
        let channel = RelayChannel::register(config.clone())
            .await
            .map_err(stream_to_platform)?;
        let pty_id = descriptor.channel_id.clone();

        // The control channel reaches the pump for pty_write/resize/close ops.
        let (cmd_tx, cmd_rx) = mpsc::channel::<PtyCommand>(PTY_COMMAND_BUFFER);
        if let Ok(mut ptys) = self.ptys.lock() {
            ptys.insert(pty_id.clone(), cmd_tx);
        }

        // Spawn the supervised pump: it auto-reconnects + resumes on a relay blip,
        // and de-registers the pty control entry when it ends. The readiness signal
        // is fired once the pump is live + has shipped the shell's first prompt
        // byte(s) into the relay ring, so a consumer dialing the minted URL sees
        // output WITHOUT having to type.
        let (ready_tx, ready_rx) = oneshot::channel();
        spawn_pty_pump(
            process,
            channel,
            cmd_rx,
            pty_id.clone(),
            self.ptys.clone(),
            ready_tx,
        );

        // Gate the mint on the pump being serveable: do not return the descriptor
        // until the first byte(s) are buffered. On a timeout (or a pump that died
        // before becoming ready) drop the half-registered control entry and surface
        // a typed error rather than minting a dead URL.
        await_pump_ready(ready_rx, "pty").await.inspect_err(|_| {
            if let Ok(mut ptys) = self.ptys.lock() {
                ptys.remove(&pty_id);
            }
        })?;

        Ok(PtyOpenResponse {
            pty_id,
            channel: Some(descriptor),
        })
    }

    async fn register_desktop(
        &self,
        desktop: Arc<dyn DesktopBackend>,
        _display: &v1::Display,
        _req: &DesktopEnsureRequest,
    ) -> PlatformResult<StreamChannel> {
        let descriptor = self.descriptor(v1::StreamKind::Desktop, DESKTOP_STREAM_PORT);
        let config = self.channel_config(descriptor.clone());
        let channel = RelayChannel::register(config.clone())
            .await
            .map_err(stream_to_platform)?;

        let policy = InputPolicy {
            allow_input: self.config.allow_screen_control,
        };
        // Gate the mint on the framebuffer pump having captured + forwarded its first
        // real frame (retrying a transient first-capture against Xvfb readiness), so
        // a consumer dialing the minted URL immediately replays a frame.
        let (ready_tx, ready_rx) = oneshot::channel();
        spawn_desktop_pump(desktop, channel, config, policy, ready_tx);
        await_pump_ready(ready_rx, "desktop").await?;

        Ok(descriptor)
    }

    async fn pty_write(&self, pty_id: &str, data: &[u8]) -> PlatformResult<()> {
        let tx = self.pty_sender(pty_id)?;
        tx.send(PtyCommand::Write(data.to_vec()))
            .await
            .map_err(|_| PlatformError::os("pty pump is no longer running"))
    }

    async fn pty_resize(&self, pty_id: &str, cols: u16, rows: u16) -> PlatformResult<()> {
        let tx = self.pty_sender(pty_id)?;
        tx.send(PtyCommand::Resize { cols, rows })
            .await
            .map_err(|_| PlatformError::os("pty pump is no longer running"))
    }

    async fn pty_close(&self, pty_id: &str) -> PlatformResult<i32> {
        let tx = self.pty_sender(pty_id)?;
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        tx.send(PtyCommand::Close(reply_tx))
            .await
            .map_err(|_| PlatformError::os("pty pump is no longer running"))?;
        // The pump replies with the exit code then ends; a dropped reply (pump
        // already gone) is treated as an unknown exit code.
        Ok(reply_rx.await.unwrap_or(-1))
    }
}

impl RelayHub {
    /// Looks up the control sender for an open PTY, or a typed `NotFound`.
    fn pty_sender(&self, pty_id: &str) -> PlatformResult<PtyControlTx> {
        self.ptys
            .lock()
            .ok()
            .and_then(|m| m.get(pty_id).cloned())
            .ok_or_else(|| PlatformError::NotFound(format!("no open pty: {pty_id}")))
    }
}

/// Spawns the supervised PTY pump: run the pump; on a retryable transport drop,
/// reconnect (full-jitter) + resume; stop on a clean PTY exit or a terminal error.
/// De-registers the pty control entry on exit.
fn spawn_pty_pump(
    mut process: PtyProcess,
    mut channel: RelayChannel,
    mut commands: mpsc::Receiver<PtyCommand>,
    pty_id: String,
    ptys: Arc<Mutex<HashMap<String, PtyControlTx>>>,
    ready: oneshot::Sender<()>,
) {
    tokio::spawn(async move {
        // The readiness signal is fired by the pump on its FIRST run only; a
        // reconnect re-enters the pump with `None`.
        let mut ready = Some(ready);
        let mut backoff = ChannelBackoff::standard();
        loop {
            match pty_pump::run(&mut process, &mut channel, &mut commands, ready.take()).await {
                Ok(()) => {
                    // Clean PTY exit: tear the channel down with PROCESS_EXIT.
                    channel
                        .close(v1::StreamCloseReason::ProcessExit, "pty exited")
                        .await;
                    break;
                }
                Err(e) if e.retryable() => {
                    tracing::warn!(error = %e, "pty relay channel dropped; reconnecting");
                    if channel.reconnect(backoff.next_delay()).await.is_err() {
                        // The owner gave up (rejected open); stop the pump.
                        break;
                    }
                    backoff.reset();
                }
                Err(e) => {
                    tracing::error!(error = %e, "pty pump terminal error");
                    break;
                }
            }
        }
        let _ = process.kill();
        if let Ok(mut map) = ptys.lock() {
            map.remove(&pty_id);
        }
    });
}

/// Spawns the supervised desktop framebuffer pump (auto-reconnect + resume).
fn spawn_desktop_pump(
    desktop: Arc<dyn DesktopBackend>,
    mut channel: RelayChannel,
    _config: ChannelConfig,
    policy: InputPolicy,
    ready: oneshot::Sender<()>,
) {
    tokio::spawn(async move {
        // The readiness signal is fired by the pump on its FIRST run only (after the
        // first frame is captured + forwarded); a reconnect re-enters with `None`.
        let mut ready = Some(ready);
        let mut backoff = ChannelBackoff::standard();
        loop {
            match framebuffer_pump::run(&desktop, &mut channel, policy, ready.take()).await {
                Ok(()) => {
                    channel
                        .close(v1::StreamCloseReason::Normal, "desktop closed")
                        .await;
                    break;
                }
                Err(e) if e.retryable() => {
                    tracing::warn!(error = %e, "desktop relay channel dropped; reconnecting");
                    if channel.reconnect(backoff.next_delay()).await.is_err() {
                        break;
                    }
                    backoff.reset();
                }
                Err(e) => {
                    tracing::error!(error = %e, "desktop pump terminal error");
                    break;
                }
            }
        }
    });
}

/// Awaits the pump's readiness signal with a bounded timeout, mapping the two
/// failure modes to typed platform errors so the mint never hangs and never returns
/// a dead URL:
///
/// * the sender is DROPPED before firing (the pump died — e.g. a relay drop or a
///   non-retryable first-capture failure — before serving a byte) ⇒ `Os`,
/// * the timeout elapses (the pump is wedged) ⇒ `Timeout`.
async fn await_pump_ready(ready_rx: oneshot::Receiver<()>, kind: &str) -> PlatformResult<()> {
    match tokio::time::timeout(PUMP_READY_TIMEOUT, ready_rx).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_recv)) => Err(PlatformError::os(format!(
            "{kind} stream pump ended before it became ready"
        ))),
        Err(_elapsed) => Err(PlatformError::Timeout(format!(
            "{kind} stream pump did not become ready within {}s",
            PUMP_READY_TIMEOUT.as_secs()
        ))),
    }
}

/// A fresh channel id (a random hex token). Avoids pulling a uuid crate for what is
/// only a relay routing handle.
fn new_channel_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    // Mix in a per-process counter so two channels opened in the same nanosecond
    // tick still differ.
    let counter = CHANNEL_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("ch-{nanos:x}-{counter:x}")
}

static CHANNEL_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Maps a stream error to a platform error so the dispatch path surfaces a typed
/// `AgentError`. A relay open failure is a `STREAM`-class condition.
fn stream_to_platform(e: crate::error::StreamError) -> PlatformError {
    match e {
        crate::error::StreamError::Platform(p) => p,
        other => PlatformError::os(format!("relay stream: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_ids_are_unique() {
        let a = new_channel_id();
        let b = new_channel_id();
        assert_ne!(a, b);
        assert!(a.starts_with("ch-"));
    }

    #[test]
    fn descriptor_carries_the_channel_key() {
        let hub = RelayHub::new(RelayHubConfig {
            workspace_id: "ws".to_string(),
            agent_id: "ag".to_string(),
            relay_url: "wss://relay".to_string(),
            agent_token: "tok".to_string(),
            allow_screen_control: true,
        });
        let d = hub.descriptor(v1::StreamKind::Pty, PTY_STREAM_PORT);
        assert_eq!(d.workspace_id, "ws");
        assert_eq!(d.agent_id, "ag");
        assert_eq!(d.port, PTY_STREAM_PORT);
        assert_eq!(d.kind(), v1::StreamKind::Pty);
    }

    #[tokio::test]
    async fn await_pump_ready_returns_when_the_pump_signals() {
        let (tx, rx) = oneshot::channel();
        tx.send(()).expect("send ready");
        await_pump_ready(rx, "pty")
            .await
            .expect("a fired signal resolves Ok");
    }

    #[tokio::test]
    async fn await_pump_ready_times_out_with_a_typed_error_rather_than_hanging() {
        // A pump that never becomes ready must yield a typed Timeout (retryable at
        // the control plane), NOT hang the mint forever. `pause`d time fast-forwards
        // past the readiness timeout deterministically.
        tokio::time::pause();
        // Hold the sender so the channel is open but never fires.
        let (_tx, rx) = oneshot::channel();
        let waiter = tokio::spawn(async move { await_pump_ready(rx, "desktop").await });
        // Advance virtual time past the readiness budget.
        tokio::time::advance(PUMP_READY_TIMEOUT + Duration::from_secs(1)).await;
        let err = waiter
            .await
            .expect("waiter task")
            .expect_err("an un-fired pump must error");
        assert!(matches!(err, PlatformError::Timeout(_)), "got {err:?}");
        assert_eq!(err.code(), v1::ErrorCode::Timeout);
    }

    #[tokio::test]
    async fn await_pump_ready_reports_a_pump_that_died_before_becoming_ready() {
        // A pump that drops its sender (it died — a relay drop / non-retryable first
        // capture — before serving a byte) must surface a typed Os error, not a hang.
        let (tx, rx) = oneshot::channel();
        drop(tx); // the pump ended without firing readiness.
        let err = await_pump_ready(rx, "pty")
            .await
            .expect_err("a dropped sender must error");
        assert!(matches!(err, PlatformError::Os { .. }), "got {err:?}");
    }
}
