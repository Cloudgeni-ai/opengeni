//! Plain, cause-specific messages for a Codemode request that never got an
//! HTTP answer. reqwest reports every such failure as "error sending request
//! for url (...)" and keeps the reason deep in its source chain. The agent or
//! person reading the native client's output needs that reason (a broken
//! resolver, a wrong clock, a refused connection), not the transport's
//! generic wording. The wording matches the TypeScript client
//! (`packages/codemode/src/connection-failure.ts`).

use std::error::Error as StdError;
use std::io;
use std::time::{SystemTime, UNIX_EPOCH};

use reqwest::Url;
use rustls::CertificateError;

/// The network reason a request got no HTTP answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum NetworkCause {
    /// The resolver could not resolve the host; carries the resolver's text.
    Dns(String),
    CertificateNotYetValid,
    CertificateExpired,
    /// Any other rejected server certificate; carries rustls's reason.
    CertificateRejected(String),
    Refused,
    ConnectTimedOut,
    /// The request went out and no answer came back in time.
    AnswerTimedOut,
    Closed,
    Unreachable,
}

/// Errors nest deeper than this only through a cycle or a pathological wrapper.
const MAX_CHAIN_DEPTH: usize = 16;

/// The first known network reason in `error`'s source chain, looking inside
/// `io::Error` payloads too (their `source()` skips the wrapped error itself).
pub(super) fn network_cause(error: &(dyn StdError + 'static)) -> Option<NetworkCause> {
    chain_cause(error, 0)
}

fn chain_cause(error: &(dyn StdError + 'static), depth: usize) -> Option<NetworkCause> {
    let mut current = Some(error);
    let mut depth = depth;
    while let Some(error) = current {
        if depth > MAX_CHAIN_DEPTH {
            return None;
        }
        if let Some(cause) = classify(error) {
            return Some(cause);
        }
        if let Some(inner) = error
            .downcast_ref::<io::Error>()
            .and_then(io::Error::get_ref)
        {
            if let Some(cause) = chain_cause(inner, depth + 1) {
                return Some(cause);
            }
        }
        current = error.source();
        depth += 1;
    }
    None
}

const DNS_ERROR_TEXT: &str = "dns error";
const LOOKUP_FAILURE_PREFIX: &str = "failed to lookup address information";

fn classify(error: &(dyn StdError + 'static)) -> Option<NetworkCause> {
    if let Some(tls) = error.downcast_ref::<rustls::Error>() {
        return match tls {
            rustls::Error::InvalidCertificate(certificate) => Some(match certificate {
                CertificateError::NotValidYet | CertificateError::NotValidYetContext { .. } => {
                    NetworkCause::CertificateNotYetValid
                }
                CertificateError::Expired | CertificateError::ExpiredContext { .. } => {
                    NetworkCause::CertificateExpired
                }
                other => NetworkCause::CertificateRejected(other.to_string()),
            }),
            _ => None,
        };
    }
    let text = error.to_string();
    // hyper-util's connector names a failed lookup "dns error" and keeps the
    // resolver's own text as its source.
    if text == DNS_ERROR_TEXT || text.starts_with("dns error:") {
        let detail = error
            .source()
            .map(|source| lookup_detail(&source.to_string()))
            .unwrap_or_default();
        return Some(NetworkCause::Dns(detail));
    }
    if text.starts_with(LOOKUP_FAILURE_PREFIX) {
        return Some(NetworkCause::Dns(lookup_detail(&text)));
    }
    let io_error = error.downcast_ref::<io::Error>()?;
    match io_error.kind() {
        io::ErrorKind::ConnectionRefused => Some(NetworkCause::Refused),
        io::ErrorKind::TimedOut => Some(NetworkCause::ConnectTimedOut),
        io::ErrorKind::ConnectionReset
        | io::ErrorKind::ConnectionAborted
        | io::ErrorKind::BrokenPipe
        | io::ErrorKind::UnexpectedEof => Some(NetworkCause::Closed),
        io::ErrorKind::NetworkUnreachable
        | io::ErrorKind::HostUnreachable
        | io::ErrorKind::NetworkDown
        | io::ErrorKind::AddrNotAvailable => Some(NetworkCause::Unreachable),
        _ => None,
    }
}

/// "failed to lookup address information: Name or service not known" ->
/// "Name or service not known".
fn lookup_detail(text: &str) -> String {
    text.strip_prefix(LOOKUP_FAILURE_PREFIX)
        .map(|rest| rest.trim_start_matches(':').trim())
        .unwrap_or(text)
        .to_string()
}

/// One short message naming why a request to `url` got no answer, with what
/// to check; None when the reason is unknown (the caller keeps reqwest's text).
pub(super) fn describe_connection_failure(
    error: &reqwest::Error,
    now: SystemTime,
) -> Option<String> {
    let cause = match network_cause(error) {
        Some(NetworkCause::ConnectTimedOut) if !error.is_connect() => NetworkCause::AnswerTimedOut,
        Some(cause) => cause,
        None if error.is_timeout() && error.is_connect() => NetworkCause::ConnectTimedOut,
        None if error.is_timeout() => NetworkCause::AnswerTimedOut,
        None => return None,
    };
    Some(describe_cause(
        &cause,
        error.url(),
        now,
        cfg!(target_os = "linux"),
    ))
}

pub(super) fn describe_cause(
    cause: &NetworkCause,
    url: Option<&Url>,
    now: SystemTime,
    linux: bool,
) -> String {
    let hostname = url
        .and_then(Url::host_str)
        .unwrap_or("the Opengeni host")
        .to_string();
    let host = match (url.and_then(Url::host_str), url.and_then(Url::port)) {
        (Some(name), Some(port)) => format!("{name}:{port}"),
        _ => hostname.clone(),
    };
    const PREFIX: &str = "Can't reach Opengeni:";
    match cause {
        NetworkCause::Dns(detail) => {
            let detail = if detail.is_empty() {
                String::new()
            } else {
                format!(" ({detail})")
            };
            let hint = if linux {
                "Check /etc/resolv.conf."
            } else {
                "Check this machine's DNS settings."
            };
            format!("{PREFIX} DNS lookup for {hostname} failed{detail}. {hint}")
        }
        NetworkCause::CertificateNotYetValid => format!(
            "{PREFIX} TLS certificate not yet valid. This machine's clock says {}, so it is probably wrong.",
            clock_reading(now)
        ),
        NetworkCause::CertificateExpired => format!(
            "{PREFIX} the TLS certificate for {hostname} has expired by this machine's clock ({}). If that time is wrong, fix the clock; otherwise the server's certificate has expired.",
            clock_reading(now)
        ),
        NetworkCause::CertificateRejected(reason) => format!(
            "{PREFIX} the TLS certificate of {hostname} could not be verified ({reason}). Check this machine's CA certificates and any HTTPS proxy."
        ),
        NetworkCause::Refused => format!(
            "{PREFIX} the connection to {host} was refused. Check this machine's network, firewall and proxy settings."
        ),
        NetworkCause::ConnectTimedOut => format!(
            "{PREFIX} the connection to {host} timed out. Check this machine's network, firewall and proxy settings."
        ),
        NetworkCause::AnswerTimedOut => format!("{PREFIX} {host} did not answer in time."),
        NetworkCause::Closed => format!(
            "{PREFIX} the connection to {host} closed unexpectedly. If it keeps happening, check this machine's network and proxy settings."
        ),
        NetworkCause::Unreachable => format!(
            "{PREFIX} no network route to {host}. Check this machine's network settings."
        ),
    }
}

/// UTC, to the second, so the reader can compare it with the real time.
pub(super) fn clock_reading(now: SystemTime) -> String {
    let Ok(since_epoch) = now.duration_since(UNIX_EPOCH) else {
        return "a time before 1970".to_string();
    };
    let seconds = since_epoch.as_secs();
    let days = (seconds / 86_400) as i64;
    let of_day = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02} UTC",
        of_day / 3600,
        of_day % 3600 / 60,
        of_day % 60
    )
}

/// Days since 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fmt;
    use std::time::Duration;

    /// A wrapper that names its source, the way hyper and reqwest chain errors.
    #[derive(Debug)]
    struct Wrapped {
        text: &'static str,
        source: Box<dyn StdError + Send + Sync + 'static>,
    }

    impl fmt::Display for Wrapped {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str(self.text)
        }
    }

    impl StdError for Wrapped {
        fn source(&self) -> Option<&(dyn StdError + 'static)> {
            Some(self.source.as_ref())
        }
    }

    fn wrapped(text: &'static str, source: impl StdError + Send + Sync + 'static) -> Wrapped {
        Wrapped {
            text,
            source: Box::new(source),
        }
    }

    /// tokio-rustls hands rustls's error to hyper inside an `io::Error`.
    fn tls_failure(error: CertificateError) -> Wrapped {
        wrapped(
            "client error (Connect)",
            io::Error::new(
                io::ErrorKind::InvalidData,
                rustls::Error::InvalidCertificate(error),
            ),
        )
    }

    #[test]
    fn a_certificate_from_the_future_blames_the_clock_with_its_reading() {
        let failure = tls_failure(CertificateError::NotValidYet);
        assert_eq!(
            network_cause(&failure),
            Some(NetworkCause::CertificateNotYetValid)
        );
        let url = Url::parse("https://app.opengeni.ai/codemode/").unwrap();
        let now = UNIX_EPOCH + Duration::from_secs(978_307_200); // 2001-01-01
        assert_eq!(
            describe_cause(&NetworkCause::CertificateNotYetValid, Some(&url), now, true),
            "Can't reach Opengeni: TLS certificate not yet valid. This machine's clock says 2001-01-01 00:00:00 UTC, so it is probably wrong."
        );
    }

    #[test]
    fn an_expired_certificate_names_the_host_and_hedges_the_clock() {
        let failure = tls_failure(CertificateError::Expired);
        assert_eq!(
            network_cause(&failure),
            Some(NetworkCause::CertificateExpired)
        );
        let url = Url::parse("https://app.opengeni.ai/codemode/").unwrap();
        let message = describe_cause(
            &NetworkCause::CertificateExpired,
            Some(&url),
            UNIX_EPOCH + Duration::from_secs(4_102_444_800), // 2100-01-01
            true,
        );
        assert!(message.contains(
            "for app.opengeni.ai has expired by this machine's clock (2100-01-01 00:00:00 UTC)"
        ));
        assert!(message.contains("otherwise the server's certificate has expired"));
    }

    #[test]
    fn another_rejected_certificate_points_at_ca_certificates_and_proxies() {
        let failure = tls_failure(CertificateError::UnknownIssuer);
        let cause = network_cause(&failure).expect("classified");
        assert!(matches!(cause, NetworkCause::CertificateRejected(_)));
        let url = Url::parse("https://app.opengeni.ai/codemode/").unwrap();
        assert!(describe_cause(&cause, Some(&url), SystemTime::now(), true)
            .contains("could not be verified"));
    }

    #[test]
    fn a_failed_lookup_names_the_resolver_text_and_the_platform_hint() {
        let failure = wrapped(
            "client error (Connect)",
            wrapped(
                "dns error",
                io::Error::other(
                    "failed to lookup address information: Temporary failure in name resolution",
                ),
            ),
        );
        let cause = network_cause(&failure).expect("classified");
        assert_eq!(
            cause,
            NetworkCause::Dns("Temporary failure in name resolution".to_string())
        );
        let url = Url::parse("https://app.opengeni.ai/codemode/").unwrap();
        assert_eq!(
            describe_cause(&cause, Some(&url), SystemTime::now(), true),
            "Can't reach Opengeni: DNS lookup for app.opengeni.ai failed (Temporary failure in name resolution). Check /etc/resolv.conf."
        );
        assert!(describe_cause(&cause, Some(&url), SystemTime::now(), false)
            .ends_with("Check this machine's DNS settings."));
    }

    #[test]
    fn socket_errors_map_to_their_reason() {
        for (kind, expected) in [
            (io::ErrorKind::ConnectionRefused, NetworkCause::Refused),
            (io::ErrorKind::TimedOut, NetworkCause::ConnectTimedOut),
            (io::ErrorKind::ConnectionReset, NetworkCause::Closed),
            (io::ErrorKind::NetworkUnreachable, NetworkCause::Unreachable),
        ] {
            let failure = wrapped("client error (Connect)", io::Error::from(kind));
            assert_eq!(network_cause(&failure), Some(expected), "{kind:?}");
        }
    }

    #[test]
    fn an_unknown_reason_is_left_to_the_caller() {
        let failure = wrapped("client error", io::Error::other("something else"));
        assert_eq!(network_cause(&failure), None);
    }

    #[test]
    fn the_clock_reading_is_utc_to_the_second() {
        assert_eq!(clock_reading(UNIX_EPOCH), "1970-01-01 00:00:00 UTC");
        assert_eq!(
            clock_reading(UNIX_EPOCH + Duration::from_secs(1_793_818_245)),
            "2026-11-04 18:50:45 UTC"
        );
        assert_eq!(
            clock_reading(UNIX_EPOCH + Duration::from_secs(951_782_400)),
            "2000-02-29 00:00:00 UTC"
        );
        assert_eq!(
            clock_reading(UNIX_EPOCH - Duration::from_secs(1)),
            "a time before 1970"
        );
    }
}
