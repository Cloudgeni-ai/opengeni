//! A Google Cloud Storage stand-in for tests. It answers both the XML API
//! the checksummed uploads use and, as an `object_store` backend, listing
//! and reads, over one set of objects, as a real bucket does. It keeps
//! each object's generation and the time it was stored, and checks
//! `x-goog-hash` and `x-goog-if-generation-match` as GCS does.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use async_trait::async_trait;
use bytes::Bytes;
use futures::StreamExt as _;
use futures::stream::{self, BoxStream};
use md5::Digest as _;
use object_store::client::{HttpClient, HttpError, HttpRequest, HttpResponse, HttpService};
use object_store::gcp::GcpCredential;
use object_store::path::Path;
use object_store::{
    Attributes, GetOptions, GetResult, GetResultPayload, ListResult, MultipartUpload, ObjectMeta,
    ObjectStore, PutMode, PutMultipartOptions, PutOptions, PutPayload, PutResult,
    StaticCredentialProvider,
};

use crate::fresh::Clock;
use crate::upload::{Gcs, checksums};

#[derive(Clone, Debug)]
pub(crate) struct Object {
    pub(crate) bytes: Bytes,
    pub(crate) generation: u64,
    pub(crate) at: SystemTime,
}

/// splitmix64, so interleavings replay from a seed.
#[derive(Debug)]
pub(crate) struct Rng(pub(crate) u64);

impl Rng {
    pub(crate) fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    pub(crate) fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound.max(1)
    }
}

/// Decides whether deleting the named object leaves every stored pointer
/// whole, given every stored object.
pub(crate) type Guard = fn(&BTreeMap<String, Object>, &str) -> bool;

#[derive(Debug, Default)]
pub(crate) struct Fake {
    /// By object name, without the bucket.
    objects: Mutex<BTreeMap<String, Object>>,
    generations: Mutex<u64>,
    pub(crate) clock: Clock,
    /// Corrupts this many of the next uploads in transit.
    pub(crate) corrupt: Mutex<u32>,
    pub(crate) puts: Mutex<u32>,
    /// When set, every request first waits up to this long, as the seeded
    /// sequence picks, so concurrent callers interleave differently.
    latency: Mutex<Option<(Rng, Duration)>>,
    /// When set, a put or delete of a name containing the text waits this
    /// long before it is applied, as a request held up in flight would,
    /// and is applied even if its caller stopped waiting; `held` counts
    /// those that started waiting.
    pub(crate) stall: Mutex<Option<(&'static str, Duration)>>,
    pub(crate) held: Mutex<u32>,
    /// Asked before every delete through the XML API; the names of deletes
    /// it refused are kept in `violations` (and deleted all the same).
    pub(crate) guard: Mutex<Option<Guard>>,
    pub(crate) violations: Mutex<Vec<String>>,
    /// When set, an object's entity tag is the MD5 of its bytes, as on S3,
    /// so the same bytes stored again have the same tag; otherwise it is
    /// the generation, as on GCS.
    pub(crate) tags_follow_bytes: Mutex<bool>,
}

impl Fake {
    pub(crate) fn new(clock: Clock) -> Arc<Self> {
        Arc::new(Self {
            clock,
            ..Self::default()
        })
    }

    pub(crate) fn with_latency(self: &Arc<Self>, seed: u64, most: Duration) {
        *self.latency.lock().unwrap() = Some((Rng(seed), most));
    }

    pub(crate) fn bytes(&self, name: &str) -> Option<Bytes> {
        self.object(name).map(|object| object.bytes)
    }

    pub(crate) fn object(&self, name: &str) -> Option<Object> {
        self.objects.lock().unwrap().get(name).cloned()
    }

    pub(crate) fn names(&self) -> Vec<String> {
        self.objects.lock().unwrap().keys().cloned().collect()
    }

    /// Stores `bytes` under `name` as a new generation, with no checks.
    pub(crate) fn put_raw(&self, name: &str, bytes: Bytes) -> u64 {
        let mut objects = self.objects.lock().unwrap();
        self.store(&mut objects, name, bytes)
    }

    fn store(&self, objects: &mut BTreeMap<String, Object>, name: &str, bytes: Bytes) -> u64 {
        let generation = {
            let mut generations = self.generations.lock().unwrap();
            *generations += 1;
            *generations
        };
        objects.insert(
            name.to_owned(),
            Object {
                bytes,
                generation,
                at: self.clock.now(),
            },
        );
        generation
    }

    async fn wait(&self) {
        let pause = self.latency.lock().unwrap().as_mut().map(|(rng, most)| {
            let thousandths = u32::try_from(rng.below(1_001)).unwrap();
            *most * thousandths / 1_000
        });
        if let Some(pause) = pause {
            tokio::time::sleep(pause).await;
        }
    }

    /// How long a request for `name` is held up, counting it as held.
    fn stalled(&self, name: &str) -> Option<Duration> {
        let stall = *self.stall.lock().unwrap();
        let (_, stall) = stall.filter(|(part, _)| name.contains(part))?;
        *self.held.lock().unwrap() += 1;
        Some(stall)
    }

    /// Applies `apply` after `stall`, if any, on a task of its own, so it
    /// lands even when the caller stops waiting for the answer.
    async fn after<T, F>(self: &Arc<Self>, stall: Option<Duration>, apply: F) -> T
    where
        T: Send + 'static,
        F: FnOnce(&Self) -> T + Send + 'static,
    {
        let Some(stall) = stall else {
            return apply(self);
        };
        let fake = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(stall).await;
            apply(&fake)
        })
        .await
        .expect("a held request panicked")
    }

    /// A delete through the XML API, on condition of `generation_match`.
    fn delete(&self, name: &str, generation_match: Option<u64>) -> HttpResponse {
        let mut objects = self.objects.lock().unwrap();
        let current = objects.get(name).map(|object| object.generation);
        match (current, generation_match) {
            (None, _) => reply(404, ""),
            (Some(current), Some(wanted)) if current != wanted => reply(412, ""),
            (Some(_), _) => {
                let guard = *self.guard.lock().unwrap();
                if guard.is_some_and(|guard| !guard(&objects, name)) {
                    self.violations.lock().unwrap().push(name.to_owned());
                }
                objects.remove(name);
                reply(204, "")
            }
        }
    }

    /// A put through `object_store`, under `mode`'s condition.
    fn put(
        &self,
        location: &Path,
        payload: PutPayload,
        mode: PutMode,
    ) -> object_store::Result<PutResult> {
        let mut objects = self.objects.lock().unwrap();
        match mode {
            PutMode::Create if objects.contains_key(location.as_ref()) => {
                return Err(object_store::Error::AlreadyExists {
                    path: location.to_string(),
                    source: "exists".into(),
                });
            }
            PutMode::Update(version) => {
                let current = objects
                    .get(location.as_ref())
                    .map(|object| self.tag(object));
                if current.is_none() || current != version.e_tag {
                    return Err(object_store::Error::Precondition {
                        path: location.to_string(),
                        source: "entity tag does not match".into(),
                    });
                }
            }
            PutMode::Overwrite | PutMode::Create => {}
        }
        self.store(&mut objects, location.as_ref(), payload.into());
        let meta = self.meta(location.as_ref(), &objects[location.as_ref()]);
        Ok(PutResult {
            e_tag: meta.e_tag,
            version: meta.version,
        })
    }

    /// `object`'s entity tag; see [`Self::tags_follow_bytes`].
    fn tag(&self, object: &Object) -> String {
        if *self.tags_follow_bytes.lock().unwrap() {
            format!("{:x}", md5::Md5::digest(&object.bytes))
        } else {
            object.generation.to_string()
        }
    }

    fn meta(&self, name: &str, object: &Object) -> ObjectMeta {
        let follow = *self.tags_follow_bytes.lock().unwrap();
        ObjectMeta {
            location: Path::from(name),
            last_modified: object.at.into(),
            size: object.bytes.len() as u64,
            e_tag: Some(self.tag(object)),
            // S3 without versioning names no version.
            version: (!follow).then(|| object.generation.to_string()),
        }
    }
}

/// The XML API, as [`Gcs`] calls it.
#[derive(Debug)]
struct Service(Arc<Fake>);

fn reply(status: u16, body: &str) -> HttpResponse {
    http::Response::builder()
        .status(status)
        .body(Bytes::from(body.to_owned()).into())
        .unwrap()
}

#[async_trait]
impl HttpService for Service {
    async fn call(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
        let fake = &self.0;
        fake.wait().await;
        let (parts, body) = request.into_parts();
        let name = parts
            .uri
            .path()
            .strip_prefix("/bucket/")
            .unwrap()
            .to_owned();
        let generation_match = parts
            .headers
            .get("x-goog-if-generation-match")
            .map(|value| value.to_str().unwrap().parse::<u64>().unwrap());
        if parts.method == http::Method::DELETE {
            let stall = fake.stalled(&name);
            return Ok(fake
                .after(stall, move |fake| fake.delete(&name, generation_match))
                .await);
        }
        let mut objects = fake.objects.lock().unwrap();
        let current = objects.get(&name).map(|object| object.generation);
        match parts.method {
            http::Method::HEAD => Ok(match objects.get(&name) {
                None => reply(404, ""),
                Some(object) => {
                    let hashes = checksums(&object.bytes);
                    let (crc, md5) = hashes.split_once(',').unwrap();
                    let at = chrono::DateTime::<chrono::Utc>::from(object.at);
                    http::Response::builder()
                        .status(200)
                        .header("x-goog-hash", crc)
                        .header("x-goog-hash", md5)
                        .header("x-goog-generation", object.generation.to_string())
                        .header(http::header::LAST_MODIFIED, at.to_rfc2822())
                        .body(Bytes::new().into())
                        .unwrap()
                }
            }),
            http::Method::PUT => {
                *fake.puts.lock().unwrap() += 1;
                let mut bytes = Bytes::from(body.as_bytes().unwrap().to_vec());
                {
                    let mut corrupt = fake.corrupt.lock().unwrap();
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
                if generation_match.is_some_and(|wanted| current.unwrap_or(0) != wanted) {
                    return Ok(reply(412, ""));
                }
                fake.store(&mut objects, &name, bytes);
                Ok(reply(200, ""))
            }
            method => panic!("the fake does not serve {method}"),
        }
    }
}

/// A [`Gcs`] client of `fake`'s bucket `bucket`.
pub(crate) fn gcs(fake: &Arc<Fake>) -> Gcs {
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

/// The same bucket as an `object_store` backend.
#[derive(Debug)]
pub(crate) struct Bucket(pub(crate) Arc<Fake>);

impl fmt::Display for Bucket {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("fake bucket")
    }
}

fn not_found(location: &Path) -> object_store::Error {
    object_store::Error::NotFound {
        path: location.to_string(),
        source: "no such object".into(),
    }
}

#[async_trait]
impl ObjectStore for Bucket {
    async fn put_opts(
        &self,
        location: &Path,
        payload: PutPayload,
        opts: PutOptions,
    ) -> object_store::Result<PutResult> {
        self.0.wait().await;
        let stall = self.0.stalled(location.as_ref());
        let location = location.clone();
        self.0
            .after(stall, move |fake| fake.put(&location, payload, opts.mode))
            .await
    }

    async fn put_multipart_opts(
        &self,
        _: &Path,
        _: PutMultipartOptions,
    ) -> object_store::Result<Box<dyn MultipartUpload>> {
        Err(object_store::Error::NotImplemented)
    }

    async fn get_opts(
        &self,
        location: &Path,
        options: GetOptions,
    ) -> object_store::Result<GetResult> {
        if options.range.is_some() {
            return Err(object_store::Error::NotImplemented);
        }
        self.0.wait().await;
        let object = self
            .0
            .object(location.as_ref())
            .ok_or_else(|| not_found(location))?;
        let meta = self.0.meta(location.as_ref(), &object);
        let bytes = object.bytes;
        Ok(GetResult {
            range: 0..bytes.len() as u64,
            payload: GetResultPayload::Stream(Box::pin(stream::once(async move { Ok(bytes) }))),
            meta,
            attributes: Attributes::default(),
        })
    }

    async fn delete(&self, location: &Path) -> object_store::Result<()> {
        self.0.wait().await;
        self.0.objects.lock().unwrap().remove(location.as_ref());
        Ok(())
    }

    fn list(&self, prefix: Option<&Path>) -> BoxStream<'static, object_store::Result<ObjectMeta>> {
        let prefix = prefix.map(|prefix| format!("{prefix}/"));
        let fake = self.0.clone();
        Box::pin(
            stream::once(async move {
                fake.wait().await;
                let listed: Vec<_> = fake
                    .objects
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|(name, _)| {
                        prefix
                            .as_ref()
                            .is_none_or(|prefix| name.starts_with(prefix))
                    })
                    .map(|(name, object)| Ok(fake.meta(name, object)))
                    .collect();
                stream::iter(listed)
            })
            .flatten(),
        )
    }

    async fn list_with_delimiter(&self, _: Option<&Path>) -> object_store::Result<ListResult> {
        Err(object_store::Error::NotImplemented)
    }

    async fn copy(&self, from: &Path, to: &Path) -> object_store::Result<()> {
        self.0.wait().await;
        let mut objects = self.0.objects.lock().unwrap();
        let bytes = objects
            .get(from.as_ref())
            .map(|object| object.bytes.clone())
            .ok_or_else(|| not_found(from))?;
        self.0.store(&mut objects, to.as_ref(), bytes);
        Ok(())
    }

    async fn copy_if_not_exists(&self, _: &Path, _: &Path) -> object_store::Result<()> {
        Err(object_store::Error::NotImplemented)
    }
}
