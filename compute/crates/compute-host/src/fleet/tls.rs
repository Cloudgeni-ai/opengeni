//! Mutual TLS between a host and the control service.
//!
//! Each side proves itself with a certificate, and each trusts only the
//! other side's authority: a host trusts the service's, the service the
//! hosts'. So a host that is broken into can still not pass itself off as
//! the service to other hosts.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Context as _;
use rustls::crypto::CryptoProvider;
use rustls::pki_types::pem::PemObject as _;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::server::WebPkiClientVerifier;
use rustls::{ClientConfig, RootCertStore, ServerConfig};

/// Where a host's certificate, its key and the service's authority are.
#[derive(Clone, Debug)]
pub struct TlsFiles {
    /// The host's certificate chain, PEM.
    pub cert: PathBuf,
    /// The host's private key, PEM.
    pub key: PathBuf,
    /// The authority that signs the service's certificates, PEM.
    pub peer_ca: PathBuf,
}

/// The TLS settings of both directions: the listener the service calls,
/// and the client the host calls the service with.
#[derive(Clone)]
pub struct Tls {
    pub server: Arc<ServerConfig>,
    pub client: ClientConfig,
}

impl std::fmt::Debug for Tls {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Tls")
    }
}

pub(super) fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

pub(super) fn certificates(path: &Path) -> anyhow::Result<Vec<CertificateDer<'static>>> {
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

fn authority(path: &Path) -> anyhow::Result<Arc<RootCertStore>> {
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
        let peers = authority(&files.peer_ca)?;
        let verifier = WebPkiClientVerifier::builder_with_provider(Arc::clone(&peers), provider())
            .build()
            .context("setting up client certificate checks")?;
        let server = ServerConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()?
            .with_client_cert_verifier(verifier)
            .with_single_cert(chain.clone(), key.clone_key())
            .context("the host's certificate and key")?;
        let client = ClientConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()?
            .with_root_certificates(peers)
            .with_client_auth_cert(chain, key)
            .context("the host's certificate and key")?;
        Ok(Self {
            server: Arc::new(server),
            client,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::io;

    use rcgen::{BasicConstraints, Certificate, CertificateParams, IsCa, KeyPair};
    use rustls::pki_types::ServerName;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio_rustls::{TlsAcceptor, TlsConnector};

    use super::*;

    struct Authority {
        cert: Certificate,
        key: KeyPair,
    }

    fn authority(name: &str) -> Authority {
        let key = KeyPair::generate().unwrap();
        let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
        params
            .distinguished_name
            .push(rcgen::DnType::CommonName, name);
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        let cert = params.self_signed(&key).unwrap();
        Authority { cert, key }
    }

    /// A certificate for `name` signed by `by`, trusting `peers`.
    fn issue(dir: &Path, name: &str, by: &Authority, peers: &Authority) -> TlsFiles {
        let key = KeyPair::generate().unwrap();
        let params = CertificateParams::new(vec!["localhost".to_owned()]).unwrap();
        let cert = params.signed_by(&key, &by.cert, &by.key).unwrap();
        let files = TlsFiles {
            cert: dir.join(format!("{name}.pem")),
            key: dir.join(format!("{name}.key")),
            peer_ca: dir.join(format!("{name}-peers.pem")),
        };
        std::fs::write(&files.cert, cert.pem()).unwrap();
        std::fs::write(&files.key, key.serialize_pem()).unwrap();
        std::fs::write(&files.peer_ca, peers.cert.pem()).unwrap();
        files
    }

    /// Whether `client` reaches `server` and hears from it.
    async fn connects(server: &Tls, client: &Tls) -> io::Result<()> {
        let (near, far) = tokio::io::duplex(64 << 10);
        let acceptor = TlsAcceptor::from(Arc::clone(&server.server));
        let answering = tokio::spawn(async move {
            let mut stream = acceptor.accept(near).await?;
            stream.write_all(b"ok").await?;
            stream.flush().await
        });
        let connector = TlsConnector::from(Arc::new(client.client.clone()));
        let name = ServerName::try_from("localhost").unwrap();
        let mut stream = connector.connect(name, far).await?;
        let mut heard = [0; 2];
        stream.read_exact(&mut heard).await?;
        answering.await.unwrap()?;
        assert_eq!(&heard, b"ok");
        Ok(())
    }

    #[tokio::test]
    async fn a_host_and_the_service_each_trust_only_the_others_authority() {
        let dir = tempfile::tempdir().unwrap();
        let hosts = authority("hosts");
        let services = authority("services");
        let host = Tls::load(&issue(dir.path(), "host", &hosts, &services)).unwrap();
        let service = Tls::load(&issue(dir.path(), "service", &services, &hosts)).unwrap();
        connects(&host, &service).await.unwrap();
        connects(&service, &host).await.unwrap();
        // Another host, broken into, cannot pass itself off as the service
        // to this one, nor this one take its requests.
        let other = Tls::load(&issue(dir.path(), "other", &hosts, &services)).unwrap();
        assert!(connects(&host, &other).await.is_err());
        assert!(connects(&other, &host).await.is_err());
    }
}
