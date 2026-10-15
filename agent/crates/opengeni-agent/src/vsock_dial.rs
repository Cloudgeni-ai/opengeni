//! Reaching the control plane through the host when the agent runs inside a
//! compute sandbox VM.
//!
//! A sandbox VM has no network path of its own to the control plane. Its host
//! listens for connections the guest opens over vsock and relays them, so the
//! agent dials vsock address 2 (the host) instead of opening TCP connections.
//! Setting [`DIAL_VSOCK_ENV`] to a port turns this on; every NATS connection
//! the agent opens then goes to that port on the host. TLS, when the server
//! URL asks for it, still runs end to end over the vsock stream.

use async_nats::ConnectOptions;

/// Names the host vsock port to dial instead of TCP. Linux only.
pub const DIAL_VSOCK_ENV: &str = "OPENGENI_AGENT_DIAL_VSOCK";

/// The vsock port configured through [`DIAL_VSOCK_ENV`], if any.
///
/// # Errors
///
/// Returns a message when the variable is set but is not a port number.
pub fn configured_port() -> Result<Option<u32>, String> {
    parse_port(std::env::var(DIAL_VSOCK_ENV).ok().as_deref())
}

fn parse_port(value: Option<&str>) -> Result<Option<u32>, String> {
    match value.map(str::trim) {
        None | Some("") => Ok(None),
        Some(text) => text
            .parse::<u32>()
            .map(Some)
            .map_err(|_| format!("{DIAL_VSOCK_ENV} must be a vsock port number, got {text:?}")),
    }
}

/// Makes `options` dial the host's vsock `port` for every server address.
///
/// # Errors
///
/// Returns a message on platforms without vsock.
#[cfg(target_os = "linux")]
pub fn dial_host(options: ConnectOptions, port: u32) -> Result<ConnectOptions, String> {
    use tokio_vsock::{VsockAddr, VsockStream, VMADDR_CID_HOST};

    Ok(options
        // Every address leads to the same host relay; advertised cluster
        // members are not reachable from inside the sandbox.
        .ignore_discovered_servers()
        .custom_dialer(move |_server| async move {
            VsockStream::connect(VsockAddr::new(VMADDR_CID_HOST, port)).await
        }))
}

/// Makes `options` dial the host's vsock `port` for every server address.
///
/// # Errors
///
/// Always: vsock dialing exists only on Linux.
#[cfg(not(target_os = "linux"))]
pub fn dial_host(_options: ConnectOptions, _port: u32) -> Result<ConnectOptions, String> {
    Err(format!("{DIAL_VSOCK_ENV} is only supported on Linux"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ports_parse_strictly() {
        assert_eq!(parse_port(None), Ok(None));
        assert_eq!(parse_port(Some("")), Ok(None));
        assert_eq!(parse_port(Some(" 4222 ")), Ok(Some(4222)));
        assert!(parse_port(Some("nats")).is_err());
        assert!(parse_port(Some("-1")).is_err());
    }
}
