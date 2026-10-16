//! Uploads the object store verifies before it stores anything.
//!
//! Chunks are named by their content and shared by every sandbox that holds
//! the same bytes, so one chunk corrupted on its way to the store would
//! poison all of them. Each upload therefore carries checksums of its bytes
//! and the store rejects it if what arrived does not match:
//!
//! - Google Cloud Storage: the XML API's `x-goog-hash` header with CRC32C and
//!   MD5, sent by [`Gcs`] because `object_store` cannot attach it.
//! - S3: `object_store`'s own SHA-256 checksum, enabled when the store is
//!   built (see `ChunkStore::from_url`).
//! - Anything else: the bytes are read back and compared after the upload.
//!
//! When an object already exists under a content name, GCS reports the
//! checksums it computed when the object was stored, so [`Gcs::stored`]
//! compares them with ours without downloading the object.

use std::fmt::{self, Write as _};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use bytes::Bytes;
use md5::Digest as _;
use object_store::client::{HttpClient, HttpRequestBody};
use object_store::gcp::GcpCredentialProvider;
use object_store::path::Path;

use crate::{Error, Result};

/// Attempts per upload: transient failures and in-transit corruption are
/// retried; anything else fails at once.
const ATTEMPTS: u32 = 4;

/// What a create-only upload found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Created {
    /// This upload created the object.
    New,
    /// An object was already stored under the name; nothing was written.
    Exists,
}

/// Create-only, checksummed uploads to one Google Cloud Storage bucket.
#[derive(Clone)]
pub(crate) struct Gcs {
    client: HttpClient,
    credentials: GcpCredentialProvider,
    bucket_url: String,
}

impl fmt::Debug for Gcs {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Gcs")
            .field("bucket_url", &self.bucket_url)
            .finish_non_exhaustive()
    }
}

impl Gcs {
    pub(crate) fn new(
        client: HttpClient,
        credentials: GcpCredentialProvider,
        base_url: &str,
        bucket: &str,
    ) -> Self {
        Self {
            client,
            credentials,
            bucket_url: format!("{}/{}", base_url.trim_end_matches('/'), encode(bucket)),
        }
    }

    /// Stores `bytes` at `path` unless something is already there. The store
    /// checks the CRC32C and MD5 sent with the bytes and refuses the upload
    /// if either differs, so bytes corrupted in transit are never stored.
    pub(crate) async fn create(&self, path: &Path, bytes: &Bytes) -> Result<Created> {
        let hashes = checksums(bytes);
        let url = self.url(path);
        let mut delay = Duration::from_millis(100);
        let mut attempt = 1;
        loop {
            match self.put(&url, bytes, &hashes).await? {
                Put::Done(created) => return Ok(created),
                Put::Retry(reason) | Put::Fail(reason) if attempt >= ATTEMPTS => {
                    return Err(Error::Transfer(format!("PUT {path}: {reason}")));
                }
                Put::Fail(reason) => return Err(Error::Transfer(format!("PUT {path}: {reason}"))),
                // Retries are expected; only the final failure is reported.
                Put::Retry(_) => {}
            }
            tokio::time::sleep(delay).await;
            delay *= 4;
            attempt += 1;
        }
    }

    /// The checksums GCS computed for the object at `path` when it was
    /// stored, in `x-goog-hash` form, or `None` when there is no object.
    pub(crate) async fn stored(&self, path: &Path) -> Result<Option<String>> {
        let token = self.credentials.get_credential().await?;
        let request = http::Request::builder()
            .method(http::Method::HEAD)
            .uri(self.url(path))
            .header(
                http::header::AUTHORIZATION,
                format!("Bearer {}", token.bearer),
            )
            .body(HttpRequestBody::empty())
            .map_err(|error| Error::Transfer(error.to_string()))?;
        let response = self
            .client
            .execute(request)
            .await
            .map_err(|error| Error::Transfer(format!("HEAD {path}: {error}")))?;
        let status = response.status();
        if status == http::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !status.is_success() {
            return Err(Error::Transfer(format!("HEAD {path}: status {status}")));
        }
        // GCS sends one `x-goog-hash` header per algorithm.
        let mut crc = None;
        let mut md5 = None;
        for value in response.headers().get_all("x-goog-hash") {
            let value = value.to_str().unwrap_or_default();
            for part in value.split(',').map(str::trim) {
                if part.starts_with("crc32c=") {
                    crc = Some(part.to_owned());
                } else if part.starts_with("md5=") {
                    md5 = Some(part.to_owned());
                }
            }
        }
        Ok(Some(match (crc, md5) {
            (Some(crc), Some(md5)) => format!("{crc},{md5}"),
            // Composite objects have no MD5; never match them.
            _ => String::new(),
        }))
    }

    fn url(&self, path: &Path) -> String {
        format!("{}/{}", self.bucket_url, encode(path.as_ref()))
    }

    async fn put(&self, url: &str, bytes: &Bytes, hashes: &str) -> Result<Put> {
        let token = self.credentials.get_credential().await?;
        let request = http::Request::builder()
            .method(http::Method::PUT)
            .uri(url)
            .header(
                http::header::AUTHORIZATION,
                format!("Bearer {}", token.bearer),
            )
            .header(http::header::CONTENT_LENGTH, bytes.len())
            .header("x-goog-hash", hashes)
            // Create only: generation 0 means "no live object".
            .header("x-goog-if-generation-match", "0")
            .body(HttpRequestBody::from(bytes.clone()))
            .map_err(|error| Error::Transfer(error.to_string()))?;
        let response = match self.client.execute(request).await {
            Ok(response) => response,
            Err(error) => return Ok(Put::Retry(error.to_string())),
        };
        let status = response.status();
        if status.is_success() {
            return Ok(Put::Done(Created::New));
        }
        if status == http::StatusCode::PRECONDITION_FAILED {
            return Ok(Put::Done(Created::Exists));
        }
        let body = response.into_body().bytes().await.unwrap_or_default();
        let body = String::from_utf8_lossy(&body[..body.len().min(512)]).into_owned();
        let corrupted = body.contains("BadDigest") || body.contains("InvalidDigest");
        let reason = format!("status {status}: {body}");
        Ok(
            if corrupted
                || status == http::StatusCode::TOO_MANY_REQUESTS
                || status.is_server_error()
            {
                Put::Retry(reason)
            } else {
                Put::Fail(reason)
            },
        )
    }
}

/// How one PUT went.
enum Put {
    Done(Created),
    /// Transient, or the bytes were corrupted on the way: send them again.
    Retry(String),
    Fail(String),
}

/// The `x-goog-hash` value for `bytes`: big-endian CRC32C and MD5, base64.
pub(crate) fn checksums(bytes: &[u8]) -> String {
    let crc = crc32c::crc32c(bytes).to_be_bytes();
    let md5 = md5::Md5::digest(bytes);
    format!("crc32c={},md5={}", BASE64.encode(crc), BASE64.encode(md5))
}

/// Percent-encodes an object name for a URL path, keeping `/` separators.
fn encode(name: &str) -> String {
    let mut encoded = String::with_capacity(name.len());
    for byte in name.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/') {
            encoded.push(char::from(byte));
        } else {
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    use object_store::StaticCredentialProvider;
    use object_store::client::{HttpError, HttpRequest, HttpResponse, HttpService};
    use object_store::gcp::GcpCredential;

    /// A GCS stand-in that verifies `x-goog-hash` as the real service does,
    /// optionally after corrupting the first `corrupt` uploads in transit.
    #[derive(Debug, Default)]
    struct Fake {
        objects: Mutex<HashMap<String, Bytes>>,
        corrupt: Mutex<u32>,
        puts: Mutex<u32>,
    }

    #[derive(Debug)]
    struct Service(Arc<Fake>);

    #[async_trait::async_trait]
    impl HttpService for Service {
        async fn call(&self, request: HttpRequest) -> std::result::Result<HttpResponse, HttpError> {
            let (parts, body) = request.into_parts();
            let key = parts.uri.path().to_owned();
            let reply = |status: u16, body: &str| {
                http::Response::builder()
                    .status(status)
                    .body(Bytes::from(body.to_owned()).into())
                    .unwrap()
            };
            if parts.method == http::Method::HEAD {
                let objects = self.0.objects.lock().unwrap();
                return Ok(match objects.get(&key) {
                    None => reply(404, ""),
                    Some(bytes) => {
                        let hashes = checksums(bytes);
                        let (crc, md5) = hashes.split_once(',').unwrap();
                        http::Response::builder()
                            .status(200)
                            .header("x-goog-hash", crc)
                            .header("x-goog-hash", md5)
                            .body(Bytes::new().into())
                            .unwrap()
                    }
                });
            }
            *self.0.puts.lock().unwrap() += 1;
            let mut bytes = Bytes::from(body.as_bytes().unwrap().to_vec());
            {
                let mut corrupt = self.0.corrupt.lock().unwrap();
                if *corrupt > 0 {
                    *corrupt -= 1;
                    let mut damaged = bytes.to_vec();
                    damaged[0] ^= 1;
                    bytes = Bytes::from(damaged);
                }
            }
            let sent = parts.headers["x-goog-hash"].to_str().unwrap();
            if sent != checksums(&bytes) {
                return Ok(reply(400, "<Code>BadDigest</Code>"));
            }
            let mut objects = self.0.objects.lock().unwrap();
            if objects.contains_key(&key) {
                return Ok(reply(412, ""));
            }
            objects.insert(key, bytes);
            Ok(reply(200, ""))
        }
    }

    fn gcs(fake: &Arc<Fake>) -> Gcs {
        let credentials = Arc::new(StaticCredentialProvider::new(GcpCredential {
            bearer: "token".to_owned(),
        }));
        Gcs::new(
            HttpClient::new(Service(fake.clone())),
            credentials,
            "http://fake",
            "bucket",
        )
    }

    #[tokio::test(start_paused = true)]
    async fn corrupted_uploads_are_refused_and_sent_again() {
        let fake = Arc::new(Fake::default());
        *fake.corrupt.lock().unwrap() = 2;
        let store = gcs(&fake);
        let path = Path::from("p/chunks/v1/a");
        let bytes = Bytes::from_static(b"chunk bytes");
        assert_eq!(store.create(&path, &bytes).await.unwrap(), Created::New);
        assert_eq!(*fake.puts.lock().unwrap(), 3);
        assert_eq!(fake.objects.lock().unwrap()["/bucket/p/chunks/v1/a"], bytes);
        assert_eq!(store.create(&path, &bytes).await.unwrap(), Created::Exists);
        assert_eq!(store.stored(&path).await.unwrap(), Some(checksums(&bytes)));
        assert_eq!(store.stored(&Path::from("p/none")).await.unwrap(), None);
    }

    #[tokio::test(start_paused = true)]
    async fn persistent_corruption_fails_without_storing_anything() {
        let fake = Arc::new(Fake::default());
        *fake.corrupt.lock().unwrap() = u32::MAX;
        let store = gcs(&fake);
        let error = store
            .create(&Path::from("p/x"), &Bytes::from_static(b"x"))
            .await
            .unwrap_err();
        assert!(matches!(error, Error::Transfer(_)), "{error}");
        assert_eq!(*fake.puts.lock().unwrap(), ATTEMPTS);
        assert!(fake.objects.lock().unwrap().is_empty());
    }

    #[test]
    fn checksums_match_the_published_test_vectors() {
        // CRC32C of "123456789" is 0xE3069283; MD5 of "" is d41d8cd9...
        assert!(checksums(b"123456789").starts_with("crc32c=4waSgw==,"));
        assert_eq!(
            checksums(b""),
            "crc32c=AAAAAA==,md5=1B2M2Y8AsgTpgAmY7PhCfg=="
        );
    }

    #[test]
    fn names_are_encoded_but_keep_their_separators() {
        assert_eq!(encode("p/chunks/v1/a b+c"), "p/chunks/v1/a%20b%2Bc");
    }
}
