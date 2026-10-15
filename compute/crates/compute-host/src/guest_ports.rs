//! Connections a sandbox opens to its host.
//!
//! A guest reaches its host by connecting to vsock address 2 and a port.
//! Firecracker passes each such connection to the Unix socket named like the
//! VM's vsock socket with `_<port>` appended, if something listens there. The
//! host agent listens on those sockets for every sandbox and routes each
//! connection by port.
//!
//! The listeners belong to the sandbox, not to one VM process, so they stay
//! in place while the sandbox sleeps at any level and across restores.

use std::ffi::OsString;
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpStream, UnixListener, UnixStream};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::Instant;

/// How long connecting upstream may take.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Bytes buffered per direction of one connection. Small, because a host
/// keeps one long-lived connection per sandbox and most of them sit idle.
const BUFFER: usize = 8 * 1024;
/// Inbound data wakes the sandbox at most this often per connection.
const REPORT_EVERY: Duration = Duration::from_millis(250);

/// A port the guest may connect to on its host, and where it leads.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GuestPort {
    /// vsock port the guest connects to.
    pub port: u32,
    /// What the host does with each connection.
    pub route: Route,
}

/// What the host does with a connection from the guest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Route {
    /// Relay bytes to a TCP address, such as the control plane's message
    /// server. Traffic alone never keeps a sandbox awake: keepalives and
    /// telemetry flow constantly on such links, so counting them would mean
    /// sandboxes never sleep. Work inside the guest shows as processor use
    /// instead.
    Forward {
        /// `host:port`, resolved for each connection.
        upstream: String,
        /// Wake the sandbox when data arrives from upstream while it sleeps.
        /// Without this, such data waits until something else wakes it.
        wake_on_inbound: bool,
    },
}

/// Parses `PORT=HOST:PORT`, with `,wake` appended to wake on inbound data.
impl FromStr for GuestPort {
    type Err = String;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let (port, rest) = text
            .split_once('=')
            .ok_or_else(|| format!("expected PORT=HOST:PORT[,wake], got {text:?}"))?;
        let port = port
            .parse()
            .map_err(|_| format!("invalid guest port {port:?}"))?;
        let (upstream, wake_on_inbound) = match rest.strip_suffix(",wake") {
            Some(upstream) => (upstream, true),
            None => (rest, false),
        };
        if upstream
            .rsplit_once(':')
            .is_none_or(|(host, port)| host.is_empty() || port.parse::<u16>().is_err())
        {
            return Err(format!("upstream must be HOST:PORT, got {upstream:?}"));
        }
        Ok(Self {
            port,
            route: Route::Forward {
                upstream: upstream.to_owned(),
                wake_on_inbound,
            },
        })
    }
}

impl fmt::Display for GuestPort {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.route {
            Route::Forward {
                upstream,
                wake_on_inbound,
            } => {
                write!(f, "{}={upstream}", self.port)?;
                if *wake_on_inbound {
                    f.write_str(",wake")?;
                }
                Ok(())
            }
        }
    }
}

/// Wakes a sandbox when data arrives for it.
pub(crate) trait Activity: Clone + Send + Sync + 'static {
    /// Data arrived for the guest on a port that wakes it: wake the sandbox
    /// if it sleeps, and count that as activity.
    fn wake(&self);
}

/// The listeners of one sandbox. Dropping it closes them, ends their
/// connections and removes their sockets.
#[derive(Debug)]
pub(crate) struct Listeners {
    tasks: Vec<JoinHandle<()>>,
    sockets: Vec<PathBuf>,
}

impl Drop for Listeners {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
        for socket in &self.sockets {
            let _ = std::fs::remove_file(socket);
        }
    }
}

/// Host-side socket for guest connections to `port`.
#[must_use]
pub fn socket_path(vsock: &Path, port: u32) -> PathBuf {
    let mut name = OsString::from(vsock.as_os_str());
    name.push(format!("_{port}"));
    PathBuf::from(name)
}

/// Starts listening for guest connections to each of `ports`. Must run
/// inside a Tokio runtime.
pub(crate) fn listen<A: Activity>(
    vsock: &Path,
    owner: (u32, u32),
    ports: &Arc<[GuestPort]>,
    activity: &A,
) -> io::Result<Listeners> {
    let mut listeners = Listeners {
        tasks: Vec::with_capacity(ports.len()),
        sockets: Vec::with_capacity(ports.len()),
    };
    if ports.is_empty() {
        return Ok(listeners);
    }
    if let Some(dir) = vsock.parent() {
        std::fs::create_dir_all(dir)?;
    }
    for (index, guest_port) in ports.iter().enumerate() {
        let socket = socket_path(vsock, guest_port.port);
        match std::fs::remove_file(&socket) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let listener = std::os::unix::net::UnixListener::bind(&socket)?;
        give_to(&socket, owner)?;
        listeners.sockets.push(socket);
        listener.set_nonblocking(true)?;
        let listener = UnixListener::from_std(listener)?;
        listeners.tasks.push(tokio::spawn(accept(
            listener,
            Arc::clone(ports),
            index,
            activity.clone(),
        )));
    }
    Ok(listeners)
}

/// Hands a listener's socket to the sandbox's own user, the only one its
/// jailed VMM runs as, so the VMM may connect to it. An agent that is not
/// root runs VMMs as itself and has nothing to hand over.
fn give_to(socket: &Path, (uid, gid): (u32, u32)) -> io::Result<()> {
    match std::os::unix::fs::chown(socket, Some(uid), Some(gid)) {
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => Ok(()),
        result => result,
    }
}

async fn accept<A: Activity>(
    listener: UnixListener,
    ports: Arc<[GuestPort]>,
    index: usize,
    activity: A,
) {
    let guest_port = &ports[index];
    // Connections end with the listener: aborting this task drops the set.
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    let route = guest_port.route.clone();
                    let activity = activity.clone();
                    let port = guest_port.port;
                    connections.spawn(async move {
                        if let Err(error) = handle(stream, &route, &activity).await {
                            tracing::debug!(port, %error, "guest connection ended with an error");
                        }
                    });
                }
                Err(error) => {
                    tracing::warn!(port = guest_port.port, %error, "accepting a guest connection failed");
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            },
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
}

async fn handle<A: Activity>(guest: UnixStream, route: &Route, activity: &A) -> io::Result<()> {
    match route {
        Route::Forward {
            upstream,
            wake_on_inbound,
        } => forward(guest, upstream, *wake_on_inbound, activity).await,
    }
}

async fn forward<A: Activity>(
    guest: UnixStream,
    upstream: &str,
    wake_on_inbound: bool,
    activity: &A,
) -> io::Result<()> {
    let upstream = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(upstream))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "connecting upstream timed out"))??;
    upstream.set_nodelay(true)?;
    let (mut guest_read, mut guest_write) = guest.into_split();
    let (mut upstream_read, mut upstream_write) = upstream.into_split();
    // The guest only sends while it runs, so its traffic never needs a wake.
    let outbound = pump(&mut guest_read, &mut upstream_write, || {});
    let inbound = pump(&mut upstream_read, &mut guest_write, || {
        if wake_on_inbound {
            activity.wake();
        }
    });
    tokio::try_join!(outbound, inbound)?;
    Ok(())
}

/// Copies until `from` ends, then closes the writing side of `to`.
/// `on_data` runs before forwarding data, at most once per [`REPORT_EVERY`].
async fn pump<R, W>(from: &mut R, to: &mut W, on_data: impl Fn()) -> io::Result<u64>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buffer = vec![0; BUFFER].into_boxed_slice();
    let mut total = 0_u64;
    let mut reported: Option<Instant> = None;
    loop {
        let read = from.read(&mut buffer).await?;
        if read == 0 {
            to.shutdown().await?;
            return Ok(total);
        }
        let now = Instant::now();
        if reported.is_none_or(|at| now.duration_since(at) >= REPORT_EVERY) {
            on_data();
            reported = Some(now);
        }
        to.write_all(&buffer[..read]).await?;
        total += read as u64;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use tokio::net::TcpListener;

    use super::*;

    #[derive(Clone, Default)]
    struct Recorder(Arc<Mutex<usize>>);

    impl Activity for Recorder {
        fn wake(&self) {
            *self.0.lock().unwrap() += 1;
        }
    }

    #[test]
    fn parses_and_prints_routes() {
        let port: GuestPort = "4222=127.0.0.1:4222,wake".parse().unwrap();
        assert_eq!(
            port,
            GuestPort {
                port: 4222,
                route: Route::Forward {
                    upstream: "127.0.0.1:4222".into(),
                    wake_on_inbound: true
                }
            }
        );
        assert_eq!(port.to_string(), "4222=127.0.0.1:4222,wake");
        let port: GuestPort = "80=example.com:443".parse().unwrap();
        assert_eq!(port.to_string(), "80=example.com:443");
        assert!("4222".parse::<GuestPort>().is_err());
        assert!("x=a:1".parse::<GuestPort>().is_err());
        assert!("1=a".parse::<GuestPort>().is_err());
        assert!("1=:1".parse::<GuestPort>().is_err());
    }

    #[test]
    fn socket_names_follow_firecracker() {
        assert_eq!(
            socket_path(Path::new("/x/run/vsock.sock"), 4222),
            PathBuf::from("/x/run/vsock.sock_4222")
        );
    }

    #[tokio::test]
    async fn forwards_both_ways_and_wakes_on_inbound_data() {
        let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = upstream.local_addr().unwrap();
        let echo = tokio::spawn(async move {
            let (mut stream, _) = upstream.accept().await.unwrap();
            let mut line = [0; 5];
            stream.read_exact(&mut line).await.unwrap();
            stream.write_all(b"pong\n").await.unwrap();
            stream.shutdown().await.unwrap();
            line
        });

        let dir = std::env::temp_dir().join(format!("guest-ports-{}", std::process::id()));
        let vsock = dir.join("run").join("vsock.sock");
        let ports: Arc<[GuestPort]> = vec![format!("4222={address},wake").parse().unwrap()].into();
        let recorder = Recorder::default();
        let listeners = listen(&vsock, (0, 0), &ports, &recorder).unwrap();

        let mut guest = UnixStream::connect(socket_path(&vsock, 4222))
            .await
            .unwrap();
        guest.write_all(b"ping\n").await.unwrap();
        let mut reply = String::new();
        guest.read_to_string(&mut reply).await.unwrap();
        assert_eq!(reply, "pong\n");
        assert_eq!(&echo.await.unwrap(), b"ping\n");

        assert_eq!(*recorder.0.lock().unwrap(), 1, "one wake for the reply");

        drop(listeners);
        assert!(!socket_path(&vsock, 4222).exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn inbound_data_does_not_wake_unless_asked() {
        let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = upstream.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = upstream.accept().await.unwrap();
            stream.write_all(b"hello").await.unwrap();
        });
        let dir = std::env::temp_dir().join(format!("guest-ports-quiet-{}", std::process::id()));
        let vsock = dir.join("vsock.sock");
        let ports: Arc<[GuestPort]> = vec![format!("7={address}").parse().unwrap()].into();
        let recorder = Recorder::default();
        let _listeners = listen(&vsock, (0, 0), &ports, &recorder).unwrap();
        let mut guest = UnixStream::connect(socket_path(&vsock, 7)).await.unwrap();
        let mut reply = String::new();
        guest.read_to_string(&mut reply).await.unwrap();
        assert_eq!(reply, "hello");
        assert!(
            *recorder.0.lock().unwrap() == 0,
            "inbound data must not wake without wake_on_inbound"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
