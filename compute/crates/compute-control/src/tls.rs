//! Mutual TLS between the service and its hosts.
//!
//! The service proves itself with its certificate and trusts only the
//! hosts' authority, both when hosts call it and when it calls them. A
//! host is who its certificate names: it may register, renew and report
//! only under one of those names, so a host broken into cannot renew
//! another host's lease.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Context as _;
use rustls::crypto::CryptoProvider;
use rustls::pki_types::pem::PemObject as _;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::server::WebPkiClientVerifier;
use rustls::{ClientConfig, RootCertStore, ServerConfig};

/// Where the service's certificate, its key and the hosts' authority are.
#[derive(Clone, Debug)]
pub struct TlsFiles {
    /// The service's certificate chain, PEM.
    pub cert: PathBuf,
    /// The service's private key, PEM.
    pub key: PathBuf,
    /// The authority that signs hosts' certificates, PEM.
    pub host_ca: PathBuf,
}

/// Both directions' settings.
#[derive(Clone)]
pub struct Tls {
    /// For the host API hosts call.
    pub server: Arc<ServerConfig>,
    /// For calling hosts.
    pub client: ClientConfig,
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

impl Tls {
    /// Loads both directions' settings from `files`.
    pub fn load(files: &TlsFiles) -> anyhow::Result<Self> {
        let chain = certificates(&files.cert)?;
        let key = PrivateKeyDer::from_pem_file(&files.key)
            .with_context(|| format!("reading the key in {}", files.key.display()))?;
        let hosts = authority(&files.host_ca)?;
        let verifier = WebPkiClientVerifier::builder_with_provider(Arc::clone(&hosts), provider())
            .build()
            .context("setting up host certificate checks")?;
        let server = ServerConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()?
            .with_client_cert_verifier(verifier)
            .with_single_cert(chain.clone(), key.clone_key())
            .context("the service's certificate and key")?;
        let client = ClientConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()?
            .with_root_certificates(hosts)
            .with_client_auth_cert(chain, key)
            .context("the service's certificate and key")?;
        Ok(Self {
            server: Arc::new(server),
            client,
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
