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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use opengeni_agent_platform::{
    DesktopBackend, PlatformError, PlatformResult, PtyProcess, StreamRegistry,
};
use opengeni_agent_proto::v1::{self, DesktopEnsureRequest, PtyOpenResponse, StreamChannel};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;

use crate::backoff::ChannelBackoff;
use crate::channel::{ChannelConfig, RelayChannel, SharedRelayCredentials};
use crate::framebuffer_pump::{self, InputPolicy};
use crate::pty_pump::{self, PtyCommand, PtyControlTx, PtyIo, PtyPumpExit};
use crate::StreamResult;

/// The control-channel buffer per PTY (write/resize/close commands).
const PTY_COMMAND_BUFFER: usize = 32;

/// Local PTY termination remains observable while a relay registration is in
/// backoff or dialing. This is deliberately short relative to the 30s reconnect
/// cap while still avoiding a busy poll of the portable-pty child handle.
const PTY_EXIT_POLL_INTERVAL: Duration = Duration::from_millis(100);

/// How long `register_pty`/`register_desktop` wait for the spawned pump to confirm
/// it is LIVE and has buffered its first real byte(s)/frame before giving up. The
/// mint is gated on this so a consumer dialing the minted URL always finds
/// replayable bytes; on a timeout the op cancels and joins the half-started worker,
/// then returns a typed error rather than minting a dead URL (or hanging forever).
/// Generous enough for a cold Xvfb/X11 to settle and a login shell to print a
/// prompt, tight enough that a wedged pump fails the mint fast.
const PUMP_READY_TIMEOUT: Duration = Duration::from_secs(5);

/// Cancels a spawned pump if its registration future fails or is itself dropped
/// before the readiness barrier succeeds. Once readiness succeeds the guard is
/// disarmed and the supervisor becomes independently long-lived.
struct StartupCancellation {
    sender: Option<watch::Sender<bool>>,
}

impl StartupCancellation {
    fn cancel(&mut self) {
        if let Some(sender) = self.sender.take() {
            let _ = sender.send(true);
        }
    }

    fn disarm(&mut self) {
        self.sender.take();
    }
}

impl Drop for StartupCancellation {
    fn drop(&mut self) {
        self.cancel();
    }
}

/// Owns startup cancellation and the spawned task until the readiness boundary
/// settles. A typed startup failure joins the task so no PTY/desktop worker is
/// still alive when the API returns the error; dropping this future still signals
/// cancellation through [`StartupCancellation`].
struct PumpStartup {
    cancellation: StartupCancellation,
    task: Option<JoinHandle<()>>,
}

impl PumpStartup {
    async fn await_ready(
        mut self,
        ready_rx: oneshot::Receiver<()>,
        kind: &str,
    ) -> PlatformResult<()> {
        let result = await_pump_ready(ready_rx, kind).await;
        if result.is_ok() {
            self.cancellation.disarm();
        } else {
            self.cancellation.cancel();
            if let Some(task) = self.task.take() {
                let _ = task.await;
            }
        }
        result
    }
}

fn startup_cancellation() -> (
    StartupCancellation,
    watch::Receiver<bool>,
    watch::Sender<bool>,
) {
    let (keepalive, receiver) = watch::channel(false);
    let cancellation = StartupCancellation {
        sender: Some(keepalive.clone()),
    };
    (cancellation, receiver, keepalive)
}

async fn startup_cancelled(cancel: &mut watch::Receiver<bool>) {
    // The task owns a sender clone for its entire lifetime, so channel closure is
    // not a cancellation signal. Only the registration guard publishing `true`
    // may stop a pre-readiness supervisor.
    let _ = cancel.wait_for(|cancelled| *cancelled).await;
}

/// The logical port a PTY (terminal) stream maps to. Mirrors the in-box ttyd port
/// the existing terminal-server uses, so `resolveExposedPort(7681)` addresses it.
pub const PTY_STREAM_PORT: u32 = 7681;
/// The logical port a desktop (framebuffer) stream maps to (the noVNC port).
pub const DESKTOP_STREAM_PORT: u32 = 6080;

/// Static configuration for the relay hub: the agent identity, the relay URL, and
/// the agent's relay token + consent policy.
#[derive(Clone)]
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

impl std::fmt::Debug for RelayHubConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RelayHubConfig")
            .field("workspace_id", &self.workspace_id)
            .field("agent_id", &self.agent_id)
            .field("allow_screen_control", &self.allow_screen_control)
            .finish_non_exhaustive()
    }
}

/// The agent-side relay hub. Cheap to clone (an `Arc` over the immutable config +
/// the shared PTY control table), so it can be shared with the platform and spawned
/// tasks.
#[derive(Clone)]
pub struct RelayHub {
    config: Arc<RelayHubConfig>,
    credentials: SharedRelayCredentials,
    allow_screen_control: Arc<AtomicBool>,
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
        let credentials =
            SharedRelayCredentials::new(config.agent_token.clone(), config.relay_url.clone());
        Self {
            allow_screen_control: Arc::new(AtomicBool::new(config.allow_screen_control)),
            config: Arc::new(config),
            credentials,
            ptys: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Atomically publishes a refreshed relay endpoint/token pair. Existing pumps
    /// keep their current socket; their next reconnect, and every new channel,
    /// snapshot this source immediately before dialing and opening.
    pub fn update_credentials(
        &self,
        relay_url: String,
        agent_token: String,
        allow_screen_control: bool,
    ) {
        self.credentials.update(agent_token, relay_url);
        self.allow_screen_control
            .store(allow_screen_control, Ordering::Release);
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
        ChannelConfig::with_shared_credentials(channel, self.credentials.clone())
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
        let startup = spawn_pty_pump(
            process,
            channel,
            cmd_rx,
            pty_id.clone(),
            self.ptys.clone(),
            ready_tx,
        );

        // Gate the mint on the pump being serveable: do not return the descriptor
        // until the first byte(s) are buffered. On a timeout (or a pump that died
        // before becoming ready) cancel + join the half-started process worker,
        // remove its control entry, and surface a typed error rather than minting a
        // dead URL. Dropping this registration future triggers the same cancellation.
        startup
            .await_ready(ready_rx, "pty")
            .await
            .inspect_err(|_| {
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
            allow_input: self.allow_screen_control.load(Ordering::Acquire),
        };
        // Gate the mint on the framebuffer pump having captured + forwarded its first
        // real frame (retrying a transient first-capture against Xvfb readiness), so
        // a consumer dialing the minted URL immediately replays a frame. A timeout
        // or dropped registration future cancels the half-started capture worker.
        let (ready_tx, ready_rx) = oneshot::channel();
        let startup = spawn_desktop_pump(desktop, channel, config, policy, ready_tx);
        startup.await_ready(ready_rx, "desktop").await?;

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
) -> PumpStartup {
    let (cancellation, mut cancel, cancel_keepalive) = startup_cancellation();
    let task = tokio::spawn(async move {
        let _cancel_keepalive = cancel_keepalive;
        let mut ready = Some(ready);
        let mut backoff = ChannelBackoff::standard();
        let mut io = match PtyIo::start(&mut process).await {
            Ok(io) => io,
            Err(error) => {
                tracing::error!(%error, "failed to start process-owned PTY IO");
                let _ = process.kill();
                if let Ok(mut map) = ptys.lock() {
                    map.remove(&pty_id);
                }
                return;
            }
        };
        'supervisor: loop {
            let pump_result = tokio::select! {
                biased;
                () = startup_cancelled(&mut cancel) => break 'supervisor,
                result = pty_pump::run(
                    &mut process,
                    &mut io,
                    &mut channel,
                    &mut commands,
                    &mut ready,
                ) => result,
            };
            match pump_result {
                Ok(PtyPumpExit::ProcessExited) => {
                    channel
                        .close(v1::StreamCloseReason::ProcessExit, "pty exited")
                        .await;
                    break;
                }
                Ok(PtyPumpExit::UserClosed) => {
                    channel
                        .close(v1::StreamCloseReason::Normal, "pty closed")
                        .await;
                    break;
                }
                Ok(PtyPumpExit::RemoteClosed) => break,
                Err(e) if e.retryable() => {
                    tracing::warn!(error = %e, "pty relay channel dropped; reconnecting");
                    let reconnect_result = tokio::select! {
                        biased;
                        () = startup_cancelled(&mut cancel) => break 'supervisor,
                        result = reconnect_pty_until_ready(
                            &mut channel,
                            &mut backoff,
                            &mut process,
                            &mut io,
                            &mut commands,
                        ) => result,
                    };
                    match reconnect_result {
                        Ok(None) => {}
                        Ok(Some(_terminal)) => break,
                        Err(error) => {
                            tracing::error!(%error, "pty relay reconnect terminal error");
                            break;
                        }
                    }
                }
                Err(e) => {
                    tracing::error!(error = %e, "pty pump terminal error");
                    break;
                }
            }
        }
        let _ = process.kill();
        io.shutdown().await;
        if let Ok(mut map) = ptys.lock() {
            map.remove(&pty_id);
        }
    });
    PumpStartup {
        cancellation,
        task: Some(task),
    }
}

/// Spawns the supervised desktop framebuffer pump (auto-reconnect + resume).
fn spawn_desktop_pump(
    desktop: Arc<dyn DesktopBackend>,
    mut channel: RelayChannel,
    _config: ChannelConfig,
    policy: InputPolicy,
    ready: oneshot::Sender<()>,
) -> PumpStartup {
    let (cancellation, mut cancel, cancel_keepalive) = startup_cancellation();
    let task = tokio::spawn(async move {
        let _cancel_keepalive = cancel_keepalive;
        let mut ready = Some(ready);
        let mut backoff = ChannelBackoff::standard();
        'supervisor: loop {
            let pump_result = tokio::select! {
                biased;
                () = startup_cancelled(&mut cancel) => break 'supervisor,
                result = framebuffer_pump::run(&desktop, &mut channel, policy, &mut ready) => result,
            };
            match pump_result {
                Ok(()) => {
                    channel
                        .close(v1::StreamCloseReason::Normal, "desktop closed")
                        .await;
                    break;
                }
                Err(e) if e.retryable() => {
                    tracing::warn!(error = %e, "desktop relay channel dropped; reconnecting");
                    let reconnect_result = tokio::select! {
                        biased;
                        () = startup_cancelled(&mut cancel) => break 'supervisor,
                        result = reconnect_until_ready(&mut channel, &mut backoff, "desktop") => result,
                    };
                    if let Err(error) = reconnect_result {
                        tracing::error!(%error, "desktop relay reconnect terminal error");
                        break;
                    }
                }
                Err(e) => {
                    tracing::error!(error = %e, "desktop pump terminal error");
                    break;
                }
            }
        }
    });
    PumpStartup {
        cancellation,
        task: Some(task),
    }
}

/// The reconnect seam shared by PTY and desktop supervisors. Production uses
/// `RelayChannel`; tests use a scripted target to prove repeated transport/dial
/// failures remain retryable while protocol/open rejection is terminal.
#[async_trait]
trait ReconnectTarget {
    async fn reconnect_target(&mut self, delay: Duration) -> StreamResult<()>;
}

#[async_trait]
impl ReconnectTarget for RelayChannel {
    async fn reconnect_target(&mut self, delay: Duration) -> StreamResult<()> {
        self.reconnect(delay).await
    }
}

/// Retries transport/redial failures indefinitely with bounded full-jitter
/// backoff. A successful registration resets the window; typed protocol/open
/// rejection remains terminal.
async fn reconnect_until_ready<T: ReconnectTarget + Send>(
    target: &mut T,
    backoff: &mut ChannelBackoff,
    kind: &str,
) -> StreamResult<()> {
    loop {
        match target.reconnect_target(backoff.next_delay()).await {
            Ok(()) => {
                backoff.reset();
                return Ok(());
            }
            Err(error) if error.retryable() => {
                tracing::warn!(%error, kind, attempt = backoff.attempt(), "relay redial failed; retrying");
            }
            Err(error) => return Err(error),
        }
    }
}

/// PTY reconnect supervision also continues servicing out-of-band commands. A
/// user can write, resize, or close the same process while the relay is down;
/// command handling never consumes its persistent reader/writer workers.
async fn reconnect_pty_until_ready<T: ReconnectTarget + Send>(
    channel: &mut T,
    backoff: &mut ChannelBackoff,
    process: &mut PtyProcess,
    io: &mut PtyIo,
    commands: &mut mpsc::Receiver<PtyCommand>,
) -> StreamResult<Option<PtyPumpExit>> {
    let mut exit_poll = tokio::time::interval(PTY_EXIT_POLL_INTERVAL);
    exit_poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let reconnect = channel.reconnect_target(backoff.next_delay());
        tokio::pin!(reconnect);
        loop {
            tokio::select! {
                result = &mut reconnect => {
                    match result {
                        Ok(()) => {
                            backoff.reset();
                            return Ok(None);
                        }
                        Err(error) if error.retryable() => {
                            tracing::warn!(%error, attempt = backoff.attempt(), "pty relay redial failed; retrying");
                            break;
                        }
                        Err(error) => return Err(error),
                    }
                }
                command = commands.recv(), if io.commands_open() => {
                    if let Some(exit) = io.handle_command(process, command).await {
                        return Ok(Some(exit));
                    }
                }
                _ = exit_poll.tick() => {
                    if process.try_exit_code().is_some() || io.output_closed() {
                        return Ok(Some(PtyPumpExit::ProcessExited));
                    }
                }
            }
        }
    }
}

/// Awaits the pump's readiness signal with a bounded timeout, mapping the two
/// failure modes to typed platform errors so the mint never hangs and never returns
/// a dead URL:
///
/// * the sender is DROPPED before firing (the pump ended on a terminal platform or
///   protocol failure before serving a byte) ⇒ `Os`,
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
    use crate::codec::RelayMessage;
    use crate::transport::mock::MockTransport;
    use crate::transport::RelayTransport;
    use crate::StreamError;
    use opengeni_agent_platform::CapturedFrame;
    use std::collections::VecDeque;

    enum ReconnectStep {
        Transport,
        Accepted,
        Rejected,
    }

    struct ScriptedReconnect {
        steps: VecDeque<ReconnectStep>,
        calls: usize,
    }

    struct PendingReconnect;

    struct PendingTransport;

    struct NeverReadyDesktop;

    #[async_trait]
    impl RelayTransport for PendingTransport {
        async fn send(&mut self, _message: &RelayMessage) -> StreamResult<()> {
            std::future::pending().await
        }

        async fn recv(&mut self) -> StreamResult<Option<RelayMessage>> {
            std::future::pending().await
        }
    }

    #[async_trait]
    impl DesktopBackend for NeverReadyDesktop {
        fn probe(&self) -> Option<v1::Display> {
            Some(v1::Display {
                id: ":never-ready".to_string(),
                width: 4,
                height: 4,
                r#virtual: true,
            })
        }

        async fn capture(&self) -> PlatformResult<CapturedFrame> {
            std::future::pending().await
        }

        async fn inject(&self, _input: &v1::DesktopInput) -> PlatformResult<()> {
            Ok(())
        }
    }

    fn test_channel_config(kind: v1::StreamKind, port: u32) -> ChannelConfig {
        ChannelConfig::new(
            v1::StreamChannel {
                channel_id: format!("test-{port}"),
                workspace_id: "ws".to_string(),
                agent_id: "ag".to_string(),
                kind: kind as i32,
                port,
            },
            "agent-token".to_string(),
            "wss://relay.invalid/stream".to_string(),
        )
    }

    #[cfg(unix)]
    fn spawn_test_pty(request: &v1::PtyOpenRequest) -> PlatformResult<PtyProcess> {
        const MAX_ATTEMPTS: u32 = 6;
        for attempt in 1..=MAX_ATTEMPTS {
            match opengeni_agent_platform::spawn_pty(request, &["/bin/sh".to_string()]) {
                Ok(process) => return Ok(process),
                Err(error)
                    if attempt < MAX_ATTEMPTS
                        && error.to_string().contains("spawn")
                        && (error.to_string().contains("os error 2")
                            || error.to_string().contains("No such file or directory")) =>
                {
                    std::thread::sleep(Duration::from_millis(5 * u64::from(attempt)));
                }
                Err(error) => return Err(error),
            }
        }
        unreachable!("the loop returns on the final attempt")
    }

    #[async_trait]
    impl ReconnectTarget for ScriptedReconnect {
        async fn reconnect_target(&mut self, delay: Duration) -> StreamResult<()> {
            tokio::time::sleep(delay).await;
            self.calls += 1;
            match self.steps.pop_front().expect("scripted reconnect step") {
                ReconnectStep::Transport => {
                    Err(StreamError::Transport("relay unavailable".to_string()))
                }
                ReconnectStep::Accepted => Ok(()),
                ReconnectStep::Rejected => {
                    Err(StreamError::OpenRejected("credential rejected".to_string()))
                }
            }
        }
    }

    #[async_trait]
    impl ReconnectTarget for PendingReconnect {
        async fn reconnect_target(&mut self, _delay: Duration) -> StreamResult<()> {
            std::future::pending().await
        }
    }

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

    #[test]
    fn channel_configs_observe_atomically_rotated_credentials() {
        let hub = RelayHub::new(RelayHubConfig {
            workspace_id: "ws".to_string(),
            agent_id: "ag".to_string(),
            relay_url: "wss://old.example/stream".to_string(),
            agent_token: "old-token".to_string(),
            allow_screen_control: true,
        });
        let existing = hub.channel_config(hub.descriptor(v1::StreamKind::Pty, PTY_STREAM_PORT));
        assert!(existing.dial_url().starts_with("wss://old.example/stream?"));

        hub.update_credentials(
            "wss://new.example/stream".to_string(),
            "rotated-token".to_string(),
            false,
        );

        assert!(existing.dial_url().starts_with("wss://new.example/stream?"));
        let fresh = hub.channel_config(hub.descriptor(v1::StreamKind::Pty, PTY_STREAM_PORT));
        assert!(fresh.dial_url().starts_with("wss://new.example/stream?"));
        assert!(!hub.allow_screen_control.load(Ordering::Acquire));
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

    #[tokio::test(start_paused = true)]
    async fn desktop_readiness_timeout_cancels_and_joins_the_live_supervisor() {
        let concrete = Arc::new(NeverReadyDesktop);
        let desktop: Arc<dyn DesktopBackend> = concrete.clone();
        let (agent_side, _relay_side) = MockTransport::pair();
        let config = test_channel_config(v1::StreamKind::Desktop, DESKTOP_STREAM_PORT);
        let channel = RelayChannel::with_transport(config.clone(), Box::new(agent_side));
        let (ready_tx, ready_rx) = oneshot::channel();
        let startup = spawn_desktop_pump(
            desktop,
            channel,
            config,
            InputPolicy { allow_input: false },
            ready_tx,
        );

        let waiter = tokio::spawn(async move { startup.await_ready(ready_rx, "desktop").await });
        tokio::task::yield_now().await;
        tokio::time::advance(PUMP_READY_TIMEOUT + Duration::from_secs(1)).await;
        let error = waiter
            .await
            .expect("startup waiter task")
            .expect_err("a pending first capture must time out");

        assert!(matches!(error, PlatformError::Timeout(_)), "got {error:?}");
        assert_eq!(
            Arc::strong_count(&concrete),
            1,
            "the failed registration must join and release its desktop worker"
        );
    }

    #[tokio::test]
    async fn dropping_the_startup_waiter_cancels_the_live_desktop_supervisor() {
        let concrete = Arc::new(NeverReadyDesktop);
        let desktop: Arc<dyn DesktopBackend> = concrete.clone();
        let (agent_side, _relay_side) = MockTransport::pair();
        let config = test_channel_config(v1::StreamKind::Desktop, DESKTOP_STREAM_PORT);
        let channel = RelayChannel::with_transport(config.clone(), Box::new(agent_side));
        let (ready_tx, ready_rx) = oneshot::channel();
        let startup = spawn_desktop_pump(
            desktop,
            channel,
            config,
            InputPolicy { allow_input: false },
            ready_tx,
        );

        let waiter = tokio::spawn(async move { startup.await_ready(ready_rx, "desktop").await });
        tokio::task::yield_now().await;
        waiter.abort();
        let _ = waiter.await;

        tokio::time::timeout(Duration::from_secs(1), async {
            while Arc::strong_count(&concrete) != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("caller cancellation must release the desktop worker");
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pty_readiness_timeout_cancels_the_process_and_deregisters_it() {
        let request = v1::PtyOpenRequest {
            command: vec!["/bin/cat".to_string()],
            cols: 80,
            rows: 24,
            ..Default::default()
        };
        let process = spawn_test_pty(&request).expect("spawn long-lived PTY");
        let config = test_channel_config(v1::StreamKind::Pty, PTY_STREAM_PORT);
        let channel = RelayChannel::with_transport(config, Box::new(PendingTransport));
        let (command_tx, commands) = mpsc::channel(1);
        let pty_id = "startup-timeout-pty".to_string();
        let ptys = Arc::new(Mutex::new(HashMap::new()));
        ptys.lock()
            .expect("pty registry")
            .insert(pty_id.clone(), command_tx);
        let (ready_tx, ready_rx) = oneshot::channel();
        let startup = spawn_pty_pump(process, channel, commands, pty_id, ptys.clone(), ready_tx);

        let error = startup
            .await_ready(ready_rx, "pty")
            .await
            .expect_err("a stalled relay send must time out startup");

        assert!(matches!(error, PlatformError::Timeout(_)), "got {error:?}");
        assert!(
            ptys.lock().expect("pty registry").is_empty(),
            "the failed registration must join cleanup and remove its PTY control handle"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn reconnect_retries_repeated_transport_failures_then_resets_backoff() {
        let mut target = ScriptedReconnect {
            steps: VecDeque::from([
                ReconnectStep::Transport,
                ReconnectStep::Transport,
                ReconnectStep::Transport,
                ReconnectStep::Accepted,
            ]),
            calls: 0,
        };
        let mut backoff = ChannelBackoff::new(Duration::from_millis(10), Duration::from_secs(1));
        reconnect_until_ready(&mut target, &mut backoff, "test")
            .await
            .expect("transport failures remain retryable");
        assert_eq!(target.calls, 4);
        assert_eq!(backoff.attempt(), 0, "success resets the jitter window");
    }

    #[tokio::test(start_paused = true)]
    async fn reconnect_stops_on_typed_open_rejection() {
        let mut target = ScriptedReconnect {
            steps: VecDeque::from([ReconnectStep::Rejected]),
            calls: 0,
        };
        let mut backoff = ChannelBackoff::standard();
        let error = reconnect_until_ready(&mut target, &mut backoff, "test")
            .await
            .expect_err("open rejection is terminal");
        assert!(matches!(error, StreamError::OpenRejected(_)));
        assert_eq!(target.calls, 1);
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reconnect_stops_when_the_local_pty_exits_during_a_relay_outage() {
        let request = v1::PtyOpenRequest {
            command: vec![
                "/bin/sh".to_string(),
                "-c".to_string(),
                "exit 0".to_string(),
            ],
            cols: 80,
            rows: 24,
            ..Default::default()
        };
        let mut process = opengeni_agent_platform::spawn_pty(&request, &["/bin/sh".to_string()])
            .expect("spawn short-lived PTY");
        let mut io = PtyIo::start(&mut process).await.expect("start PTY IO");
        let (_command_tx, mut commands) = mpsc::channel(1);
        let mut target = PendingReconnect;
        let mut backoff = ChannelBackoff::new(Duration::ZERO, Duration::ZERO);

        let exit = tokio::time::timeout(
            Duration::from_secs(2),
            reconnect_pty_until_ready(
                &mut target,
                &mut backoff,
                &mut process,
                &mut io,
                &mut commands,
            ),
        )
        .await
        .expect("local exit must interrupt an indefinitely pending redial")
        .expect("local exit is not a stream error");
        assert_eq!(exit, Some(PtyPumpExit::ProcessExited));
        io.shutdown().await;
    }
}
