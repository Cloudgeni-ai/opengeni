//! How long the network may hold up the store's connections.
//!
//! Without bounds, a connection attempt the network drops waits for the
//! system's own limit, about two minutes, and so does every read queued
//! behind it, the host reads placement depends on included; a connection
//! whose path went away retries for about fifteen minutes; and a cloud NAT
//! gateway forgets a pooled connection left idle for a few minutes without
//! telling either end.

use std::time::Duration;

/// How long reaching the database may take, for each of its addresses.
const CONNECT_WITHIN: Duration = Duration::from_secs(5);
/// How long opening a pooled connection may take in all: reaching the
/// database, TLS and signing in, which a peer that accepts and then says
/// nothing would otherwise hold up for good.
pub(super) const OPEN_WITHIN: Duration = Duration::from_secs(10);
/// How long data sent on a connection may go unacknowledged before the
/// connection counts as broken, where the system supports it (Linux): a
/// leader's connection included.
const UNACKNOWLEDGED_WITHIN: Duration = Duration::from_secs(15);
/// After this long without traffic a connection is probed, every
/// [`KEEPALIVE_EVERY`], and counts as broken once [`KEEPALIVE_PROBES`] go
/// unanswered. On Linux [`UNACKNOWLEDGED_WITHIN`] replaces that count: the
/// connection counts as broken at the first probe after it has gone
/// unanswered that long, about 70 s for an idle connection whose path went
/// away. Well under the idle limit of cloud NAT gateways and load
/// balancers (four minutes on some); the library's own default is two
/// hours.
const KEEPALIVE_AFTER: Duration = Duration::from_secs(60);
const KEEPALIVE_EVERY: Duration = Duration::from_secs(10);
const KEEPALIVE_PROBES: u32 = 3;
/// The keepalive idle time a connection string that names none gets, which
/// counts as unset.
const LIBRARY_KEEPALIVE_AFTER: Duration = Duration::from_secs(2 * 60 * 60);

/// `config` with the network bounds above wherever it sets none. The
/// connections are always bounded: a connection string can choose other
/// values (`connect_timeout`, `tcp_user_timeout`, `keepalives_idle`,
/// `keepalives_interval`, `keepalives_retries`), but not none at all. A
/// zero for one of the four durations, which the library reads as unset,
/// and a keepalive idle time of exactly the library's two hours both get
/// the bound. `keepalives_retries=0` is kept as given, and `keepalives=0`
/// still turns keepalives off.
pub(super) fn bounded(mut config: tokio_postgres::Config) -> tokio_postgres::Config {
    if config.get_connect_timeout().is_none() {
        config.connect_timeout(CONNECT_WITHIN);
    }
    if config.get_tcp_user_timeout().is_none() {
        config.tcp_user_timeout(UNACKNOWLEDGED_WITHIN);
    }
    if config.get_keepalives_idle() == LIBRARY_KEEPALIVE_AFTER {
        config.keepalives_idle(KEEPALIVE_AFTER);
    }
    if config.get_keepalives_interval().is_none() {
        config.keepalives_interval(KEEPALIVE_EVERY);
    }
    if config.get_keepalives_retries().is_none() {
        config.keepalives_retries(KEEPALIVE_PROBES);
    }
    config
}

#[cfg(test)]
mod tests {
    use std::str::FromStr as _;
    use std::time::{Duration, Instant};

    use super::super::PostgresStore;
    use super::{
        CONNECT_WITHIN, KEEPALIVE_AFTER, KEEPALIVE_EVERY, KEEPALIVE_PROBES, UNACKNOWLEDGED_WITHIN,
        bounded,
    };

    #[test]
    fn a_connection_string_that_names_no_bounds_gets_them() {
        let config =
            bounded(tokio_postgres::Config::from_str("postgres://db.example/fleet").unwrap());
        assert_eq!(config.get_connect_timeout(), Some(&CONNECT_WITHIN));
        assert_eq!(config.get_tcp_user_timeout(), Some(&UNACKNOWLEDGED_WITHIN));
        assert!(config.get_keepalives());
        assert_eq!(config.get_keepalives_idle(), KEEPALIVE_AFTER);
        assert_eq!(config.get_keepalives_interval(), Some(KEEPALIVE_EVERY));
        assert_eq!(config.get_keepalives_retries(), Some(KEEPALIVE_PROBES));
    }

    #[test]
    fn bounds_a_connection_string_names_are_kept() {
        let config = bounded(
            tokio_postgres::Config::from_str(
                "host=db.example dbname=fleet connect_timeout=2 tcp_user_timeout=30 \
                 keepalives=0 keepalives_idle=20 keepalives_interval=4 keepalives_retries=7",
            )
            .unwrap(),
        );
        assert_eq!(config.get_connect_timeout(), Some(&Duration::from_secs(2)));
        assert_eq!(
            config.get_tcp_user_timeout(),
            Some(&Duration::from_secs(30))
        );
        assert!(!config.get_keepalives());
        assert_eq!(config.get_keepalives_idle(), Duration::from_secs(20));
        assert_eq!(
            config.get_keepalives_interval(),
            Some(Duration::from_secs(4))
        );
        assert_eq!(config.get_keepalives_retries(), Some(7));
    }

    /// Connections are always bounded: a zero, which the library reads as
    /// unset, and the library's own two-hour idle time get the bounds.
    #[test]
    fn a_connection_string_cannot_turn_the_bounds_off() {
        let config = bounded(
            tokio_postgres::Config::from_str(
                "host=db.example dbname=fleet connect_timeout=0 tcp_user_timeout=0 \
                 keepalives_idle=7200",
            )
            .unwrap(),
        );
        assert_eq!(config.get_connect_timeout(), Some(&CONNECT_WITHIN));
        assert_eq!(config.get_tcp_user_timeout(), Some(&UNACKNOWLEDGED_WITHIN));
        assert_eq!(config.get_keepalives_idle(), KEEPALIVE_AFTER);
    }

    /// A database that accepts connections and then says nothing, as a
    /// path that drops everything after the handshake does: a request
    /// fails once the connection's opening time is up, instead of waiting
    /// for good.
    #[tokio::test]
    async fn a_database_that_never_answers_fails_a_request_in_bounded_time() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let silent = tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((socket, _)) = listener.accept().await {
                held.push(socket);
            }
        });
        let mut config = tokio_postgres::Config::new();
        config
            .host("127.0.0.1")
            .port(port)
            .user("fleet")
            .dbname("fleet");
        let open_within = Duration::from_millis(300);
        let store = PostgresStore::pooled(config, None, 2, open_within).unwrap();
        let begun = Instant::now();
        let failed = tokio::time::timeout(Duration::from_secs(10), store.client())
            .await
            .expect("bounded by the opening time, not by the test")
            .is_err();
        assert!(failed, "nothing answered, so no connection opened");
        let took = begun.elapsed();
        assert!(
            took >= open_within && took < Duration::from_secs(5),
            "failed after {took:?}"
        );
        silent.abort();
    }
}
