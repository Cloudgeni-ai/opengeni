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
    /// The certificate is valid but issued for another name.
    CertificateWrongName,
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
                CertificateError::NotValidForName
                | CertificateError::NotValidForNameContext { .. } => {
                    NetworkCause::CertificateWrongName
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
    if is_unreachable(io_error) {
        return Some(NetworkCause::Unreachable);
    }
    match io_error.kind() {
        io::ErrorKind::ConnectionRefused => Some(NetworkCause::Refused),
        io::ErrorKind::TimedOut => Some(NetworkCause::ConnectTimedOut),
        io::ErrorKind::ConnectionReset
        | io::ErrorKind::ConnectionAborted
        | io::ErrorKind::BrokenPipe
        | io::ErrorKind::UnexpectedEof => Some(NetworkCause::Closed),
        _ => None,
    }
}

/// No route to the network or host. Matched by OS error code because the
/// matching `io::ErrorKind`s need Rust 1.83 and the workspace supports 1.82.
fn is_unreachable(error: &io::Error) -> bool {
    let Some(code) = error.raw_os_error() else {
        return false;
    };
    #[cfg(unix)]
    {
        use nix::errno::Errno;
        [Errno::ENETUNREACH, Errno::EHOSTUNREACH, Errno::ENETDOWN]
            .into_iter()
            .any(|errno| errno as i32 == code)
    }
    #[cfg(windows)]
    {
        // WSAENETDOWN, WSAENETUNREACH, WSAEHOSTUNREACH.
        matches!(code, 10050 | 10051 | 10065)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = code;
        false
    }
}

/// "failed to lookup address information: Name or service not known" ->
/// "Name or service not known".
fn lookup_detail(text: &str) -> String {
    text.strip_prefix(LOOKUP_FAILURE_PREFIX)
        .map_or(text, |rest| rest.trim_start_matches(':').trim())
        .to_string()
}

/// Nothing came back: the request may never have reached Opengeni.
const PREFIX: &str = "Can't reach Opengeni:";
/// An answer had started arriving when the connection failed.
const LOST_PREFIX: &str = "Lost contact with Opengeni:";

/// The proxy reqwest takes from the environment for a request, named by host
/// and port only (never its credentials) with the variable that set it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct EnvironmentProxy {
    pub(super) address: String,
    pub(super) variable: &'static str,
}

/// Mirrors reqwest's environment proxy choice closely enough to name the
/// proxy in a message: the scheme's variable (the first of upper and lower
/// case that is set), then ALL_PROXY, unless NO_PROXY covers the host. When
/// unsure (an IP address with NO_PROXY set, which reqwest may match by
/// range) it names no proxy rather than the wrong one.
pub(super) fn environment_proxy(
    url: &Url,
    variable: impl Fn(&str) -> Option<String>,
) -> Option<EnvironmentProxy> {
    let host = url.host_str()?;
    // reqwest takes no proxy from the environment in a CGI process.
    if variable("REQUEST_METHOD").is_some() {
        return None;
    }
    // The first of a pair that is set wins, even when it is empty.
    let first_set = |upper: &'static str, lower: &'static str| {
        variable(upper)
            .map(|value| (upper, value))
            .or_else(|| variable(lower).map(|value| (lower, value)))
    };
    let no_proxy = first_set("NO_PROXY", "no_proxy")
        .map(|(_, value)| value)
        .unwrap_or_default();
    if !no_proxy.trim().is_empty() && url.domain().is_none() {
        return None;
    }
    for entry in no_proxy
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
    {
        if entry == "*" {
            return None;
        }
        let domain = entry.trim_start_matches('.');
        if host.eq_ignore_ascii_case(domain)
            || host
                .to_ascii_lowercase()
                .ends_with(&format!(".{}", domain.to_ascii_lowercase()))
        {
            return None;
        }
    }
    let scheme_variable = if url.scheme() == "https" {
        first_set("HTTPS_PROXY", "https_proxy")
    } else {
        first_set("HTTP_PROXY", "http_proxy")
    };
    let (name, address) = scheme_variable
        .and_then(|(name, value)| proxy_address(&value).map(|address| (name, address)))
        .or_else(|| {
            first_set("ALL_PROXY", "all_proxy")
                .and_then(|(name, value)| proxy_address(&value).map(|address| (name, address)))
        })?;
    Some(EnvironmentProxy {
        address,
        variable: name,
    })
}

/// A proxy setting's host and port, never its credentials; None when empty,
/// unparsable or of a scheme reqwest does not use.
fn proxy_address(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let proxy = if value.contains("://") {
        Url::parse(value)
    } else {
        Url::parse(&format!("http://{value}"))
    }
    .ok()?;
    if !matches!(proxy.scheme(), "http" | "https" | "socks5" | "socks5h") {
        return None;
    }
    let host = proxy.host_str()?.to_string();
    Some(match proxy.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    })
}

/// One short message naming why a request to `url` got no answer, with what
/// to check; None when the reason is unknown (the caller keeps reqwest's text).
pub(super) fn describe_connection_failure(
    error: &reqwest::Error,
    request_url: Option<&Url>,
    now: SystemTime,
) -> Option<String> {
    let cause = match network_cause(error) {
        Some(NetworkCause::ConnectTimedOut) if !error.is_connect() => NetworkCause::AnswerTimedOut,
        Some(cause) => cause,
        None if error.is_timeout() && error.is_connect() => NetworkCause::ConnectTimedOut,
        None if error.is_timeout() => NetworkCause::AnswerTimedOut,
        None => return None,
    };
    // reqwest leaves the URL off errors raised while reading a body.
    let url = error.url().or(request_url);
    let proxy = url.and_then(|url| environment_proxy(url, |name| std::env::var(name).ok()));
    Some(describe_cause(
        &cause,
        &Target {
            url,
            proxy: proxy.as_ref(),
            answer_started: error.is_body() || error.is_decode(),
        },
        now,
        cfg!(target_os = "linux"),
    ))
}

/// Where the failed request was going.
pub(super) struct Target<'a> {
    pub(super) url: Option<&'a Url>,
    /// A proxy from the environment: connection failures are the proxy's.
    pub(super) proxy: Option<&'a EnvironmentProxy>,
    /// The failure came while reading an answer that had started.
    pub(super) answer_started: bool,
}

pub(super) fn describe_cause(
    cause: &NetworkCause,
    target: &Target<'_>,
    now: SystemTime,
    linux: bool,
) -> String {
    let url = target.url;
    let hostname = url
        .and_then(Url::host_str)
        .unwrap_or("the Opengeni host")
        .to_string();
    let host = match (url.and_then(Url::host_str), url.and_then(Url::port)) {
        (Some(name), Some(port)) => format!("{name}:{port}"),
        _ => hostname.clone(),
    };
    let prefix = if target.answer_started {
        LOST_PREFIX
    } else {
        PREFIX
    };
    if let Some(proxy) = target.proxy {
        let (address, variable) = (&proxy.address, proxy.variable);
        match cause {
            NetworkCause::Dns(detail) => {
                let detail = if detail.is_empty() {
                    String::new()
                } else {
                    format!(" ({detail})")
                };
                return format!("{prefix} DNS lookup for the proxy {address} (from {variable}) failed{detail}. Check {variable} and this machine's DNS settings.");
            }
            NetworkCause::Refused => {
                return format!("{prefix} the connection to the proxy {address} (from {variable}) was refused. Check {variable} and that the proxy is running.");
            }
            NetworkCause::ConnectTimedOut => {
                return format!("{prefix} connecting through the proxy {address} (from {variable}) timed out. Check {variable}, the proxy, and this machine's network and firewall settings.");
            }
            NetworkCause::Unreachable => {
                return format!("{prefix} no network route to the proxy {address} (from {variable}). Check {variable} and this machine's network settings.");
            }
            _ => {}
        }
    }
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
            format!("{prefix} DNS lookup for {hostname} failed{detail}. {hint}")
        }
        NetworkCause::CertificateNotYetValid => format!(
            "{prefix} TLS certificate not yet valid. This machine's clock says {}, so it is probably wrong.",
            clock_reading(now)
        ),
        NetworkCause::CertificateExpired => format!(
            "{prefix} the TLS certificate for {hostname} has expired by this machine's clock ({}). If that time is wrong, fix the clock; otherwise the server's certificate has expired.",
            clock_reading(now)
        ),
        NetworkCause::CertificateWrongName => format!(
            "{prefix} the TLS certificate presented for {hostname} is for a different name. Check the Opengeni URL and any HTTPS proxy that intercepts connections."
        ),
        NetworkCause::CertificateRejected(reason) => format!(
            "{prefix} the TLS certificate of {hostname} could not be verified ({reason}). Check this machine's CA certificates and any HTTPS proxy."
        ),
        NetworkCause::Refused => format!(
            "{prefix} the connection to {host} was refused. Check this machine's network, firewall and proxy settings."
        ),
        NetworkCause::ConnectTimedOut => format!(
            "{prefix} the connection to {host} timed out. Check this machine's network, firewall and proxy settings."
        ),
        NetworkCause::AnswerTimedOut if target.answer_started => {
            format!("{prefix} the answer from {host} stopped arriving.")
        }
        NetworkCause::AnswerTimedOut => format!("{prefix} {host} did not answer in time."),
        NetworkCause::Closed => format!(
            "{prefix} the connection to {host} closed unexpectedly. If it keeps happening, check this machine's network and proxy settings."
        ),
        NetworkCause::Unreachable => format!(
            "{prefix} no network route to {host}. Check this machine's network settings."
        ),
    }
}

/// UTC, to the second, so the reader can compare it with the real time.
pub(super) fn clock_reading(now: SystemTime) -> String {
    let Ok(since_epoch) = now.duration_since(UNIX_EPOCH) else {
        return "a time before 1970".to_string();
    };
    let seconds = since_epoch.as_secs();
    let of_day = seconds % 86_400;
    let (year, month, day) = civil_from_days(seconds / 86_400);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02} UTC",
        of_day / 3600,
        of_day % 3600 / 60,
        of_day % 60
    )
}

/// Days since 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's
/// algorithm; every value stays non-negative from 1970 on).
fn civil_from_days(days: u64) -> (u64, u64, u64) {
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z % 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
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

    fn direct(url: &Url) -> Target<'_> {
        Target {
            url: Some(url),
            proxy: None,
            answer_started: false,
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
            describe_cause(&NetworkCause::CertificateNotYetValid, &direct(&url), now, true),
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
            &direct(&url),
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
        assert!(
            describe_cause(&cause, &direct(&url), SystemTime::now(), true)
                .contains("could not be verified")
        );
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
            describe_cause(&cause, &direct(&url), SystemTime::now(), true),
            "Can't reach Opengeni: DNS lookup for app.opengeni.ai failed (Temporary failure in name resolution). Check /etc/resolv.conf."
        );
        assert!(
            describe_cause(&cause, &direct(&url), SystemTime::now(), false)
                .ends_with("Check this machine's DNS settings.")
        );
    }

    #[test]
    fn socket_errors_map_to_their_reason() {
        for (kind, expected) in [
            (io::ErrorKind::ConnectionRefused, NetworkCause::Refused),
            (io::ErrorKind::TimedOut, NetworkCause::ConnectTimedOut),
            (io::ErrorKind::ConnectionReset, NetworkCause::Closed),
        ] {
            let failure = wrapped("client error (Connect)", io::Error::from(kind));
            assert_eq!(network_cause(&failure), Some(expected), "{kind:?}");
        }
        // Out of local ports is not "no route".
        let ports = wrapped(
            "client error (Connect)",
            io::Error::from(io::ErrorKind::AddrNotAvailable),
        );
        assert_eq!(network_cause(&ports), None);
    }

    #[cfg(unix)]
    #[test]
    fn no_route_is_recognised_by_its_os_error() {
        for errno in [
            nix::errno::Errno::ENETUNREACH,
            nix::errno::Errno::EHOSTUNREACH,
        ] {
            let failure = wrapped(
                "client error (Connect)",
                io::Error::from_raw_os_error(errno as i32),
            );
            assert_eq!(network_cause(&failure), Some(NetworkCause::Unreachable));
        }
    }

    #[test]
    fn a_certificate_for_another_name_points_at_the_url_and_intercepting_proxies() {
        let failure = tls_failure(CertificateError::NotValidForName);
        assert_eq!(
            network_cause(&failure),
            Some(NetworkCause::CertificateWrongName)
        );
        let url = Url::parse("https://app.opengeni.ai/codemode/").unwrap();
        assert_eq!(
            describe_cause(&NetworkCause::CertificateWrongName, &direct(&url), SystemTime::now(), true),
            "Can't reach Opengeni: the TLS certificate presented for app.opengeni.ai is for a different name. Check the Opengeni URL and any HTTPS proxy that intercepts connections."
        );
    }

    fn environment(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let pairs: Vec<(String, String)> = pairs
            .iter()
            .map(|(name, value)| ((*name).to_string(), (*value).to_string()))
            .collect();
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        }
    }

    #[test]
    fn the_environment_proxy_is_named_without_its_credentials() {
        let url = Url::parse("https://app.opengeni.ai/codemode/").unwrap();
        assert_eq!(environment_proxy(&url, environment(&[])), None);
        assert_eq!(
            environment_proxy(
                &url,
                environment(&[("HTTPS_PROXY", "http://user:secret@corp-proxy.example:3128")])
            ),
            Some(EnvironmentProxy {
                address: "corp-proxy.example:3128".to_string(),
                variable: "HTTPS_PROXY",
            })
        );
        assert_eq!(
            environment_proxy(
                &url,
                environment(&[("all_proxy", "corp-proxy.example:8080")])
            )
            .map(|proxy| proxy.variable),
            Some("all_proxy")
        );
        // Only the scheme's own variable applies.
        assert_eq!(
            environment_proxy(
                &url,
                environment(&[("HTTP_PROXY", "corp-proxy.example:3128")])
            ),
            None
        );
        for no_proxy in [
            "*",
            "app.opengeni.ai",
            ".opengeni.ai",
            "localhost, opengeni.ai",
        ] {
            assert_eq!(
                environment_proxy(
                    &url,
                    environment(&[
                        ("HTTPS_PROXY", "corp-proxy.example:3128"),
                        ("NO_PROXY", no_proxy)
                    ])
                ),
                None,
                "{no_proxy}"
            );
        }
    }

    #[test]
    fn a_connection_failure_through_a_proxy_names_the_proxy_not_opengeni() {
        let url = Url::parse("https://app.opengeni.ai/codemode/").unwrap();
        let proxy = EnvironmentProxy {
            address: "corp-proxy.example:3128".to_string(),
            variable: "HTTPS_PROXY",
        };
        let target = Target {
            url: Some(&url),
            proxy: Some(&proxy),
            answer_started: false,
        };
        assert_eq!(
            describe_cause(&NetworkCause::Dns("Name or service not known".into()), &target, SystemTime::now(), true),
            "Can't reach Opengeni: DNS lookup for the proxy corp-proxy.example:3128 (from HTTPS_PROXY) failed (Name or service not known). Check HTTPS_PROXY and this machine's DNS settings."
        );
        assert_eq!(
            describe_cause(&NetworkCause::Refused, &target, SystemTime::now(), true),
            "Can't reach Opengeni: the connection to the proxy corp-proxy.example:3128 (from HTTPS_PROXY) was refused. Check HTTPS_PROXY and that the proxy is running."
        );
        // The certificate is still Opengeni's, tunnelled through the proxy.
        assert!(describe_cause(
            &NetworkCause::CertificateExpired,
            &target,
            SystemTime::now(),
            true
        )
        .contains("the TLS certificate for app.opengeni.ai has expired"));
        // The connect limit also covers the tunnel and handshake.
        assert_eq!(
            describe_cause(&NetworkCause::ConnectTimedOut, &target, SystemTime::now(), true),
            "Can't reach Opengeni: connecting through the proxy corp-proxy.example:3128 (from HTTPS_PROXY) timed out. Check HTTPS_PROXY, the proxy, and this machine's network and firewall settings."
        );
    }

    #[test]
    fn the_proxy_follows_reqwest_in_edge_cases_or_is_not_named() {
        let url = Url::parse("https://app.opengeni.ai/codemode/").unwrap();
        // A leading "*." is literal for reqwest, so it does not bypass the proxy.
        assert!(environment_proxy(
            &url,
            environment(&[
                ("HTTPS_PROXY", "proxy.example:3128"),
                ("NO_PROXY", "*.opengeni.ai")
            ])
        )
        .is_some());
        // The first of a pair that is set wins, even empty; ALL_PROXY still applies.
        assert_eq!(
            environment_proxy(
                &url,
                environment(&[
                    ("HTTPS_PROXY", ""),
                    ("https_proxy", "ignored.example:1"),
                    ("ALL_PROXY", "all.example:2")
                ])
            ),
            Some(EnvironmentProxy {
                address: "all.example:2".to_string(),
                variable: "ALL_PROXY",
            })
        );
        // An unsupported scheme is skipped in favour of ALL_PROXY.
        assert_eq!(
            environment_proxy(
                &url,
                environment(&[
                    ("HTTPS_PROXY", "ftp://x.example:21"),
                    ("ALL_PROXY", "all.example:2")
                ])
            )
            .map(|proxy| proxy.variable),
            Some("ALL_PROXY")
        );
        // An IP address with NO_PROXY set may match a range: name no proxy.
        let ip = Url::parse("http://127.0.0.2:9/codemode/").unwrap();
        assert_eq!(
            environment_proxy(
                &ip,
                environment(&[
                    ("HTTP_PROXY", "proxy.example:3128"),
                    ("NO_PROXY", "127.0.0.0/8")
                ])
            ),
            None
        );
        // reqwest takes no proxy from the environment in a CGI process.
        for (url, proxy_variable) in [
            ("http://app.opengeni.ai/codemode/", "HTTP_PROXY"),
            ("https://app.opengeni.ai/codemode/", "HTTPS_PROXY"),
            ("https://app.opengeni.ai/codemode/", "ALL_PROXY"),
        ] {
            assert_eq!(
                environment_proxy(
                    &Url::parse(url).unwrap(),
                    environment(&[
                        (proxy_variable, "proxy.example:3128"),
                        ("REQUEST_METHOD", "GET")
                    ])
                ),
                None
            );
        }
    }

    #[test]
    fn a_failure_while_reading_an_answer_says_contact_was_lost() {
        let url = Url::parse("https://app.opengeni.ai/codemode/").unwrap();
        let target = Target {
            url: Some(&url),
            proxy: None,
            answer_started: true,
        };
        assert_eq!(
            describe_cause(&NetworkCause::Closed, &target, SystemTime::now(), true),
            "Lost contact with Opengeni: the connection to app.opengeni.ai closed unexpectedly. If it keeps happening, check this machine's network and proxy settings."
        );
        assert_eq!(
            describe_cause(
                &NetworkCause::AnswerTimedOut,
                &target,
                SystemTime::now(),
                true
            ),
            "Lost contact with Opengeni: the answer from app.opengeni.ai stopped arriving."
        );
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
