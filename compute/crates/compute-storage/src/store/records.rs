//! What a sweep lists and deletes a piece at a time, and the records it
//! keeps of its own work under [`RECORDS`] (see [`crate::sweep`]).

use std::collections::{HashMap, HashSet};

use bytes::Bytes;
use futures::stream::BoxStream;
use futures::{StreamExt as _, TryStreamExt as _, stream};
use object_store::ObjectMeta;

use super::{Area, ChunkStore, Listed, canonical_day, written};
use crate::{Error, Result};

/// Where a sweep keeps its records, under the store's prefix: keys no
/// writer of chunks, manifests or pointers uses, which a sweep never takes
/// for a chunk or manifest.
pub const RECORDS: &str = "sweep";

impl ChunkStore {
    /// Every object stored under `under`, a key prefix of whole segments
    /// such as `chunks/v2/495000`.
    pub async fn list_under(&self, under: &str) -> Result<Vec<Listed>> {
        self.list_after(under, None).try_collect().await
    }

    /// The objects stored under `under`, as [`Self::list_under`], those
    /// after the key `after` only if given, as the store lists them: a
    /// page at a time, in key order on every store this reads.
    pub fn list_after(&self, under: &str, after: Option<&str>) -> BoxStream<'_, Result<Listed>> {
        let prefix = self.path(under);
        let listed = match after {
            Some(after) => self
                .backend
                .list_with_offset(Some(&prefix), &self.path(after)),
            None => self.backend.list(Some(&prefix)),
        };
        listed.map(move |meta| self.listed(&meta?)).boxed()
    }

    fn listed(&self, meta: &ObjectMeta) -> Result<Listed> {
        let key = meta
            .location
            .prefix_match(&self.prefix)
            .map(|parts| parts.map(|part| part.as_ref().to_owned()))
            .ok_or(Error::Invalid("listed object outside the store"))?
            .collect::<Vec<_>>()
            .join("/");
        Ok(Listed {
            key,
            stored_at: meta.last_modified.into(),
            size: meta.size,
        })
    }

    /// The periods `area` holds objects of, in the layout whose keys name
    /// their period: one listing by delimiter, which names each period
    /// once however many objects it holds.
    pub async fn periods(&self, area: Area) -> Result<Vec<u32>> {
        let prefix = self.path(area.periodic());
        let listed = self.backend.list_with_delimiter(Some(&prefix)).await?;
        Ok(listed
            .common_prefixes
            .iter()
            .filter_map(|path| path.filename().and_then(canonical_day))
            .collect())
    }

    /// Deletes the chunks and manifests at `keys` (as a listing gives
    /// them) as [`Self::delete`] does each, up to a thousand to a request
    /// where the store deletes in bulk: the keys it deleted or found gone.
    /// A key missing from the answer was not deleted, as far as anyone can
    /// tell, and may be tried again.
    pub async fn delete_all(&self, keys: &[String]) -> Result<HashSet<String>> {
        if keys.iter().any(|key| written(key).is_none()) {
            return Err(Error::Invalid("only chunks and manifests are deleted"));
        }
        Ok(self.delete_paths(keys).await)
    }

    /// The record a sweep keeps under `key` (below [`RECORDS`]), if any.
    pub async fn get_record(&self, key: &str) -> Result<Option<Bytes>> {
        match self.backend.get(&self.record_path(key)?).await {
            Ok(found) => Ok(Some(found.bytes().await?)),
            Err(object_store::Error::NotFound { .. }) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// Keeps `bytes` as the record under `key` (below [`RECORDS`]),
    /// replacing any.
    pub async fn put_record(&self, key: &str, bytes: Bytes) -> Result<()> {
        self.backend
            .put(&self.record_path(key)?, bytes.into())
            .await?;
        Ok(())
    }

    /// The keys (below [`RECORDS`]) of every record under `under`.
    pub async fn list_records(&self, under: &str) -> Result<Vec<String>> {
        let records = format!("{RECORDS}/");
        Ok(self
            .list_under(&format!("{RECORDS}/{under}"))
            .await?
            .into_iter()
            .filter_map(|listed| listed.key.strip_prefix(&records).map(str::to_owned))
            .collect())
    }

    /// Deletes the records under `keys` (below [`RECORDS`]): those it
    /// deleted or found gone.
    pub async fn delete_records(&self, keys: &[String]) -> Result<HashSet<String>> {
        let full: Vec<String> = keys.iter().map(|key| format!("{RECORDS}/{key}")).collect();
        for key in keys {
            self.record_path(key)?;
        }
        let records = format!("{RECORDS}/");
        Ok(self
            .delete_paths(&full)
            .await
            .into_iter()
            .filter_map(|key| key.strip_prefix(&records).map(str::to_owned))
            .collect())
    }

    fn record_path(&self, key: &str) -> Result<object_store::path::Path> {
        if key.is_empty() || key.split('/').any(|part| part.is_empty() || part == "..") {
            return Err(Error::Invalid("a sweep record's key"));
        }
        Ok(self.path(&format!("{RECORDS}/{key}")))
    }

    /// Deletes `keys` with no condition, in bulk where the store can: the
    /// keys deleted or found gone.
    async fn delete_paths(&self, keys: &[String]) -> HashSet<String> {
        let by_path: HashMap<String, &String> = keys
            .iter()
            .map(|key| (self.path(key).to_string(), key))
            .collect();
        let paths = keys
            .iter()
            .map(|key| Ok(self.path(key)))
            .collect::<Vec<_>>();
        self.backend
            .delete_stream(stream::iter(paths).boxed())
            .filter_map(|deleted| {
                let path = match deleted {
                    Ok(path) => Some(path.to_string()),
                    Err(object_store::Error::NotFound { path, .. }) => Some(path),
                    Err(error) => {
                        tracing::warn!(%error, "a sweep's delete failed; it is tried again");
                        None
                    }
                };
                let key = path.and_then(|path| by_path.get(&path).map(|key| (*key).clone()));
                std::future::ready(key)
            })
            .collect()
            .await
    }
}
