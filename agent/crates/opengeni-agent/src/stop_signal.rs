//! Linux: a stop signal one of the agent's own commands sent does not stop
//! the agent.
//!
//! A command runs as the agent's user, so `kill -1` in a command (every
//! process the user may signal), or a group or name match that also hits the
//! agent, used to send the agent a stop signal like any other. The agent then
//! went offline, and a foreground agent's keeper stopped it for good. The
//! command itself still receives every signal and nothing is blocked; the agent
//! only declines to stop for a signal its own command sent (see
//! [`opengeni_agent_platform::signal_sender`]). Its service manager, keeper,
//! the desktop app, a person's terminal or `opengeni-agent stop` still stop it.
//!
//! A sender that exited before it could be placed counts as the agent's
//! command while a command runs or ended within [`GONE_SENDER_WINDOW`]: a
//! short-lived `kill` from a command usually is gone by then. Outside that
//! window it stops the agent, as before.

use std::time::Duration;

use nix::sys::signal::Signal;
use opengeni_agent_platform::command_activity;
use opengeni_agent_platform::signal_sender::{self, Sender, SignalDelivery};
use tracing::warn;

/// The stop signals the agent handles itself.
const STOP_SIGNALS: [Signal; 2] = [Signal::SIGTERM, Signal::SIGINT];

/// How long after its last command ended a stop signal from a sender that is
/// already gone still counts as that command's.
pub(crate) const GONE_SENDER_WINDOW: Duration = Duration::from_secs(5);

/// Whether `delivery` came from one of the commands `agent` runs.
fn sent_by_own_command(delivery: SignalDelivery, agent: i32) -> bool {
    match signal_sender::place(delivery.sender, agent) {
        Sender::Command => true,
        Sender::Gone(_) => command_activity::commands_ran_within(GONE_SENDER_WINDOW),
        Sender::Outside(_) => false,
    }
}

/// Logs that a stop signal from a command was not obeyed.
fn log_ignored(delivery: SignalDelivery, who: &str) {
    let signal = Signal::try_from(delivery.signal).map_or_else(
        |_| delivery.signal.to_string(),
        |signal| signal.as_str().to_string(),
    );
    warn!(
        signal,
        sender = delivery.sender,
        "{who} keeps running: one of the agent's own commands sent this stop signal (for example `kill -1`, which signals every process of the user). Stop the agent with its service manager, `opengeni-agent stop`, Ctrl-C or `kill` from a shell outside its commands."
    );
}

/// Resolves once a stop signal arrives from anything but one of this agent's
/// commands. `Err` when the signals cannot be relayed; the caller then waits
/// for them as before.
pub(crate) async fn wait() -> std::io::Result<()> {
    let mut relay = signal_sender::relay_signals(&STOP_SIGNALS.map(|signal| signal as i32))?;
    let agent = i32::try_from(std::process::id()).map_err(std::io::Error::other)?;
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    std::thread::Builder::new()
        .name("stop-signals".to_string())
        .spawn(move || loop {
            match relay.recv() {
                Ok(delivery) if sent_by_own_command(delivery, agent) => {
                    log_ignored(delivery, "the agent");
                }
                // Any other sender, or a broken relay: stop, as without it.
                Ok(_) | Err(_) => {
                    let _ = stop.send(());
                    return;
                }
            }
        })?;
    let _ = stopped.await;
    Ok(())
}
