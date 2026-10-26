//! Sandbox images in the store: root file systems built from OCI images.
//!
//! An image is known by its id, the BLAKE3 digest of its file. It is stored
//! like any disk, as content-named chunks and a manifest, and a pointer
//! named [`rootfs_pointer`] holds a stored copy with only that disk, which
//! keeps it from sweeps (a sweep already reads such a copy). Like an
//! archive, a store begins its pointer before it stores anything and
//! publishes only if no sweep took stock meanwhile; otherwise it starts
//! again. An image belongs to no host: every store of it uses the same
//! [`IMAGE_STAMP`], so the second store of an image finds it done and
//! uploads nothing. A fetch checks every chunk, then the whole file
//! against the id.

use std::collections::HashMap;
use std::fs::File;
use std::path::Path;

use compute_engine::{CancellationToken, EngineError, ErrorKind};
use compute_storage::Error as StorageError;
use compute_storage::store::Begun;

use super::{Chunked, HEAD_VERSION, Head, OwnerEpoch, Stamp, parse_head, storage_error};
use crate::protocol::ImageId;

/// The stamp every image pointer is published under. Images are named by
/// their content and never change, so no owner fences them: one stamp
/// lets a store tell a stored image (done) from one still in flight
/// (the empty pointer under number 0, which it may publish over).
const IMAGE_STAMP: Stamp = Stamp {
    epoch: OwnerEpoch::FIRST,
    save: 1,
};

/// The pointer that keeps the image `image`.
#[must_use]
pub fn rootfs_pointer(image: ImageId) -> String {
    image.pointer()
}

/// The id of the file at `path`: the BLAKE3 digest of its bytes.
pub async fn file_id(path: &Path) -> Result<ImageId, EngineError> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let mut hasher = blake3::Hasher::new();
        hasher.update_reader(std::io::BufReader::with_capacity(
            1 << 20,
            File::open(&path)?,
        ))?;
        Ok(ImageId(*hasher.finalize().as_bytes()))
    })
    .await
    .map_err(|error| EngineError::caused_by(ErrorKind::Fatal, "hash image", error))?
    .map_err(|error: std::io::Error| EngineError::io("hash image", error))
}

/// Stores refused because a sweep took stock meanwhile, before giving up.
const TRIES: u32 = 3;

impl Chunked {
    /// Stores the image at `path` and returns its id.
    pub async fn put_rootfs(&self, path: &Path) -> Result<ImageId, EngineError> {
        const OP: &str = "store image";
        let digest = file_id(path).await?;
        for _ in 0..TRIES {
            let publication = match self
                .chunks
                .begin(&rootfs_pointer(digest), IMAGE_STAMP)
                .await
                .map_err(|error| storage_error(OP, error))?
            {
                Begun::Publish(publication) => publication,
                // Stored already, by this host or another.
                Begun::Stored(_) => return Ok(digest),
                Begun::Outdated | Begun::Deleted => {
                    return Err(EngineError::new(
                        ErrorKind::Fatal,
                        OP,
                        "the image pointer is not one this store writes",
                    ));
                }
            };
            let disk = self
                .put_file(
                    path,
                    File::open(path),
                    HashMap::new(),
                    None,
                    &CancellationToken::new(),
                )
                .await?
                .ok_or_else(|| EngineError::new(ErrorKind::Fatal, OP, "not stored"))?;
            let head = Head {
                version: HEAD_VERSION,
                disk,
                memory: None,
                profile: None,
                pack: None,
            };
            let bytes = serde_json::to_vec(&head)
                .map_err(|error| EngineError::caused_by(ErrorKind::Fatal, OP, error))?;
            match self.chunks.publish(publication, bytes).await {
                Ok(()) => return Ok(digest),
                Err(StorageError::Superseded) => {
                    tracing::info!(%digest, "a sweep took stock while the image was stored; storing again");
                }
                Err(error) => return Err(storage_error(OP, error)),
            }
        }
        Err(storage_error(OP, StorageError::Superseded))
    }

    /// The head of the stored image `image`, if the store holds it.
    async fn rootfs_head(
        &self,
        op: &'static str,
        image: ImageId,
    ) -> Result<Option<Head>, EngineError> {
        let Some(pointer) = self
            .chunks
            .get_pointer(&rootfs_pointer(image))
            .await
            .map_err(|error| storage_error(op, error))?
            .filter(|pointer| !pointer.is_empty())
        else {
            return Ok(None);
        };
        parse_head(op, &pointer).map(Some)
    }

    /// The length of the stored image `image`'s file, if the store holds
    /// it.
    pub async fn rootfs_len(&self, image: ImageId) -> Result<Option<u64>, EngineError> {
        const OP: &str = "image length";
        let Some(head) = self.rootfs_head(OP, image).await? else {
            return Ok(None);
        };
        let manifest = self
            .chunks
            .get_manifest(&head.disk)
            .await
            .map_err(|error| storage_error(OP, error))?;
        Ok(Some(manifest.disk_len))
    }

    /// Writes the stored image `image` to `path`. False if the store does
    /// not hold it.
    pub async fn get_rootfs(&self, image: ImageId, path: &Path) -> Result<bool, EngineError> {
        const OP: &str = "fetch image";
        let Some(head) = self.rootfs_head(OP, image).await? else {
            return Ok(false);
        };
        self.get_file(&head.disk, path, None).await?;
        let fetched = file_id(path).await?;
        if fetched != image {
            let _ = std::fs::remove_file(path);
            return Err(EngineError::new(
                ErrorKind::Fatal,
                OP,
                format!("image {image} arrived as {fetched}"),
            ));
        }
        Ok(true)
    }
}
