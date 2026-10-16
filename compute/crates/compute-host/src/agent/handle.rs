//! Talking to the agent: handles, leases and the requests they send.

use std::path::Path;
use std::sync::atomic::Ordering;
use std::time::Duration;

use compute_core::{HoldId, Level, Priority, Step};
use compute_engine::vsock;
use tokio::net::UnixStream;
use tokio::sync::oneshot;
use tokio::time::{Instant, sleep};

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
    async fn ask<T>(
        &self,
        make: impl FnOnce(oneshot::Sender<T>) -> Command,
    ) -> Result<T, HostError> {
        let (reply, answer) = oneshot::channel();
        self.commands
            .send(make(reply))
            .map_err(|_| HostError::Stopped)?;
        answer.await.map_err(|_| HostError::Stopped)
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
            generation,
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
        let hold = named_hold(name);
        self.ask(|reply| Command::Hold {
            id,
            generation,
            hold,
            ttl,
            priority,
            reply,
        })
        .await?
    }

    /// Ends a named hold. Ending one that does not exist does nothing. With
    /// a `generation`, only while the sandbox is still at it.
    pub async fn release(
        &self,
        id: Id,
        generation: Option<u64>,
        name: &str,
    ) -> Result<(), HostError> {
        let hold = named_hold(name);
        self.ask(|reply| Command::Unhold {
            id,
            generation,
            hold,
            reply,
        })
        .await?
    }
}

/// The hold id for a hold named through the API. Leases count up from one,
/// so named holds take the upper half of the id space.
fn named_hold(name: &str) -> HoldId {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    name.hash(&mut hasher);
    HoldId(hasher.finish() | 1 << 63)
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

    /// Host side of the sandbox's vsock device.
    #[must_use]
    pub fn vsock(&self) -> &Path {
        &self.vsock
    }

    /// Connects to `port` inside the sandbox. Right after a fresh boot the
    /// guest may not listen yet, so this retries until `timeout`. A lease
    /// asked for a generation connects only to that execution: should the
    /// sandbox have booted afresh meanwhile, the connection is dropped and
    /// [`HostError::Stale`] returned.
    pub async fn connect(&self, port: u32, timeout: Duration) -> Result<UnixStream, HostError> {
        let deadline = Instant::now() + timeout;
        let mut delay = Duration::from_millis(2);
        let stream = loop {
            match vsock::connect(&self.vsock, port).await {
                Ok(stream) => break stream,
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
        };
        // A replacement raises the generation before its VM starts, so a
        // generation unchanged after connecting proves the connection
        // reached the execution the lease was asked for.
        if let Some(generation) = self.generation {
            let (reply, answer) = oneshot::channel();
            self.commands
                .send(Command::Check {
                    id: self.id,
                    generation,
                    reply,
                })
                .map_err(|_| HostError::Stopped)?;
            answer.await.map_err(|_| HostError::Stopped)??;
        }
        Ok(stream)
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
