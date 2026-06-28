//! Relay runtime configuration (env / CLI).
//!
//! Every value here is injected by the deploy IaC (dossier §17/§25) — the relay
//! holds NO hardcoded secret or endpoint. The two HMAC secrets are the load-bearing
//! ones: the `ogs_` viewer-token secret (the relay verifies the viewer's stream
//! token) and the `ogr_` producer-token secret (the relay verifies the agent's
//! relay token). They may be the same value when a single stream-token secret backs
//! both planes (the control-plane `resolveRelayTokenSecret` falls back to the
//! stream-token secret), so the relay accepts one OR both.

use clap::Parser;

/// The relay edge configuration.
#[derive(Debug, Clone, Parser)]
#[command(
    name = "opengeni-relay",
    about = "The OpenGeni stateless stream-relay edge (pty/desktop byte-pump)."
)]
pub struct RelayConfig {
    /// The `host:port` the wss listener binds.
    #[arg(long, env = "OPENGENI_RELAY_BIND", default_value = "0.0.0.0:8443")]
    pub bind: String,

    /// The HMAC secret the relay verifies the VIEWER's `ogs_` stream token with
    /// (the control plane's `resolveStreamTokenSecret`). Required for a viewer to
    /// connect; NEVER logged.
    #[arg(long, env = "OPENGENI_STREAM_TOKEN_SECRET", default_value = "")]
    pub stream_token_secret: String,

    /// The HMAC secret the relay verifies the AGENT's `ogr_` producer token with
    /// (the control plane's `resolveRelayTokenSecret`). When empty, falls back to
    /// [`stream_token_secret`](Self::stream_token_secret) (a single secret backing
    /// both planes). NEVER logged.
    #[arg(long, env = "OPENGENI_RELAY_TOKEN_SECRET", default_value = "")]
    pub relay_token_secret: String,

    /// The per-channel-direction replay ring capacity (frames retained for resume).
    #[arg(long, env = "OPENGENI_RELAY_RING_FRAMES", default_value_t = 1024)]
    pub ring_frames: usize,

    /// The in-flight splice buffer bound per direction (frames). The backpressure
    /// point: a slow peer fills this, then the producer's send blocks (never an
    /// unbounded relay buffer).
    #[arg(long, env = "OPENGENI_RELAY_SPLICE_BUFFER", default_value_t = 256)]
    pub splice_buffer: usize,

    /// Per-token leaky-bucket burst capacity (bytes).
    #[arg(long, env = "OPENGENI_RELAY_RATE_BURST_BYTES", default_value_t = 16 * 1024 * 1024)]
    pub rate_burst_bytes: u64,

    /// Per-token leaky-bucket sustained refill (bytes/second).
    #[arg(long, env = "OPENGENI_RELAY_RATE_BYTES_PER_SEC", default_value_t = 8 * 1024 * 1024)]
    pub rate_bytes_per_sec: u64,

    /// How long a half-open channel (one side connected, awaiting its peer) is held
    /// before it is reaped (seconds). Bounds the relay's transient state.
    #[arg(long, env = "OPENGENI_RELAY_PAIR_TIMEOUT_SECS", default_value_t = 120)]
    pub pair_timeout_secs: u64,
}

impl RelayConfig {
    /// The secret the relay verifies the agent's `ogr_` producer token with: the
    /// explicit relay-token secret, else the stream-token secret (a single secret
    /// backing both planes).
    #[must_use]
    pub fn effective_relay_token_secret(&self) -> &str {
        if self.relay_token_secret.is_empty() {
            &self.stream_token_secret
        } else {
            &self.relay_token_secret
        }
    }
}

impl RelayConfig {
    /// A config with both token secrets set to `secret` and small bounds — the seam
    /// the integration/e2e tests (and a local `cargo run` smoke) build a relay from
    /// without parsing env. Not used by the production `main` (which `parse()`s from
    /// env); kept out of `#[cfg(test)]` only because integration tests compile the
    /// crate as an external dependency and cannot see test-gated items.
    #[must_use]
    pub fn for_test(secret: &str) -> Self {
        Self {
            bind: "127.0.0.1:0".to_string(),
            stream_token_secret: secret.to_string(),
            relay_token_secret: secret.to_string(),
            ring_frames: 64,
            splice_buffer: 16,
            rate_burst_bytes: 1024 * 1024,
            rate_bytes_per_sec: 1024 * 1024,
            pair_timeout_secs: 5,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_token_secret_falls_back_to_stream_secret() {
        let mut cfg = RelayConfig::for_test("shared");
        cfg.relay_token_secret = String::new();
        assert_eq!(cfg.effective_relay_token_secret(), "shared");
        cfg.relay_token_secret = "explicit".to_string();
        assert_eq!(cfg.effective_relay_token_secret(), "explicit");
    }
}
