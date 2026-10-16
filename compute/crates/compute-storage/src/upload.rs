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
//!
//! The same answer says when the object was stored and which write of its
//! name it is (its generation), which a sweep needs to delete an object
//! only if nothing stored it again since the sweep looked (see
//! [`crate::fresh`]).

use std::fmt::{self, Write as _};
use std::time::{Duration, SystemTime};

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

/// What GCS keeps about a stored object.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Stored {
    /// The checksums GCS computed when it stored the object, in
    /// `x-goog-hash` form; empty for composite objects, which have no MD5.
    pub(crate) checksums: String,
    /// When the object was stored, to the second.
    pub(crate) at: Option<SystemTime>,
    /// Which write of the name this object is.
    pub(crate) generation: Option<String>,
}

/// What a delete of one generation of an object did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Deleted {
    Yes,
    /// The name holds another generation now: it was stored again.
    Changed,
    /// Nothing is stored under the name.
    Gone,
}

/// Checksummed uploads to one Google Cloud Storage bucket: create-only, or
/// replacing an object only to repair it.
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
        self.send(path, bytes, true).await
    }

    /// Stores `bytes` at `path`, replacing whatever is there, checked in
    /// transit as [`Self::create`] is.
    pub(crate) async fn replace(&self, path: &Path, bytes: &Bytes) -> Result<()> {
        self.send(path, bytes, false).await.map(drop)
    }

    async fn send(&self, path: &Path, bytes: &Bytes, create_only: bool) -> Result<Created> {
        let hashes = checksums(bytes);
        let mut delay = Duration::from_millis(100);
        let mut attempt = 1;
        loop {
            match self.put(path, bytes, &hashes, create_only).await? {
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

    /// What GCS keeps about the object at `path`, or `None` when there is
    /// no object.
    pub(crate) async fn stored(&self, path: &Path) -> Result<Option<Stored>> {
        let request = self
            .request(http::Method::HEAD, path)
            .await?
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
        let headers = response.headers();
        // GCS sends one `x-goog-hash` header per algorithm.
        let mut crc = None;
        let mut md5 = None;
        for value in headers.get_all("x-goog-hash") {
            let value = value.to_str().unwrap_or_default();
            for part in value.split(',').map(str::trim) {
                if part.starts_with("crc32c=") {
                    crc = Some(part.to_owned());
                } else if part.starts_with("md5=") {
                    md5 = Some(part.to_owned());
                }
            }
        }
        let checksums = match (crc, md5) {
            (Some(crc), Some(md5)) => format!("{crc},{md5}"),
            // Composite objects have no MD5; never match them.
            _ => String::new(),
        };
        let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
        Ok(Some(Stored {
            checksums,
            at: header(http::header::LAST_MODIFIED.as_str()).and_then(|value| {
                chrono::DateTime::parse_from_rfc2822(value)
                    .ok()
                    .map(SystemTime::from)
            }),
            generation: header("x-goog-generation").map(str::to_owned),
        }))
    }

    /// Deletes the object at `path` if it is still `generation`, the write
    /// of the name its caller looked at.
    pub(crate) async fn delete_generation(&self, path: &Path, generation: &str) -> Result<Deleted> {
        let mut delay = Duration::from_millis(100);
        let mut attempt = 1;
        loop {
            let request = self
                .request(http::Method::DELETE, path)
                .await?
                .header("x-goog-if-generation-match", generation)
                .body(HttpRequestBody::empty())
                .map_err(|error| Error::Transfer(error.to_string()))?;
            let reason = match self.client.execute(request).await {
                Ok(response) => match response.status() {
                    status if status.is_success() => return Ok(Deleted::Yes),
                    http::StatusCode::PRECONDITION_FAILED => return Ok(Deleted::Changed),
                    http::StatusCode::NOT_FOUND => return Ok(Deleted::Gone),
                    status
                        if status == http::StatusCode::TOO_MANY_REQUESTS
                            || status.is_server_error() =>
                    {
                        format!("status {status}")
                    }
                    status => {
                        return Err(Error::Transfer(format!("DELETE {path}: status {status}")));
                    }
                },
                // A delete whose answer was lost may have happened: the
                // retry then finds the name changed or gone, never wrongly
                // deletes, since it names the same generation.
                Err(error) => error.to_string(),
            };
            if attempt >= ATTEMPTS {
                return Err(Error::Transfer(format!("DELETE {path}: {reason}")));
            }
            tokio::time::sleep(delay).await;
            delay *= 4;
            attempt += 1;
        }
    }

    async fn request(&self, method: http::Method, path: &Path) -> Result<http::request::Builder> {
        let token = self.credentials.get_credential().await?;
        Ok(http::Request::builder()
            .method(method)
            .uri(self.url(path))
            .header(
                http::header::AUTHORIZATION,
                format!("Bearer {}", token.bearer),
            ))
    }

    fn url(&self, path: &Path) -> String {
        format!("{}/{}", self.bucket_url, encode(path.as_ref()))
    }

    async fn put(
        &self,
        path: &Path,
        bytes: &Bytes,
        hashes: &str,
        create_only: bool,
    ) -> Result<Put> {
        let mut request = self
            .request(http::Method::PUT, path)
            .await?
            .header(http::header::CONTENT_LENGTH, bytes.len())
            .header("x-goog-hash", hashes);
        if create_only {
            // Create only: generation 0 means "no live object".
            request = request.header("x-goog-if-generation-match", "0");
        }
        let request = request
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
    use std::sync::Arc;

    use crate::fake::{Fake, gcs};

    #[tokio::test(start_paused = true)]
    async fn corrupted_uploads_are_refused_and_sent_again() {
        let fake = Arc::new(Fake::default());
        *fake.corrupt.lock().unwrap() = 2;
        let store = gcs(&fake);
        let path = Path::from("p/chunks/v1/a");
        let bytes = Bytes::from_static(b"chunk bytes");
        assert_eq!(store.create(&path, &bytes).await.unwrap(), Created::New);
        assert_eq!(*fake.puts.lock().unwrap(), 3);
        assert_eq!(fake.bytes("p/chunks/v1/a").unwrap(), bytes);
        assert_eq!(store.create(&path, &bytes).await.unwrap(), Created::Exists);
        let stored = store.stored(&path).await.unwrap().unwrap();
        assert_eq!(stored.checksums, checksums(&bytes));
        assert_eq!(store.stored(&Path::from("p/none")).await.unwrap(), None);
        let other = Bytes::from_static(b"other bytes");
        store.replace(&path, &other).await.unwrap();
        assert_eq!(fake.bytes("p/chunks/v1/a").unwrap(), other);
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
        assert_eq!(fake.names().len(), 0);
    }

    /// The stored time and generation come from the same answer as the
    /// checksums, and a delete names the generation it means.
    #[tokio::test]
    async fn only_the_generation_looked_at_is_deleted() {
        let fake = Arc::new(Fake::default());
        let store = gcs(&fake);
        let path = Path::from("p/chunks/v1/b");
        let first = Bytes::from_static(b"first");
        store.create(&path, &first).await.unwrap();
        let seen = store.stored(&path).await.unwrap().unwrap();
        let object = fake.object("p/chunks/v1/b").unwrap();
        assert_eq!(seen.generation, Some(object.generation.to_string()));
        let at = seen.at.unwrap();
        let truncated = object.at.duration_since(at).unwrap();
        assert!(
            truncated < Duration::from_secs(1),
            "to the second: {truncated:?}"
        );
        // Stored again since it was looked at: the delete changes nothing.
        store.replace(&path, &first).await.unwrap();
        let looked_at = seen.generation.unwrap();
        assert_eq!(
            store.delete_generation(&path, &looked_at).await.unwrap(),
            Deleted::Changed
        );
        assert!(fake.bytes("p/chunks/v1/b").is_some());
        let now = store
            .stored(&path)
            .await
            .unwrap()
            .unwrap()
            .generation
            .unwrap();
        assert_eq!(
            store.delete_generation(&path, &now).await.unwrap(),
            Deleted::Yes
        );
        assert!(fake.bytes("p/chunks/v1/b").is_none());
        assert_eq!(
            store.delete_generation(&path, &now).await.unwrap(),
            Deleted::Gone
        );
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
