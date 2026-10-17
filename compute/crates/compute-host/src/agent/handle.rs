//! Talking to the agent: handles, leases and the requests they send.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use compute_core::{HoldId, Level, OpId, Priority, Step};
use compute_engine::vsock;
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{Instant, sleep};

use crate::observe::{Observer, TraceContext};
use crate::protocol::{HostStatus, Id, SandboxConfig};

use super::{Command, Handle, HostError, Lease, ReleaseOnDrop};

impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.commands.send(Command::Release {
                id: self.id,
                hold: self.hold,
            });
        }
    }
}

impl Handle {
    pub(super) fn new(
        commands: mpsc::UnboundedSender<Command>,
        stream_idle: Duration,
        observer: Observer,
    ) -> Self {
        Self {
            commands,
            holds: Arc::new(AtomicU64::new(1)),
            stream_idle,
            observer,
            trace: None,
        }
    }

    async fn ask<T>(
        &self,
        make: impl FnOnce(oneshot::Sender<T>) -> Command,
    ) -> Result<T, HostError> {
        let (reply, answer) = oneshot::channel();
        let command = match self.trace {
            Some(trace) => Command::Traced(trace, Box::new(make(reply))),
            None => make(reply),
        };
        self.commands
            .send(command)
            .map_err(|_| HostError::Stopped)?;
        answer.await.map_err(|_| HostError::Stopped)
    }

    /// The same handle, its requests carrying `trace`: the steps they
    /// cause name the caller's trace on their events.
    #[must_use]
    pub fn traced(&self, trace: Option<TraceContext>) -> Self {
        Self {
            trace,
            ..self.clone()
        }
    }

    /// Where the host's events and metrics go.
    #[must_use]
    pub fn observer(&self) -> &Observer {
        &self.observer
    }

    /// Creates a sandbox. It costs only disk until first needed.
    pub async fn create(&self, id: Id, config: SandboxConfig) -> Result<(), HostError> {
        self.ask(|reply| Command::Create { id, config, reply })
            .await?
    }

    /// Deletes a sandbox and everything it stores, waiting until it is gone.
    /// With a `generation`, only while the sandbox is still at it.
    pub async fn remove(&self, id: Id, generation: Option<u64>) -> Result<(), HostError> {
        self.ask(|reply| Command::Remove {
            id,
            generation,
            reply,
        })
        .await?
    }

    /// Starts waking a sandbox without waiting, for example when a turn
    /// starts and a command will probably follow. With a `generation`,
    /// only while the sandbox is still at it. Returns once the request is
    /// accepted, not once the sandbox runs.
    pub async fn touch(
        &self,
        id: Id,
        generation: Option<u64>,
        priority: Priority,
    ) -> Result<(), HostError> {
        self.ask(|reply| Command::Touch {
            id,
            generation,
            priority,
            reply: Some(reply),
        })
        .await?
    }

    /// How long a stream may stay silent and still keep its sandbox awake
    /// (see [`super::HostConfig::stream_idle`]).
    #[must_use]
    pub fn stream_idle(&self) -> Duration {
        self.stream_idle
    }

    /// Wakes a sandbox and keeps it awake until the lease is dropped.
    /// Dropping the returned future early releases the sandbox too. With a
    /// `generation`, only while the sandbox is still at it, so a caller
    /// that relies on programs it started can tell they are gone.
    pub async fn acquire(
        &self,
        id: Id,
        generation: Option<u64>,
        priority: Priority,
    ) -> Result<Lease, HostError> {
        let hold = HoldId(self.holds.fetch_add(1, Ordering::Relaxed));
        let started = Instant::now();
        let mut guard = ReleaseOnDrop {
            id,
            hold,
            commands: self.commands.clone(),
            armed: true,
        };
        let woke = self
            .ask(|reply| Command::Acquire {
                id,
                generation,
                hold,
                priority,
                reply,
            })
            .await??;
        guard.armed = false;
        Ok(Lease {
            id,
            hold,
            vsock: woke.vsock,
            waited: started.elapsed(),
            during: woke.during,
            op: woke.op,
            generation: woke.generation,
            pinned: generation.is_some(),
            commands: self.commands.clone(),
        })
    }

    /// Every sandbox and the host's counters.
    pub async fn status(&self) -> Result<HostStatus, HostError> {
        self.ask(|reply| Command::Status { reply }).await
    }

    /// Puts a sandbox at least as deep as `level` now, whatever its sleep
    /// settings say. Returns once the request is accepted, not once the
    /// sandbox is there; a later wake cancels it. With a `generation`, only
    /// while the sandbox is still at it.
    pub async fn sleep(
        &self,
        id: Id,
        generation: Option<u64>,
        level: Level,
    ) -> Result<(), HostError> {
        self.ask(|reply| Command::Sleep {
            id,
            generation,
            level,
            reply,
        })
        .await?
    }

    /// Keeps a sandbox awake for a named reason, such as an agent turn in
    /// progress, waking it if it sleeps. Holding again under the same name
    /// refreshes the hold; with a `ttl` it lapses on its own unless
    /// refreshed, so a caller that dies cannot keep a sandbox awake forever.
    /// With a `generation`, only while the sandbox is still at it.
    pub async fn hold(
        &self,
        id: Id,
        generation: Option<u64>,
        name: &str,
        ttl: Option<Duration>,
        priority: Priority,
    ) -> Result<(), HostError> {
        self.hold_renewing(id, generation, name, ttl, priority)
            .await
            .map(|_| ())
    }

    /// Like [`Self::hold`], telling whether the hold was already there.
    pub(crate) async fn hold_renewing(
        &self,
        id: Id,
        generation: Option<u64>,
        name: &str,
        ttl: Option<Duration>,
        priority: Priority,
    ) -> Result<bool, HostError> {
        self.ask(|reply| Command::Hold {
            id,
            generation,
            name: name.to_owned(),
            ttl,
            priority,
            reply,
        })
        .await?
    }

    /// One sandbox's level and the step under way, if the host has it.
    pub(crate) async fn inspect(&self, id: Id) -> Result<Option<(Level, Option<Step>)>, HostError> {
        self.ask(|reply| Command::Inspect { id, reply }).await
    }

    /// Ends a named hold. Ending one that does not exist does nothing. With
    /// a `generation`, only while the sandbox is still at it.
    pub async fn release(
        &self,
        id: Id,
        generation: Option<u64>,
        name: &str,
    ) -> Result<(), HostError> {
        self.ask(|reply| Command::Unhold {
            id,
            generation,
            name: name.to_owned(),
            reply,
        })
        .await?
    }
}

impl Lease {
    /// How long waking took.
    #[must_use]
    pub fn waited(&self) -> Duration {
        self.waited
    }

    /// The step under way when the wake arrived, if any: a wake during a
    /// sleep step cancels it or waits for it to finish.
    #[must_use]
    pub fn during(&self) -> Option<Step> {
        self.during
    }

    /// The wake step the request waited for, if one ran: its events carry
    /// the same operation id.
    #[must_use]
    pub fn op(&self) -> Option<OpId> {
        self.op
    }

    /// The execution the lease reaches. It changes only when the sandbox
    /// boots afresh, which ends whatever programs ran in it; a caller that
    /// started some can pass it to later requests to make sure they reach
    /// the same ones.
    #[must_use]
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Host side of the sandbox's vsock device.
    #[must_use]
    pub fn vsock(&self) -> &Path {
        &self.vsock
    }

    /// Connects to `port` inside the sandbox. Right after a fresh boot the
    /// guest may not listen yet, so this retries until `timeout`. Should the
    /// sandbox boot afresh meanwhile, a lease asked for a generation drops
    /// the connection and returns [`HostError::Stale`]; any other follows
    /// the sandbox to its new execution. Either way, once this succeeds,
    /// [`Lease::generation`] names the execution the stream reached.
    pub async fn connect(&mut self, port: u32, timeout: Duration) -> Result<UnixStream, HostError> {
        let deadline = Instant::now() + timeout;
        loop {
            let stream = self.reach(port, deadline).await?;
            // A replacement raises the generation before its VM starts, so
            // a generation unchanged after connecting proves the connection
            // reached the lease's execution.
            let (reply, answer) = oneshot::channel();
            self.commands
                .send(Command::Check {
                    id: self.id,
                    generation: self.generation,
                    reply,
                })
                .map_err(|_| HostError::Stopped)?;
            match answer.await.map_err(|_| HostError::Stopped)? {
                Ok(()) => return Ok(stream),
                Err(HostError::Stale { found, .. })
                    if !self.pinned && Instant::now() < deadline =>
                {
                    self.generation = found;
                }
                Err(error) => return Err(error),
            }
        }
    }

    /// A connection to `port` in whichever VM the sandbox has, retried
    /// until `deadline`.
    async fn reach(&self, port: u32, deadline: Instant) -> Result<UnixStream, HostError> {
        let mut delay = Duration::from_millis(2);
        loop {
            match vsock::connect(&self.vsock, port).await {
                Ok(stream) => return Ok(stream),
                Err(error) if Instant::now() + delay >= deadline => {
                    return Err(HostError::Unreachable {
                        port,
                        message: error.to_string(),
                    });
                }
                Err(_) => {
                    sleep(delay).await;
                    delay = (delay * 2).min(Duration::from_millis(50));
                }
            }
        }
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Release {
            id: self.id,
            hold: self.hold,
        });
    }
}
