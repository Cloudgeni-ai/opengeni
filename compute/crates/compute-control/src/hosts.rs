//! Requests to hosts: one mutually authenticated TLS connection per
//! request, one JSON line each way, then, for a connect, the byte stream to
//! the guest port.

use std::sync::Arc;
use std::time::Duration;

use compute_fleet::{AnsweredAt, HostEpoch, Outcome, OwnerEpoch};
use compute_protocol::fleet::{Answer, Envelope, Sent};
use compute_protocol::host::{ErrorCode, Reply, Request};
use rustls::pki_types::ServerName;
use tokio::io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;

use crate::view::Target;

/// How long reaching a host and agreeing TLS with it may take.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

/// The longest answer line a host may send.
const MAX_ANSWER: u64 = 4 << 20;

/// The connection to a host after its answer: a connect's stream to the
/// guest port.
pub type Stream = BufReader<TlsStream<TcpStream>>;

/// Why a request got no answer: it may or may not have reached the host.
#[derive(Debug, thiserror::Error)]
pub enum NoAnswer {
    #[error("reaching {host}: {error}")]
    Unreachable { host: String, error: std::io::Error },
    #[error("{host} did not answer within {after:?}")]
    Timeout { host: String, after: Duration },
    #[error("{host} answered something else: {message}")]
    Garbled { host: String, message: String },
}

/// What a host answered.
#[derive(Debug)]
pub struct Answered {
    pub answer: Answer,
    /// The rest of the connection.
    pub stream: Stream,
}

impl Answered {
    /// When the host answered, as the fleet's rules read it.
    #[must_use]
    pub fn at(&self) -> AnsweredAt {
        AnsweredAt {
            host_epoch: self.answer.answered.host_epoch.map(HostEpoch),
            seq: self.answer.answered.seq,
        }
    }

    /// What the answer means for ownership.
    #[must_use]
    pub fn outcome(&self) -> Outcome {
        outcome(&self.answer.reply)
    }

    /// The error code, if the host refused or failed.
    #[must_use]
    pub fn code(&self) -> Option<ErrorCode> {
        match &self.answer.reply {
            Reply::Error { code, .. } => Some(*code),
            _ => None,
        }
    }
}

/// What `reply` means for ownership.
#[must_use]
pub fn outcome(reply: &Reply) -> Outcome {
    match reply {
        Reply::Done | Reply::Woken { .. } | Reply::Connected { .. } | Reply::Status(_) => {
            Outcome::Done
        }
        Reply::Error { code, .. } => match code {
            ErrorCode::HostFull | ErrorCode::Unavailable | ErrorCode::Expired => Outcome::Refused,
            ErrorCode::NotFound => Outcome::NotFound,
            _ => Outcome::Other,
        },
    }
}

/// Calls hosts with the service's client certificate.
#[derive(Clone)]
pub struct Hosts {
    connector: TlsConnector,
}

impl std::fmt::Debug for Hosts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Hosts")
    }
}

impl Hosts {
    /// Calls hosts with `client`, which proves the service and trusts only
    /// the hosts' authority.
    #[must_use]
    pub fn new(client: rustls::ClientConfig) -> Self {
        Self {
            connector: TlsConnector::from(Arc::new(client)),
        }
    }

    /// Sends `request` to `target`, under the sandbox's `owner_epoch` for a
    /// request about one, and waits up to `wait` for the answer.
    pub async fn call(
        &self,
        target: &Target,
        owner_epoch: Option<OwnerEpoch>,
        request: &Request,
        wait: Duration,
    ) -> Result<Answered, NoAnswer> {
        let host = target.name.clone();
        let unreachable = |error| NoAnswer::Unreachable {
            host: host.clone(),
            error,
        };
        let name = ServerName::try_from(target.name.clone()).map_err(|error| {
            unreachable(std::io::Error::new(std::io::ErrorKind::InvalidInput, error))
        })?;
        let connect = async {
            let tcp = TcpStream::connect(&target.address).await?;
            let _ = tcp.set_nodelay(true);
            self.connector.connect(name, tcp).await
        };
        let tls = tokio::time::timeout(CONNECT_TIMEOUT, connect)
            .await
            .map_err(|_| NoAnswer::Timeout {
                host: host.clone(),
                after: CONNECT_TIMEOUT,
            })?
            .map_err(unreachable)?;
        let envelope = Envelope {
            sent: Sent {
                host_epoch: target.epoch.0,
                stamp: target.seq,
                owner_epoch: owner_epoch.map(|epoch| epoch.0),
            },
            request: request.clone(),
        };
        let mut line = serde_json::to_vec(&envelope).map_err(|error| NoAnswer::Garbled {
            host: host.clone(),
            message: error.to_string(),
        })?;
        line.push(b'\n');
        let mut stream = BufReader::new(tls);
        let exchange = async {
            stream.get_mut().write_all(&line).await?;
            stream.get_mut().flush().await?;
            let mut answer = String::new();
            (&mut stream)
                .take(MAX_ANSWER)
                .read_line(&mut answer)
                .await?;
            Ok::<_, std::io::Error>(answer)
        };
        let answer = tokio::time::timeout(wait, exchange)
            .await
            .map_err(|_| NoAnswer::Timeout {
                host: host.clone(),
                after: wait,
            })?
            .map_err(unreachable)?;
        let answer: Answer = serde_json::from_str(&answer).map_err(|error| NoAnswer::Garbled {
            host: host.clone(),
            message: error.to_string(),
        })?;
        Ok(Answered { answer, stream })
    }
}
