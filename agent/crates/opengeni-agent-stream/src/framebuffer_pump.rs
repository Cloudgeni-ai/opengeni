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
use crate::error::StreamResult;

/// The default desktop frame interval (~10 fps). A real codec / damage-tracking
/// upgrade is a pump change, not a protocol change (dossier §10.5). Kept modest so
/// a PNG-per-frame stream does not saturate the relay; M12 tunes it live.
const DEFAULT_FRAME_INTERVAL: Duration = Duration::from_millis(100);

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
/// # Errors
///
/// Propagates a [`StreamError::Transport`](crate::error::StreamError::Transport)
/// from the relay so the owner reconnects + resumes.
pub async fn run(
    desktop: &Arc<dyn DesktopBackend>,
    channel: &mut RelayChannel,
    policy: InputPolicy,
) -> StreamResult<()> {
    run_with_interval(desktop, channel, policy, DEFAULT_FRAME_INTERVAL).await
}

/// [`run`] with an explicit frame interval (tests use a short one).
///
/// # Errors
///
/// Propagates a [`StreamError::Transport`](crate::error::StreamError::Transport)
/// from the relay send/recv so the owner reconnects + resumes.
pub async fn run_with_interval(
    desktop: &Arc<dyn DesktopBackend>,
    channel: &mut RelayChannel,
    policy: InputPolicy,
    interval: Duration,
) -> StreamResult<()> {
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
                    Some(RelayMessage::Close(_)) | None => return Ok(()),
                    // A raw frame or open/ack on a desktop channel is unexpected;
                    // ignore defensively (desktop input is typed, not opaque bytes).
                    Some(_) => {}
                }
            }
        }
    }
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
        ChannelConfig {
            channel: v1::StreamChannel {
                channel_id: "desk-ch".to_string(),
                workspace_id: "ws".to_string(),
                agent_id: "ag".to_string(),
                kind: v1::StreamKind::Desktop as i32,
                port: 6080,
            },
            token: "ogs_x".to_string(),
            relay_url: "wss://relay/stream".to_string(),
        }
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

        let pump = run_with_interval(
            &desktop,
            &mut channel,
            InputPolicy { allow_input: true },
            Duration::from_millis(10),
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

        let pump = run_with_interval(
            &desktop,
            &mut channel,
            InputPolicy { allow_input: false },
            Duration::from_secs(1), // long interval: no capture noise
        );
        let _ = tokio::time::timeout(Duration::from_secs(2), pump).await;
        let _ = relay.await;

        assert!(
            fake.injects.lock().unwrap().is_empty(),
            "unconsented input must not be injected"
        );
    }
}
