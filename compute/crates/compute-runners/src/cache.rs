//! A build cache: Turborepo's remote cache API over object storage.
//!
//! Runners get its address, a token and a team in `TURBO_API`,
//! `TURBO_TOKEN` and `TURBO_TEAM`, so `turbo` shares task results between
//! jobs with no change to workflows. Artifacts are stored under
//! `artifacts/<hash>` beneath the pool's prefix, streamed both ways. An
//! artifact read a day or more after it was stored leaves a marker under
//! `read/<hash>`; a sweep deletes artifacts neither stored nor read within
//! the days kept, and markers without their artifact.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use anyhow::{Result, bail};
use axum::Router;
use axum::body::Body;
use axum::extract::{Path as Route, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use futures::{StreamExt as _, TryStreamExt as _};
use object_store::path::Path;
use object_store::{
    Attribute, AttributeValue, Attributes, ObjectStore, PutMultipartOptions, PutPayload,
    WriteMultipart,
};

/// How often unused artifacts are looked for.
pub const SWEEP_EVERY: Duration = Duration::from_secs(6 * 3600);
/// How old an artifact is before a read of it is marked.
const MARK_AFTER: Duration = Duration::from_secs(24 * 3600);
/// Turborepo's headers an artifact keeps.
const TAG: &str = "x-artifact-tag";
const DURATION: &str = "x-artifact-duration";

/// The cache of one pool.
#[derive(Debug)]
pub struct Cache {
    store: Arc<dyn ObjectStore>,
    prefix: Path,
    token: String,
    /// Artifacts neither stored nor read in this long are deleted.
    keep: Duration,
}

/// Opens `gs://bucket/prefix`, `s3://bucket/prefix` or
/// `az://container/prefix` with the provider's usual credential chain,
/// as the archive is.
pub fn open(url: &str) -> Result<(Arc<dyn ObjectStore>, Path)> {
    use object_store::aws::AmazonS3Builder;
    use object_store::azure::MicrosoftAzureBuilder;
    use object_store::gcp::GoogleCloudStorageBuilder;

    let Some((scheme, rest)) = url.split_once("://") else {
        bail!("{url:?} is not a store; use gs://, az:// or s3://");
    };
    let (bucket, prefix) = rest.split_once('/').unwrap_or((rest, ""));
    let store: Arc<dyn ObjectStore> = match scheme {
        "gs" => Arc::new(
            GoogleCloudStorageBuilder::from_env()
                .with_bucket_name(bucket)
                .build()?,
        ),
        "s3" => Arc::new(
            AmazonS3Builder::from_env()
                .with_bucket_name(bucket)
                .build()?,
        ),
        "az" => Arc::new(
            MicrosoftAzureBuilder::from_env()
                .with_container_name(bucket)
                .build()?,
        ),
        _ => bail!("{url:?} is not a store; use gs://, az:// or s3://"),
    };
    Ok((store, Path::from(prefix.trim_matches('/'))))
}

/// Whether `hash` is an artifact's name: 1 to 128 letters, digits, `-` and `_`.
fn valid_hash(hash: &str) -> bool {
    (1..=128).contains(&hash.len())
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

/// Whether `given` is `want`, taking as long whatever their first difference.
fn same_secret(given: &[u8], want: &[u8]) -> bool {
    given.len() == want.len()
        && given
            .iter()
            .zip(want)
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

impl Cache {
    /// The cache under `prefix` of `store`, for bearers of `token`.
    #[must_use]
    pub fn new(store: Arc<dyn ObjectStore>, prefix: Path, token: String, keep: Duration) -> Self {
        Self {
            store,
            prefix,
            token,
            keep,
        }
    }

    fn artifact(&self, hash: &str) -> Path {
        self.prefix.child("artifacts").child(hash)
    }

    fn marker(&self, hash: &str) -> Path {
        self.prefix.child("read").child(hash)
    }

    /// The API, behind its token.
    pub fn router(self: Arc<Self>) -> Router {
        Router::new()
            .route("/v8/artifacts/status", get(status))
            .route("/v8/artifacts/events", post(events))
            .route("/v8/artifacts/{hash}", get(fetch).head(probe).put(put))
            .route_layer(middleware::from_fn_with_state(Arc::clone(&self), bearer))
            .with_state(self)
    }

    /// Marks a read of `hash`, stored at `stored`, when it is old enough
    /// to need one and has none as recent.
    async fn mark(&self, hash: &str, stored: SystemTime) {
        let now = SystemTime::now();
        let old = |at: SystemTime| now.duration_since(at).is_ok_and(|age| age >= MARK_AFTER);
        if !old(stored) {
            return;
        }
        let marker = self.marker(hash);
        let due = match self.store.head(&marker).await {
            Ok(meta) => old(meta.last_modified.into()),
            Err(object_store::Error::NotFound { .. }) => true,
            Err(error) => {
                tracing::warn!(%hash, %error, "reading a cache read marker failed");
                false
            }
        };
        if due && let Err(error) = self.store.put(&marker, PutPayload::default()).await {
            tracing::warn!(%hash, %error, "marking a cache read failed");
        }
    }

    /// Deletes artifacts neither stored nor read within the days kept,
    /// and markers whose artifact is gone. Answers how many artifacts went.
    /// One stored or read again while the sweep runs may go too: a cache
    /// miss, at worst.
    pub async fn sweep(&self) -> Result<usize> {
        let Some(before) = SystemTime::now().checked_sub(self.keep) else {
            return Ok(0);
        };
        let latest = |area: &'static str| {
            let prefix = self.prefix.child(area);
            async move {
                let mut found = BTreeMap::new();
                let mut listed = self.store.list(Some(&prefix));
                while let Some(meta) = listed.try_next().await? {
                    if let Some(hash) = meta.location.filename() {
                        found.insert(hash.to_owned(), SystemTime::from(meta.last_modified));
                    }
                }
                anyhow::Ok(found)
            }
        };
        let artifacts = latest("artifacts").await?;
        let reads = latest("read").await?;
        let mut doomed = Vec::new();
        let mut gone = 0;
        for (hash, stored) in &artifacts {
            let used = reads.get(hash).map_or(*stored, |read| (*read).max(*stored));
            if used < before {
                gone += 1;
                doomed.push(self.artifact(hash));
                if reads.contains_key(hash) {
                    doomed.push(self.marker(hash));
                }
            }
        }
        doomed.extend(
            reads
                .keys()
                .filter(|hash| !artifacts.contains_key(*hash))
                .map(|hash| self.marker(hash)),
        );
        let mut deleted = self
            .store
            .delete_stream(futures::stream::iter(doomed.into_iter().map(Ok)).boxed());
        while let Some(result) = deleted.next().await {
            match result {
                Ok(_) | Err(object_store::Error::NotFound { .. }) => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(gone)
    }
}

async fn bearer(State(cache): State<Arc<Cache>>, request: Request, next: Next) -> Response {
    let given = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or("");
    if same_secret(given.as_bytes(), cache.token.as_bytes()) {
        next.run(request).await
    } else {
        StatusCode::UNAUTHORIZED.into_response()
    }
}

async fn status() -> Response {
    json(StatusCode::OK, &serde_json::json!({"status": "enabled"}))
}

async fn events() -> StatusCode {
    StatusCode::OK
}

fn json(status: StatusCode, value: &serde_json::Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        value.to_string(),
    )
        .into_response()
}

fn failed(what: &str, error: &object_store::Error) -> Response {
    tracing::warn!(%error, "{what} failed");
    StatusCode::BAD_GATEWAY.into_response()
}

/// The headers an artifact kept.
fn kept_headers(attributes: &Attributes, headers: &mut HeaderMap) {
    for (name, attribute) in [(TAG, "artifact-tag"), (DURATION, "artifact-duration")] {
        if let Some(value) = attributes.get(&Attribute::Metadata(attribute.into()))
            && let Ok(value) = HeaderValue::from_str(value.as_ref())
        {
            headers.insert(name, value);
        }
    }
}

async fn fetch(State(cache): State<Arc<Cache>>, Route(hash): Route<String>) -> Response {
    if !valid_hash(&hash) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let found = match cache.store.get(&cache.artifact(&hash)).await {
        Ok(found) => found,
        Err(object_store::Error::NotFound { .. }) => return StatusCode::NOT_FOUND.into_response(),
        Err(error) => return failed("reading a cache artifact", &error),
    };
    cache.mark(&hash, found.meta.last_modified.into()).await;
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(found.meta.size));
    kept_headers(&found.attributes, &mut headers);
    (headers, Body::from_stream(found.into_stream())).into_response()
}

async fn probe(State(cache): State<Arc<Cache>>, Route(hash): Route<String>) -> Response {
    if !valid_hash(&hash) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    match cache.store.head(&cache.artifact(&hash)).await {
        Ok(meta) => {
            let mut headers = HeaderMap::new();
            headers.insert(header::CONTENT_LENGTH, HeaderValue::from(meta.size));
            (StatusCode::OK, headers).into_response()
        }
        Err(object_store::Error::NotFound { .. }) => StatusCode::NOT_FOUND.into_response(),
        Err(error) => failed("reading a cache artifact's size", &error),
    }
}

async fn put(
    State(cache): State<Arc<Cache>>,
    Route(hash): Route<String>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    if !valid_hash(&hash) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let mut attributes = Attributes::new();
    for (name, attribute) in [(TAG, "artifact-tag"), (DURATION, "artifact-duration")] {
        if let Some(value) = headers.get(name).and_then(|value| value.to_str().ok()) {
            attributes.insert(
                Attribute::Metadata(attribute.into()),
                AttributeValue::from(value.to_owned()),
            );
        }
    }
    let upload = match cache
        .store
        .put_multipart_opts(
            &cache.artifact(&hash),
            PutMultipartOptions {
                attributes,
                ..PutMultipartOptions::default()
            },
        )
        .await
    {
        Ok(upload) => upload,
        Err(error) => return failed("storing a cache artifact", &error),
    };
    let mut writer = WriteMultipart::new(upload);
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(chunk) => {
                if let Err(error) = writer.wait_for_capacity(4).await {
                    return failed("storing a cache artifact", &error);
                }
                writer.write(&chunk);
            }
            Err(error) => {
                tracing::info!(%hash, %error, "an artifact's upload ended early; nothing is stored");
                let _ = writer.abort().await;
                return StatusCode::BAD_REQUEST.into_response();
            }
        }
    }
    match writer.finish().await {
        Ok(_) => json(StatusCode::ACCEPTED, &serde_json::json!({"urls": [hash]})),
        Err(error) => failed("storing a cache artifact", &error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_are_plain_names() {
        for hash in ["0123abcd", "a-b_c", &"f".repeat(128)] {
            assert!(valid_hash(hash), "{hash}");
        }
        for hash in ["", "../x", "a/b", "a.b", &"f".repeat(129)] {
            assert!(!valid_hash(hash), "{hash}");
        }
    }

    #[test]
    fn secrets_compare_whole() {
        assert!(same_secret(b"token", b"token"));
        assert!(!same_secret(b"toke", b"token"));
        assert!(!same_secret(b"tokem", b"token"));
        assert!(!same_secret(b"", b"token"));
    }
}
