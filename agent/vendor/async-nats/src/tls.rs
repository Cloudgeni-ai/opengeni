// Copyright 2020-2022 The NATS Authors
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

use crate::connector::ConnectorOptions;
use crate::tls;
use rustls_pki_types::pem::PemObject;
use rustls_webpki::types::{CertificateDer, PrivateKeyDer};
use std::io::{self, BufReader, ErrorKind};
use std::path::PathBuf;
use std::sync::OnceLock;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};

/// Loads client certificates from a `.pem` file.
/// If the pem file is found, but does not contain any certificates, it will return
/// empty set of Certificates, not error.
/// Can be used to parse only client certificates from .pem file containing both client key and certs.
pub(crate) async fn load_certs(path: PathBuf) -> io::Result<Vec<CertificateDer<'static>>> {
    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(path)?;
        let reader = BufReader::new(file);
        CertificateDer::pem_reader_iter(reader)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| {
                io::Error::new(
                    ErrorKind::InvalidData,
                    format!("could not load certificates: {}", e),
                )
            })
    })
    .await?
}

/// Loads client key from a `.pem` file.
/// Can be used to parse only client key from .pem file containing both client key and certs.
pub(crate) async fn load_key(path: PathBuf) -> io::Result<PrivateKeyDer<'static>> {
    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(path)?;
        let mut reader = BufReader::new(file);
        PrivateKeyDer::from_pem_reader(&mut reader).map_err(|e| {
            io::Error::new(
                ErrorKind::InvalidData,
                format!("could not load private key: {}", e),
            )
        })
    })
    .await?
}

/// Platform trust anchors, loaded once per process after the first success.
static PLATFORM_CERTS: OnceLock<Vec<CertificateDer<'static>>> = OnceLock::new();

/// Returns the platform's trust anchors, reading the platform store only until
/// one read succeeds.
///
/// Every dial used to read the store again. On macOS that is a synchronous
/// trust-settings query that can block for many seconds and then fail
/// transiently, which turned a routine credential rotation into a long outage
/// and stalled the async worker running it. The read now runs on the blocking
/// pool, and its first successful result serves every later dial. A failure
/// is not cached, so the next dial reads the store again.
async fn platform_certs<F>(load: F) -> io::Result<Vec<CertificateDer<'static>>>
where
    F: FnOnce() -> io::Result<Vec<CertificateDer<'static>>> + Send + 'static,
{
    platform_certs_in(&PLATFORM_CERTS, load).await
}

async fn platform_certs_in<F>(
    cache: &'static OnceLock<Vec<CertificateDer<'static>>>,
    load: F,
) -> io::Result<Vec<CertificateDer<'static>>>
where
    F: FnOnce() -> io::Result<Vec<CertificateDer<'static>>> + Send + 'static,
{
    if let Some(certs) = cache.get() {
        return Ok(certs.clone());
    }
    let certs = tokio::task::spawn_blocking(load)
        .await
        .map_err(io::Error::other)?
        .map_err(|err| io::Error::other(format!("could not load platform certs: {err}")))?;
    Ok(cache.get_or_init(|| certs).clone())
}

pub(crate) async fn config_tls(options: &ConnectorOptions) -> io::Result<ClientConfig> {
    // A caller-provided ClientConfig carries its own roots.
    if let Some(config) = &options.tls_client_config {
        return Ok(config.to_owned());
    }
    let mut root_store = RootCertStore::empty();
    // load native system certs only if user did not specify them.
    if options.certificates.is_empty() {
        let certs = platform_certs(rustls_native_certs::load_native_certs).await?;
        root_store.add_parsable_certificates(certs);
    }

    // use provided ClientConfig or built it from options.
    let tls_config = {
        {
            // Include user-provided certificates.
            for cafile in &options.certificates {
                let trust_anchors = load_certs(cafile.to_owned())
                    .await?
                    .into_iter()
                    .map(|cert| {
                        rustls_webpki::anchor_from_trusted_cert(&cert).map(|ta| ta.to_owned())
                    })
                    .collect::<Result<Vec<_>, rustls_webpki::Error>>()
                    .map_err(|err| {
                        io::Error::new(
                            ErrorKind::InvalidInput,
                            format!("could not load certs: {err}"),
                        )
                    })?;
                root_store.extend(trust_anchors);
            }
            let builder = ClientConfig::builder().with_root_certificates(root_store);
            if let Some(cert) = options.client_cert.clone() {
                if let Some(key) = options.client_key.clone() {
                    let key = tls::load_key(key).await?;
                    let cert = tls::load_certs(cert).await?;
                    builder
                        .with_client_auth_cert(cert, key)
                        .map_err(|_| io::Error::other("could not add certificate or key"))
                } else {
                    Err(io::Error::other("found certificate, but no key"))
                }
            } else {
                // if there are no client certs provided, connect with just TLS.
                Ok(builder.with_no_client_auth())
            }
        }
    }?;
    Ok(tls_config)
}

#[cfg(test)]
mod platform_certs_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn anchor(byte: u8) -> CertificateDer<'static> {
        CertificateDer::from(vec![byte; 4])
    }

    #[tokio::test]
    async fn platform_certs_are_read_once_and_reused_after_the_first_success() {
        static CACHE: OnceLock<Vec<CertificateDer<'static>>> = OnceLock::new();
        static READS: AtomicUsize = AtomicUsize::new(0);

        let failed = platform_certs_in(&CACHE, || {
            READS.fetch_add(1, Ordering::SeqCst);
            Err(io::Error::other("I/O error"))
        })
        .await
        .expect_err("a failed read is reported");
        assert!(failed.to_string().contains("could not load platform certs"));

        let first = platform_certs_in(&CACHE, || {
            READS.fetch_add(1, Ordering::SeqCst);
            Ok(vec![anchor(1)])
        })
        .await
        .expect("a later read succeeds because the failure was not cached");
        assert_eq!(first, vec![anchor(1)]);

        for _ in 0..3 {
            let again = platform_certs_in(&CACHE, || {
                READS.fetch_add(1, Ordering::SeqCst);
                Err(io::Error::other("the platform store is not read again"))
            })
            .await
            .expect("later dials reuse the loaded anchors");
            assert_eq!(again, vec![anchor(1)]);
        }
        assert_eq!(READS.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_slow_platform_read_does_not_block_the_async_runtime() {
        static CACHE: OnceLock<Vec<CertificateDer<'static>>> = OnceLock::new();
        let (release, released) = std::sync::mpsc::channel::<()>();
        // If the read ran on the runtime's only thread, nothing below could run
        // until this watchdog released it, and the elapsed-time check fails.
        let watchdog = release.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(5));
            let _ = watchdog.send(());
        });
        let started = std::time::Instant::now();

        let read = tokio::spawn(platform_certs_in(&CACHE, move || {
            released.recv().expect("released");
            Ok(vec![anchor(2)])
        }));
        tokio::task::yield_now().await;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "the runtime stalled while the platform store was read"
        );
        let _ = release.send(());
        assert_eq!(read.await.expect("joined").expect("read"), vec![anchor(2)]);
    }
}
