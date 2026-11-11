//! Sandbox images built from OCI images (ADR 19).
//!
//! A build pulls an image for Linux amd64 from any registry
//! ([`registry`]), applies its layers to a directory ([`layers`]), adds
//! what every sandbox image gets ([`assemble`]: `compute-guest` as init,
//! envd, bash and E2B's `user` when the image lacks them, and the image's
//! config for the guest) and makes an ext4 file of it ([`ext4`]). It runs
//! as root, so files keep their owners.

pub mod assemble;
pub mod ext4;
pub mod layers;
pub mod reference;
pub mod registry;
pub mod rootpath;

use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context as _, Result};
use compute_guest::config::ImageConfig;
use serde::Serialize;

pub use reference::Reference;
pub use registry::Credentials;

/// What to build.
#[derive(Debug, Clone)]
pub struct Build {
    pub reference: Reference,
    pub credentials: Option<Credentials>,
    /// The directory `guest/build.sh` made: `compute-guest`, `envd`, `bash`.
    pub guest: PathBuf,
    /// Scratch space for layers and the unpacked root; emptied afterwards.
    pub work: PathBuf,
    pub output: PathBuf,
    /// Free space the file system leaves for sandboxes.
    pub free_bytes: u64,
}

/// What a build made.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Built {
    pub reference: String,
    /// The digest of the image manifest that was built.
    pub manifest_digest: String,
    pub config: ImageConfig,
    pub added: assemble::Added,
    /// The ext4 file's size, and how much of it the contents use.
    pub size_bytes: u64,
    pub content_bytes: u64,
    pub layers: usize,
    pub pull_seconds: f64,
    pub unpack_seconds: f64,
    pub ext4_seconds: f64,
}

/// Builds `build.output` from `build.reference`.
pub async fn build(build: &Build) -> Result<Built> {
    let started = Instant::now();
    let blobs = build.work.join("blobs");
    let root = build.work.join("root");
    remove_dir(&root)?;
    let registry = registry::Registry::new(build.credentials.clone())?;
    let pulled = registry
        .pull(&build.reference, &blobs)
        .await
        .with_context(|| format!("pull {}", build.reference))?;
    let pulled_at = Instant::now();
    let config = assemble::image_config(pulled.image.config.as_ref());
    let (added, unpacked_at, size, contents) = {
        let (root, guest, output) = (root.clone(), build.guest.clone(), build.output.clone());
        let (layers, config, free) = (pulled.layers.clone(), config.clone(), build.free_bytes);
        tokio::task::spawn_blocking(move || -> Result<_> {
            std::fs::create_dir_all(&root)?;
            layers::apply_all(&root, &layers)?;
            let added = assemble::finish(&root, &guest, &config)?;
            let unpacked_at = Instant::now();
            let contents = ext4::measure(&root)?;
            let size = ext4::make(&root, &output, free)?;
            Ok((added, unpacked_at, size, contents))
        })
        .await??
    };
    let done = Instant::now();
    remove_dir(&root)?;
    remove_dir(&blobs)?;
    Ok(Built {
        reference: build.reference.to_string(),
        manifest_digest: pulled.manifest_digest,
        config,
        added,
        size_bytes: size,
        content_bytes: contents.bytes,
        layers: pulled.layers.len(),
        pull_seconds: (pulled_at - started).as_secs_f64(),
        unpack_seconds: (unpacked_at - pulled_at).as_secs_f64(),
        ext4_seconds: (done - unpacked_at).as_secs_f64(),
    })
}

fn remove_dir(path: &Path) -> Result<()> {
    match std::fs::remove_dir_all(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    }
}
