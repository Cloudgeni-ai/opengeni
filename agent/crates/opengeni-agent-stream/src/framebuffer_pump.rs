//! The framebuffer pump: bridges a [`DesktopBackend`] and a [`RelayChannel`].
//!
//! * **Output** (capture → relay): on a frame-rate interval the pump captures the
//!   desktop ([`DesktopBackend::capture`], a PNG-encoded [`CapturedFrame`]) and
//!   ships the bytes as a [`StreamFrame`](opengeni_agent_proto::v1::StreamFrame).
//!   Capture runs on the platform's blocking pool (inside the backend), so the
//!   pump's async loop is never stalled.
//! * **Input** (relay → desktop): inbound [`DesktopInput`] messages are typed
//!   computer-use events ([`DesktopBackend::inject`]). A raw [`StreamFrame`] on a
//!   desktop channel is ignored (desktop input is typed, not opaque bytes — see the
//!   proto note on `StreamFrame`).
//!
//! On a relay drop the pump's send returns; the owner re-registers + resumes. The
//! desktop backend is unaffected, so a relay blip never loses the display (§10.6).
//!
//! The consent gate (`consented_screen_control`) is enforced by the caller BEFORE
//! a desktop channel is registered + before input is applied; a backend with no
//! display additionally refuses capture/inject with a typed error.

use std::sync::Arc;
use std::time::Duration;

use opengeni_agent_platform::DesktopBackend;

use crate::channel::RelayChannel;
use crate::codec::RelayMessage;
use crate::error::{StreamError, StreamResult};

/// The default desktop frame interval (~10 fps). A real codec / damage-tracking
/// upgrade is a pump change, not a protocol change (dossier §10.5). Kept modest so
/// a PNG-per-frame stream does not saturate the relay; M12 tunes it live.
const DEFAULT_FRAME_INTERVAL: Duration = Duration::from_millis(100);

/// How many times the pump retries the FIRST `capture()` before it gives up. Xvfb /
/// the X server can take a beat to settle after `desktop_ensure` probed the display,
/// so the framebuffer's first capture can fail transiently; we retry against that
/// readiness rather than skipping the frame (which would leave the mint un-served).
const FIRST_CAPTURE_MAX_ATTEMPTS: u32 = 20;
/// The delay between first-capture retries (~20 × 100ms ≈ 2s of Xvfb settle budget,
/// comfortably inside the owner's readiness timeout).
const FIRST_CAPTURE_RETRY_DELAY: Duration = Duration::from_millis(100);

/// A one-shot pump-readiness signal: the framebuffer pump fires it once it has
/// CAPTURED AND FORWARDED its first real frame, so a consumer dialing the minted URL
/// is guaranteed a replayable frame. The owner (`register_desktop`) awaits it (with
/// a timeout) before returning the descriptor.
pub type ReadyTx = tokio::sync::oneshot::Sender<()>;

/// Whether the agent is allowed to apply synthetic input on this channel. Set from
/// the enrollment `consented_screen_control` grant; when `false` the pump captures
/// (view-only) but drops inbound input.
#[derive(Debug, Clone, Copy)]
pub struct InputPolicy {
    /// True when the user consented to screen-control (computer-use input).
    pub allow_input: bool,
}

/// Runs the framebuffer pump until the relay transport drops. Captures + ships a
/// frame each interval and applies inbound computer-use input (when consented).
///
/// `ready` (when `Some`) is fired once the FIRST real frame has been captured AND
/// forwarded to the relay ring, so the owner's mint is gated on a serveable channel.
/// The sender remains in the caller-owned option across retryable transport errors
/// and is consumed only after a real frame is forwarded.
///
/// # Errors
///
/// Propagates a [`StreamError::Transport`](crate::error::StreamError::Transport)
/// from the relay so the owner reconnects + resumes.
pub async fn run(
    desktop: &Arc<dyn DesktopBackend>,
    channel: &mut RelayChannel,
    policy: InputPolicy,
    ready: &mut Option<ReadyTx>,
) -> StreamResult<()> {
    run_with_interval(desktop, channel, policy, DEFAULT_FRAME_INTERVAL, ready).await
}

/// [`run`] with an explicit frame interval (tests use a short one).
///
/// # Errors
///
/// Propagates a [`StreamError::Transport`](crate::error::StreamError::Transport)
/// from the relay send/recv so the owner reconnects + resumes, or
/// [`StreamError::Platform`](crate::error::StreamError::Platform) if the FIRST
/// capture never succeeds within the bounded Xvfb-settle retry budget.
pub async fn run_with_interval(
    desktop: &Arc<dyn DesktopBackend>,
    channel: &mut RelayChannel,
    policy: InputPolicy,
    interval: Duration,
    ready: &mut Option<ReadyTx>,
) -> StreamResult<()> {
    // First frame: retry transient capture failures against Xvfb readiness (the X
    // server can still be settling right after `desktop_ensure` probed the display)
    // rather than skipping the frame. Once readiness fires, reconnects resume the
    // steady-state loop directly; a pre-ready transport loss retains the sender.
    if ready.is_some() {
        capture_and_forward_first_frame(desktop, channel).await?;
        // The first real frame is now buffered in the relay ring — signal ready.
        if let Some(ready) = ready.take() {
            let _ = ready.send(());
        }
    }

    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            // Capture tick → ship a framebuffer frame.
            _ = ticker.tick() => {
                match desktop.capture().await {
                    Ok(frame) => {
                        channel.send_frame(bytes::Bytes::from(frame.png)).await?;
                    }
                    Err(e) => {
                        // A transient capture failure (e.g. display reconfigured)
                        // must not kill the stream; log + skip this frame.
                        tracing::debug!(error = %e, "desktop capture skipped this frame");
                    }
                }
            }
            // Inbound: typed computer-use input → inject (consent-gated).
            inbound = channel.recv() => {
                match inbound? {
                    Some(RelayMessage::DesktopInput(input)) => {
                        if policy.allow_input {
                            if let Err(e) = desktop.inject(&input).await {
                                tracing::debug!(error = %e, "desktop input injection failed");
                            }
                        } else {
                            tracing::trace!("dropping desktop input: screen-control not consented");
                        }
                    }
                    Some(RelayMessage::Close(_)) => return Ok(()),
                    None => return Err(StreamError::Transport(
                        "relay closed without a typed StreamClose".to_string(),
                    )),
                    // A raw frame or open/ack on a desktop channel is unexpected;
                    // ignore defensively (desktop input is typed, not opaque bytes).
                    Some(_) => {}
                }
            }
        }
    }
}

/// Captures the FIRST framebuffer frame and forwards it to the relay, retrying a
/// transient `capture()` failure against Xvfb readiness with a small bounded
/// backoff. This is the readiness-barrier path: it does NOT cache a negative result,
/// so a display that settles a beat after the probe still serves. A capture that is
/// still failing after the budget surfaces as a typed [`StreamError::Platform`] (the
/// owner returns it from the mint rather than minting a dead URL); a relay send
/// failure surfaces as a retryable [`StreamError::Transport`].
async fn capture_and_forward_first_frame(
    desktop: &Arc<dyn DesktopBackend>,
    channel: &mut RelayChannel,
) -> StreamResult<()> {
    let mut last_err = None;
    for attempt in 1..=FIRST_CAPTURE_MAX_ATTEMPTS {
        match desktop.capture().await {
            Ok(frame) => {
                channel.send_frame(bytes::Bytes::from(frame.png)).await?;
                return Ok(());
            }
            Err(e) => {
                tracing::debug!(
                    attempt,
                    error = %e,
                    "desktop first-capture failed; retrying against Xvfb readiness"
                );
                last_err = Some(e);
                if attempt < FIRST_CAPTURE_MAX_ATTEMPTS {
                    tokio::time::sleep(FIRST_CAPTURE_RETRY_DELAY).await;
                }
            }
        }
    }
    Err(StreamError::Platform(last_err.unwrap_or_else(|| {
        opengeni_agent_platform::PlatformError::os("desktop first capture produced no frame")
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use opengeni_agent_platform::{CapturedFrame, PlatformResult};
    use opengeni_agent_proto::v1;
    use std::sync::atomic::{AtomicU32, Ordering};

    use crate::channel::{ChannelConfig, RelayChannel};
    use crate::transport::mock::MockTransport;
    use crate::transport::RelayTransport as _;

    /// A fake desktop backend that records inject calls and serves a fixed frame.
    #[derive(Default)]
    struct FakeDesktop {
        captures: AtomicU32,
        injects: std::sync::Mutex<Vec<v1::DesktopInput>>,
    }

    #[async_trait]
    impl DesktopBackend for FakeDesktop {
        fn probe(&self) -> Option<v1::Display> {
            Some(v1::Display {
                id: ":99".to_string(),
                width: 4,
                height: 4,
                r#virtual: true,
            })
        }
        async fn capture(&self) -> PlatformResult<CapturedFrame> {
            self.captures.fetch_add(1, Ordering::SeqCst);
            Ok(CapturedFrame {
                png: b"\x89PNG-fake".to_vec(),
                width: 4,
                height: 4,
            })
        }
        async fn inject(&self, input: &v1::DesktopInput) -> PlatformResult<()> {
            self.injects.lock().unwrap().push(input.clone());
            Ok(())
        }
    }

    fn desktop_channel_config() -> ChannelConfig {
        ChannelConfig::new(
            v1::StreamChannel {
                channel_id: "desk-ch".to_string(),
                workspace_id: "ws".to_string(),
                agent_id: "ag".to_string(),
                kind: v1::StreamKind::Desktop as i32,
                port: 6080,
            },
            "ogs_x".to_string(),
            "wss://relay/stream".to_string(),
        )
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn captures_are_framed_and_consented_input_is_injected() {
        // Hold a concrete handle so the test can read recorded injects directly,
        // and a trait-object handle for the pump.
        let fake = Arc::new(FakeDesktop::default());
        let desktop: Arc<dyn DesktopBackend> = fake.clone();

        let (agent_side, mut relay_side) = MockTransport::pair();
        let mut channel =
            RelayChannel::with_transport(desktop_channel_config(), Box::new(agent_side));

        // The relay side: send one computer-use input, then read a couple frames.
        let relay = tokio::spawn(async move {
            let input = RelayMessage::DesktopInput(v1::DesktopInput {
                channel_id: "desk-ch".to_string(),
                event: Some(v1::desktop_input::Event::Pointer(v1::PointerEvent {
                    x: 1,
                    y: 2,
                    action: v1::PointerAction::Click as i32,
                    button: v1::PointerButton::Left as i32,
                })),
            });
            relay_side.send(&input).await.expect("send input");
            let mut frames = 0;
            for _ in 0..32 {
                if let Ok(Some(RelayMessage::Frame(_))) = relay_side.recv().await {
                    frames += 1;
                    if frames >= 2 {
                        break;
                    }
                }
            }
            frames
        });

        let mut ready = None;
        let pump = run_with_interval(
            &desktop,
            &mut channel,
            InputPolicy { allow_input: true },
            Duration::from_millis(10),
            &mut ready,
        );
        // Bound the pump; we only need a couple frames + the inject to land.
        let _ = tokio::time::timeout(Duration::from_secs(2), pump).await;
        let frames = tokio::time::timeout(Duration::from_secs(2), relay)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or(0);

        assert!(
            frames >= 1,
            "relay should receive at least one framebuffer frame"
        );
        assert!(
            fake.captures.load(Ordering::SeqCst) >= 1,
            "the backend should have been captured at least once"
        );
        // The consented input was injected exactly once, on the right channel.
        let injected = fake.injects.lock().unwrap();
        assert_eq!(injected.len(), 1);
        assert_eq!(injected[0].channel_id, "desk-ch");
    }

    #[tokio::test]
    async fn unconsented_input_is_dropped() {
        // With allow_input=false, an inbound DesktopInput must NOT reach inject.
        let fake = Arc::new(FakeDesktop::default());
        let desktop: Arc<dyn DesktopBackend> = fake.clone();
        let (agent_side, mut relay_side) = MockTransport::pair();
        let mut channel =
            RelayChannel::with_transport(desktop_channel_config(), Box::new(agent_side));

        let relay = tokio::spawn(async move {
            let input = RelayMessage::DesktopInput(v1::DesktopInput {
                channel_id: "desk-ch".to_string(),
                event: Some(v1::desktop_input::Event::Key(v1::KeyEvent {
                    key: "a".to_string(),
                    is_text: true,
                    action: v1::KeyAction::Press as i32,
                })),
            });
            relay_side.send(&input).await.expect("send");
            // Let the pump process it, then close to end the loop.
            tokio::time::sleep(Duration::from_millis(50)).await;
            relay_side
                .send(&RelayMessage::Close(v1::StreamClose {
                    channel_id: "desk-ch".to_string(),
                    reason: v1::StreamCloseReason::Normal as i32,
                    message: String::new(),
                }))
                .await
                .ok();
        });

        let mut ready = None;
        let pump = run_with_interval(
            &desktop,
            &mut channel,
            InputPolicy { allow_input: false },
            Duration::from_secs(1), // long interval: no capture noise
            &mut ready,
        );
        let _ = tokio::time::timeout(Duration::from_secs(2), pump).await;
        let _ = relay.await;

        assert!(
            fake.injects.lock().unwrap().is_empty(),
            "unconsented input must not be injected"
        );
    }

    /// A desktop whose first `fail_first` captures fail transiently (Xvfb still
    /// settling) and succeed thereafter — models the cold-start race the readiness
    /// barrier must absorb.
    struct FlakyDesktop {
        fail_first: u32,
        captures: AtomicU32,
    }

    #[async_trait]
    impl DesktopBackend for FlakyDesktop {
        fn probe(&self) -> Option<v1::Display> {
            Some(v1::Display {
                id: ":99".to_string(),
                width: 4,
                height: 4,
                r#virtual: true,
            })
        }
        async fn capture(&self) -> PlatformResult<CapturedFrame> {
            let n = self.captures.fetch_add(1, Ordering::SeqCst);
            if n < self.fail_first {
                return Err(opengeni_agent_platform::PlatformError::os(
                    "x11 capture: display not ready",
                ));
            }
            Ok(CapturedFrame {
                png: b"\x89PNG-fake".to_vec(),
                width: 4,
                height: 4,
            })
        }
        async fn inject(&self, _input: &v1::DesktopInput) -> PlatformResult<()> {
            Ok(())
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn readiness_fires_only_after_the_first_frame_is_forwarded() {
        // The pump must FORWARD a real frame to the relay BEFORE it fires readiness,
        // so a consumer dialing the minted URL is guaranteed a replayable frame.
        let desktop: Arc<dyn DesktopBackend> = Arc::new(FakeDesktop::default());
        let (agent_side, mut relay_side) = MockTransport::pair();
        let mut channel =
            RelayChannel::with_transport(desktop_channel_config(), Box::new(agent_side));
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let mut ready = Some(ready_tx);

        // The pump borrows locals, so drive it inline (not spawned). A long interval
        // means it never produces a SECOND frame; the relay (unbounded mock) is held
        // by THIS task so the pump always has a live peer. The only thing that
        // resolves the race is the first frame firing readiness.
        let pump = run_with_interval(
            &desktop,
            &mut channel,
            InputPolicy { allow_input: false },
            Duration::from_secs(3600), // no steady-state ticks: isolate the first frame
            &mut ready,
        );
        tokio::select! {
            _ = pump => panic!("the long-interval pump should not return on its own"),
            r = tokio::time::timeout(Duration::from_secs(2), ready_rx) => {
                r.expect("readiness must fire within the budget")
                    .expect("readiness sender must not be dropped");
            }
        }
        // The first frame must be buffered in the relay ring (readiness gates on it).
        assert!(
            matches!(relay_side.recv().await, Ok(Some(RelayMessage::Frame(_)))),
            "the relay must see the first frame"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn first_capture_retries_a_transient_failure_then_serves() {
        // The first two captures fail (Xvfb settling); the pump must retry rather
        // than skip/give-up, then forward the first good frame and fire readiness.
        let flaky = Arc::new(FlakyDesktop {
            fail_first: 2,
            captures: AtomicU32::new(0),
        });
        let desktop: Arc<dyn DesktopBackend> = flaky.clone();
        let (agent_side, mut relay_side) = MockTransport::pair();
        let mut channel =
            RelayChannel::with_transport(desktop_channel_config(), Box::new(agent_side));
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let mut ready = Some(ready_tx);

        let pump = run_with_interval(
            &desktop,
            &mut channel,
            InputPolicy { allow_input: false },
            Duration::from_secs(3600),
            &mut ready,
        );
        tokio::select! {
            _ = pump => panic!("the long-interval pump should not return on its own"),
            r = tokio::time::timeout(Duration::from_secs(3), ready_rx) => {
                r.expect("readiness must fire after the retried capture")
                    .expect("readiness sender must not be dropped");
            }
        }
        assert!(
            matches!(relay_side.recv().await, Ok(Some(RelayMessage::Frame(_)))),
            "after retrying the transient failures the relay must see a frame"
        );
        // Exactly: 2 failed + 1 succeeded = 3 capture attempts.
        assert_eq!(flaky.captures.load(Ordering::SeqCst), 3);
    }

    /// A desktop whose capture always fails — models a display that never settles.
    struct DeadDesktop;

    #[async_trait]
    impl DesktopBackend for DeadDesktop {
        fn probe(&self) -> Option<v1::Display> {
            Some(v1::Display {
                id: ":99".to_string(),
                width: 4,
                height: 4,
                r#virtual: true,
            })
        }
        async fn capture(&self) -> PlatformResult<CapturedFrame> {
            Err(opengeni_agent_platform::PlatformError::os(
                "x11 capture: display gone",
            ))
        }
        async fn inject(&self, _input: &v1::DesktopInput) -> PlatformResult<()> {
            Ok(())
        }
    }

    #[tokio::test(start_paused = true)]
    async fn first_capture_that_never_succeeds_surfaces_a_typed_platform_error() {
        // The retry budget is bounded: a capture that never succeeds must return a
        // typed Platform error (and NOT fire readiness), so the owner fails the mint
        // rather than minting a dead URL. `start_paused` auto-advances virtual time
        // past the bounded retry backoff so the test does not actually sleep ~2s.
        let desktop: Arc<dyn DesktopBackend> = Arc::new(DeadDesktop);
        let (agent_side, _relay_side) = MockTransport::pair();
        let mut channel =
            RelayChannel::with_transport(desktop_channel_config(), Box::new(agent_side));
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let mut ready = Some(ready_tx);

        let err = run_with_interval(
            &desktop,
            &mut channel,
            InputPolicy { allow_input: false },
            Duration::from_secs(3600),
            &mut ready,
        )
        .await
        .expect_err("a never-settling display must error the first-frame barrier");
        assert!(matches!(err, StreamError::Platform(_)), "got {err:?}");
        // Readiness was never fired. The hub retains it only across retryable
        // transport errors; this typed platform error is terminal, so model the
        // hub task ending by dropping the retained sender before observing closure.
        drop(ready);
        assert!(
            ready_rx.await.is_err(),
            "readiness must NOT fire when the first frame never lands"
        );
    }
}
