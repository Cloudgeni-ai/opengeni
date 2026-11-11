//! Giving a sandbox its own init (environment, defaults, envd's token, the
//! agent it runs) through its guest's gateway port, as `compute-guest`'s
//! `gateway` module describes. The guest keeps it on the sandbox's disk
//! before it answers, so giving the same init again is harmless.

use std::time::Duration;

use compute_guest::GATEWAY_PORT;
use compute_guest::envd::InitData;
use compute_protocol::host::{Id, PriorityName};
use tokio::io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _};

use crate::service::{Failure, Service};
use crate::store::Store;

/// How long the guest may take to keep an init and pass it on.
pub const INIT_WITHIN: Duration = Duration::from_secs(60);

/// Why an init was not given.
#[derive(Debug, thiserror::Error)]
pub enum InitError {
    /// The sandbox could not be reached.
    #[error(transparent)]
    Reach(#[from] Failure),
    /// The guest did not take it.
    #[error("{0}")]
    Refused(String),
}

/// Gives `team`'s sandbox `id` its init, waking it if it sleeps.
///
/// # Errors
///
/// When it cannot be reached, or its guest does not answer `ok` within
/// [`INIT_WITHIN`].
pub async fn give<S: Store>(
    service: &Service<S>,
    team: &str,
    id: Id,
    init: &InitData,
) -> Result<(), InitError> {
    let reached = service
        .connect(team, id, GATEWAY_PORT, PriorityName::Interactive)
        .await?;
    let mut stream = reached.answered.stream;
    let json = serde_json::to_string(init)
        .map_err(|error| InitError::Refused(format!("encoding the init: {error}")))?;
    let answer = tokio::time::timeout(INIT_WITHIN, async {
        stream
            .get_mut()
            .write_all(format!("init {json}\n").as_bytes())
            .await?;
        stream.get_mut().flush().await?;
        let mut line = String::new();
        (&mut stream).take(1024).read_line(&mut line).await?;
        Ok::<_, std::io::Error>(line)
    })
    .await
    .map_err(|_| InitError::Refused("the guest did not take its init in time".into()))?
    .map_err(|error| InitError::Refused(format!("giving the sandbox its init: {error}")))?;
    match answer.trim_end() {
        "ok" => Ok(()),
        other => Err(InitError::Refused(format!(
            "the sandbox refused its init: {other}"
        ))),
    }
}
