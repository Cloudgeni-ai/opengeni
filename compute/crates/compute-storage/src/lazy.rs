//! On-demand verified chunk reads with a bounded plaintext cache.
//!
//! Caller-provided immutable base reads remain a separate integration boundary;
//! this prototype supports fully materialized chunk/zero maps only. Missing or
//! corrupt chunks are errors, never fabricated zero-filled successful reads.
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use tokio::sync::Mutex;

use crate::{
    Error, Result,
    manifest::{DiskManifest, ExtentSource},
    store::ChunkStore,
};

#[derive(Debug, Default)]
struct Cache {
    bytes: usize,
    data: HashMap<String, Arc<Vec<u8>>>,
    fifo: VecDeque<String>,
}

#[derive(Debug)]
pub struct LazyReader {
    manifest: DiskManifest,
    store: ChunkStore,
    cache: Mutex<Cache>,
    cache_bytes: usize,
    fetched_bytes: AtomicU64,
    fetched_objects: AtomicU64,
}

impl LazyReader {
    pub fn new(manifest: DiskManifest, store: ChunkStore, cache_bytes: usize) -> Result<Self> {
        manifest.validate()?;
        if manifest
            .extents
            .iter()
            .any(|e| matches!(e.source, ExtentSource::Base { .. }))
        {
            return Err(Error::Invalid("lazy prototype requires chunk/zero map"));
        }
        Ok(Self {
            manifest,
            store,
            cache: Mutex::new(Cache::default()),
            cache_bytes,
            fetched_bytes: AtomicU64::new(0),
            fetched_objects: AtomicU64::new(0),
        })
    }

    #[must_use]
    pub fn disk_len(&self) -> u64 {
        self.manifest.disk_len
    }

    #[must_use]
    pub fn fetched(&self) -> (u64, u64) {
        (
            self.fetched_objects.load(Ordering::Relaxed),
            self.fetched_bytes.load(Ordering::Relaxed),
        )
    }

    pub async fn read(&self, offset: u64, output: &mut [u8]) -> Result<()> {
        let end = offset
            .checked_add(output.len() as u64)
            .ok_or(Error::Invalid("read overflow"))?;
        if end > self.manifest.disk_len {
            return Err(Error::Invalid("read past disk"));
        }
        let first = self
            .manifest
            .extents
            .partition_point(|e| e.offset + e.length <= offset);
        for extent in &self.manifest.extents[first..] {
            if extent.offset >= end {
                break;
            }
            let lo = offset.max(extent.offset);
            let hi = end.min(extent.offset + extent.length);
            let destination = &mut output[usize::try_from(lo - offset)
                .map_err(|_| Error::Invalid("read index"))?
                ..usize::try_from(hi - offset).map_err(|_| Error::Invalid("read index"))?];
            match &extent.source {
                ExtentSource::Zero => destination.fill(0),
                ExtentSource::Base { .. } => {
                    return Err(Error::Invalid("base integration unavailable"));
                }
                ExtentSource::Chunk {
                    reference,
                    offset: chunk_offset,
                } => {
                    let key = reference.key();
                    let cached = self.cache.lock().await.data.get(&key).cloned();
                    let data = if let Some(data) = cached {
                        data
                    } else {
                        // I/O never holds the cache lock. Simultaneous misses may
                        // duplicate GETs; an in-flight coalescer is future work.
                        let data = Arc::new(self.store.get_chunk(reference).await?);
                        self.fetched_objects.fetch_add(1, Ordering::Relaxed);
                        self.fetched_bytes
                            .fetch_add(u64::from(reference.stored_len), Ordering::Relaxed);
                        let mut cache = self.cache.lock().await;
                        if data.len() <= self.cache_bytes && !cache.data.contains_key(&key) {
                            while cache.bytes + data.len() > self.cache_bytes {
                                let Some(old) = cache.fifo.pop_front() else {
                                    break;
                                };
                                if let Some(old) = cache.data.remove(&old) {
                                    cache.bytes -= old.len();
                                }
                            }
                            cache.bytes += data.len();
                            cache.fifo.push_back(key.clone());
                            cache.data.insert(key, data.clone());
                        }
                        data
                    };
                    let start = usize::try_from(lo - extent.offset + u64::from(*chunk_offset))
                        .map_err(|_| Error::Invalid("chunk index"))?;
                    destination.copy_from_slice(&data[start..start + destination.len()]);
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{chunk::EncodedChunk, manifest::Extent};
    use object_store::{memory::InMemory, path::Path};

    #[tokio::test]
    async fn unaligned_cross_extent_reads_and_cache() {
        let store = ChunkStore::new(Arc::new(InMemory::new()), Path::from("test"));
        let chunk = EncodedChunk::encode(&[1, 2, 3, 4], 1).unwrap();
        store.put_chunk(&chunk).await.unwrap();
        let manifest = DiskManifest {
            version: 1,
            disk_len: 8,
            base_len: 0,
            base_digest: "0".repeat(64),
            extents: vec![
                Extent {
                    offset: 0,
                    length: 4,
                    source: ExtentSource::Chunk {
                        reference: chunk.reference.clone(),
                        offset: 0,
                    },
                },
                Extent {
                    offset: 4,
                    length: 4,
                    source: ExtentSource::Zero,
                },
            ],
        };
        let reader = LazyReader::new(manifest.clone(), store, 4).unwrap();
        let mut out = [9; 4];
        reader.read(2, &mut out).await.unwrap();
        assert_eq!(out, [3, 4, 0, 0]);
        reader.read(2, &mut out).await.unwrap();
        assert_eq!(reader.fetched().0, 1);
        assert!(reader.read(7, &mut out).await.is_err());
        let missing = LazyReader::new(
            manifest,
            ChunkStore::new(Arc::new(InMemory::new()), Path::from("test")),
            4,
        )
        .unwrap();
        assert!(missing.read(0, &mut out).await.is_err());
    }
}
