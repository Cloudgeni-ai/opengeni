//! Mutual TLS between the service and its hosts, all of it by the hosts'
//! authority ([`authority`](crate::authority)).
//!
//! The service presents its own certificate, issued in memory by the
//! authority for the names hosts dial and replaced a day after each issue
//! ([`OwnCertificate`]), both when hosts call it and when it calls them; it
//! trusts the authority's certificates alone. A host is who its certificate
//! names: it may register, renew and report only under that name, so a
//! host broken into cannot act for another. A caller may come without a
//! certificate only to ask for one (`hostapi`); every other route refuses
//! it.

use std::path::Path;
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime};

use anyhow::Context as _;
use rcgen::KeyPair;
use rustls::client::ResolvesClientCert;
use rustls::crypto::CryptoProvider;
use rustls::pki_types::pem::PemObject as _;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::server::{ClientHello, ResolvesServerCert, WebPkiClientVerifier};
use rustls::sign::CertifiedKey;
use rustls::{ClientConfig, RootCertStore, ServerConfig, SignatureScheme};

use crate::authority::{Authority, ISSUED_FOR};

/// How old the service's own certificate gets before it is replaced: a
/// day, so a week-long certificate always has six days left.
pub const OWN_RENEWED_AFTER: Duration = Duration::from_secs(24 * 60 * 60);
/// How long to wait before trying again when replacing it failed.
const OWN_RETRY: Duration = Duration::from_secs(60);

/// Both directions' settings.
#[derive(Clone)]
pub struct Tls {
    /// For the host API hosts call.
    pub server: Arc<ServerConfig>,
    /// For calling hosts.
    pub client: ClientConfig,
    /// The authority both trust and issue by.
    pub authority: Arc<Authority>,
    /// The certificate the service presents.
    pub own: Arc<OwnCertificate>,
}

impl std::fmt::Debug for Tls {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Tls")
    }
}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

fn certificates(path: &Path) -> anyhow::Result<Vec<CertificateDer<'static>>> {
    let certificates = CertificateDer::pem_file_iter(path)
        .with_context(|| format!("reading {}", path.display()))?
        .collect::<Result<Vec<_>, _>>()
        .with_context(|| format!("parsing {}", path.display()))?;
    anyhow::ensure!(
        !certificates.is_empty(),
        "{} holds no certificate",
        path.display()
    );
    Ok(certificates)
}

/// The authorities in the PEM file at `path`.
pub fn authority(path: &Path) -> anyhow::Result<Arc<RootCertStore>> {
    let mut roots = RootCertStore::empty();
    for certificate in certificates(path)? {
        roots
            .add(certificate)
            .with_context(|| format!("trusting {}", path.display()))?;
    }
    Ok(Arc::new(roots))
}

/// The service's own certificate on the host endpoint: a new key and a
/// certificate for it from the authority, valid for [`ISSUED_FOR`], for
/// the names hosts reach the service by. Connections made with an earlier
/// one keep going; new ones get the current one.
pub struct OwnCertificate {
    authority: Arc<Authority>,
    names: Vec<String>,
    current: RwLock<(Arc<CertifiedKey>, SystemTime)>,
}

impl std::fmt::Debug for OwnCertificate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OwnCertificate")
            .field("names", &self.names)
            .finish_non_exhaustive()
    }
}

impl OwnCertificate {
    /// A certificate for `names` from `authority`.
    pub fn new(authority: Arc<Authority>, names: Vec<String>) -> anyhow::Result<Self> {
        let first = Self::issue(&authority, &names)?;
        Ok(Self {
            authority,
            names,
            current: RwLock::new(first),
        })
    }

    fn issue(
        authority: &Authority,
        names: &[String],
    ) -> anyhow::Result<(Arc<CertifiedKey>, SystemTime)> {
        let key = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256)?;
        let issued = authority.issue(names, &key, SystemTime::now(), ISSUED_FOR)?;
        let certified = CertifiedKey::from_der(
            vec![issued.der],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
            &provider(),
        )
        .context("the service's own certificate")?;
        Ok((Arc::new(certified), issued.not_after))
    }

    /// The names hosts reach the service by, which its certificate holds.
    #[must_use]
    pub fn names(&self) -> &[String] {
        &self.names
    }

    /// The certificate presented now.
    #[must_use]
    pub fn current(&self) -> Arc<CertifiedKey> {
        Arc::clone(
            &self
                .current
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .0,
        )
    }

    /// When the certificate presented now stops being valid.
    #[must_use]
    pub fn not_after(&self) -> SystemTime {
        self.current
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .1
    }

    /// Replaces the certificate with a new one, of a new key.
    pub fn renew(&self) -> anyhow::Result<()> {
        let next = Self::issue(&self.authority, &self.names)?;
        *self
            .current
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = next;
        Ok(())
    }

    /// Replaces the certificate [`OWN_RENEWED_AFTER`] after each issue, for
    /// ever.
    pub async fn keep_fresh(self: Arc<Self>) {
        loop {
            let renew_at = self.not_after() - ISSUED_FOR + OWN_RENEWED_AFTER;
            let wait = renew_at
                .duration_since(SystemTime::now())
                .unwrap_or(Duration::ZERO);
            tokio::time::sleep(wait).await;
            match self.renew() {
                Ok(()) => {
                    tracing::info!(names = ?self.names, "renewed the service's own certificate");
                }
                Err(error) => {
                    tracing::error!(error = %format!("{error:#}"), "renewing the service's own certificate failed");
                    tokio::time::sleep(OWN_RETRY).await;
                }
            }
        }
    }
}

impl ResolvesServerCert for OwnCertificate {
    fn resolve(&self, _: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        Some(self.current())
    }
}

impl ResolvesClientCert for OwnCertificate {
    fn resolve(&self, _: &[&[u8]], _: &[SignatureScheme]) -> Option<Arc<CertifiedKey>> {
        Some(self.current())
    }

    fn has_certs(&self) -> bool {
        true
    }
}

impl Tls {
    /// Both directions' settings, by `authority`, for a service hosts reach
    /// by `names`.
    pub fn new(authority: Arc<Authority>, names: Vec<String>) -> anyhow::Result<Self> {
        let own = Arc::new(OwnCertificate::new(Arc::clone(&authority), names)?);
        let hosts = authority.roots();
        // A caller without a certificate gets as far as the routes, which
        // refuse it everywhere but where it asks for its certificate.
        let verifier = WebPkiClientVerifier::builder_with_provider(Arc::clone(&hosts), provider())
            .allow_unauthenticated()
            .build()
            .context("setting up host certificate checks")?;
        let server = ServerConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()?
            .with_client_cert_verifier(verifier)
            .with_cert_resolver(Arc::clone(&own) as Arc<dyn ResolvesServerCert>);
        let client = ClientConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()?
            .with_root_certificates(hosts)
            .with_client_cert_resolver(Arc::clone(&own) as Arc<dyn ResolvesClientCert>);
        Ok(Self {
            server: Arc::new(server),
            client,
            authority,
            own,
        })
    }
}

/// A TLS server with the certificate chain in `cert` and the key in
/// `key`, both PEM, that asks callers for no certificate: for the E2B
/// front door.
///
/// # Errors
///
/// When either cannot be read or they do not match.
pub fn public_server(cert: &Path, key: &Path) -> anyhow::Result<Arc<ServerConfig>> {
    let chain = certificates(cert)?;
    let key = PrivateKeyDer::from_pem_file(key)
        .with_context(|| format!("reading the key in {}", key.display()))?;
    let mut server = ServerConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(chain, key)
        .context("the front door's certificate and key")?;
    server.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(server))
}

/// A TLS client that trusts the authorities in `ca`, for the database.
pub fn database_client(ca: &Path) -> anyhow::Result<ClientConfig> {
    Ok(ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()?
        .with_root_certificates(authority(ca)?)
        .with_no_client_auth())
}

/// The DNS names a verified peer certificate is valid for.
#[must_use]
pub fn names_of(certificate: &CertificateDer<'_>) -> Vec<String> {
    webpki::EndEntityCert::try_from(certificate).map_or_else(
        |_| Vec::new(),
        |certificate| certificate.valid_dns_names().map(str::to_owned).collect(),
    )
}

/// Longest a caller may take over its TLS handshake.
const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Serves `router` on `listener` for ever, over TLS when `tls` is given,
/// with HTTP/1.1 upgrades; `what` names it in logs.
pub async fn serve(
    listener: tokio::net::TcpListener,
    router: axum::Router,
    tls: Option<Arc<ServerConfig>>,
    what: &'static str,
) {
    use hyper_util::rt::TokioIo;
    use hyper_util::service::TowerToHyperService;

    let Some(tls) = tls else {
        if let Err(error) = axum::serve(listener, router).await {
            tracing::error!(%error, "{what} stopped");
        }
        return;
    };
    let acceptor = tokio_rustls::TlsAcceptor::from(tls);
    loop {
        let (tcp, _) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(error) => {
                tracing::warn!(%error, "{what}: accepting a connection failed");
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            }
        };
        let (acceptor, router) = (acceptor.clone(), router.clone());
        tokio::spawn(async move {
            let _ = tcp.set_nodelay(true);
            let stream = match tokio::time::timeout(HANDSHAKE_TIMEOUT, acceptor.accept(tcp)).await {
                Ok(Ok(stream)) => stream,
                Ok(Err(error)) => {
                    tracing::debug!(%error, "{what}: a caller's TLS handshake failed");
                    return;
                }
                Err(_) => return,
            };
            let served = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(stream), TowerToHyperService::new(router))
                .with_upgrades()
                .await;
            if let Err(error) = served {
                tracing::debug!(%error, "{what}: a connection ended with an error");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use rustls::pki_types::ServerName;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio_rustls::{TlsAcceptor, TlsConnector};

    use super::*;
    use crate::authority::generate;

    fn service() -> Tls {
        let (certificate, key) = generate("test authority").unwrap();
        let authority = Arc::new(Authority::from_pem(&certificate, &key).unwrap());
        Tls::new(authority, vec!["control.example".into()]).unwrap()
    }

    /// A host's client: trusts the authority, presents a certificate of it.
    fn host(tls: &Tls) -> ClientConfig {
        let key = KeyPair::generate().unwrap();
        let issued = tls
            .authority
            .issue(&["host-1".into()], &key, SystemTime::now(), ISSUED_FOR)
            .unwrap();
        let mut client = ClientConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(tls.authority.roots())
            .with_client_auth_cert(
                vec![issued.der],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
            )
            .unwrap();
        // Each connection a full handshake, so it shows the certificate the
        // service presents now.
        client.resumption = rustls::client::Resumption::disabled();
        client
    }

    /// A connection from `client` to the service, echoing what it is sent,
    /// and the certificate the service presented on it.
    async fn connect(
        tls: &Tls,
        client: &ClientConfig,
    ) -> (
        tokio_rustls::client::TlsStream<tokio::io::DuplexStream>,
        CertificateDer<'static>,
    ) {
        let (near, far) = tokio::io::duplex(64 << 10);
        let acceptor = TlsAcceptor::from(Arc::clone(&tls.server));
        tokio::spawn(async move {
            let mut stream = acceptor.accept(near).await.unwrap();
            let mut buffer = [0u8; 4];
            while stream.read_exact(&mut buffer).await.is_ok() {
                stream.write_all(&buffer).await.unwrap();
                stream.flush().await.unwrap();
            }
        });
        let connector = TlsConnector::from(Arc::new(client.clone()));
        let name = ServerName::try_from("control.example").unwrap();
        let stream = connector.connect(name, far).await.unwrap();
        let presented = stream.get_ref().1.peer_certificates().unwrap()[0].clone();
        (stream, presented)
    }

    async fn echoes(stream: &mut tokio_rustls::client::TlsStream<tokio::io::DuplexStream>) {
        stream.write_all(b"ping").await.unwrap();
        stream.flush().await.unwrap();
        let mut heard = [0u8; 4];
        stream.read_exact(&mut heard).await.unwrap();
        assert_eq!(&heard, b"ping");
    }

    #[tokio::test]
    async fn a_renewed_own_certificate_serves_new_connections_and_keeps_open_ones() {
        let tls = service();
        let client = host(&tls);
        let (mut open, before) = connect(&tls, &client).await;
        echoes(&mut open).await;
        let lasts = tls
            .own
            .not_after()
            .duration_since(SystemTime::now())
            .unwrap();
        assert!(lasts + Duration::from_secs(5) > ISSUED_FOR, "{lasts:?}");
        tls.own.renew().unwrap();
        echoes(&mut open).await;
        let (mut new, after) = connect(&tls, &client).await;
        echoes(&mut new).await;
        assert_ne!(before, after, "a new certificate");
        crate::authority::verify(
            &tls.authority.roots(),
            &after,
            SystemTime::now(),
            "control.example",
        )
        .unwrap();
        echoes(&mut open).await;
    }

    #[tokio::test(start_paused = true)]
    async fn the_own_certificate_is_replaced_a_day_after_its_issue() {
        let tls = service();
        let first = tls.own.current();
        let keeping = tokio::spawn(Arc::clone(&tls.own).keep_fresh());
        // The wait is measured against the wall clock, which a paused
        // runtime does not move: a day of the runtime's time passes it.
        tokio::time::sleep(OWN_RENEWED_AFTER.saturating_sub(Duration::from_secs(60))).await;
        assert!(Arc::ptr_eq(&first, &tls.own.current()), "not yet");
        tokio::time::sleep(Duration::from_secs(120)).await;
        assert!(!Arc::ptr_eq(&first, &tls.own.current()), "renewed");
        keeping.abort();
    }

    #[tokio::test]
    async fn the_service_presents_its_own_certificate_when_it_calls_hosts() {
        let tls = service();
        let own = ResolvesClientCert::resolve(&*tls.own, &[], &[]).unwrap();
        assert!(Arc::ptr_eq(&own, &tls.own.current()));
        assert!(tls.own.has_certs());
    }
}
