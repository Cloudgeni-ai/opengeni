//! Opening what a starting agent runs on: its state root, with the
//! host's lock and records, its sandbox networking and its sandbox images.

use std::path::PathBuf;
use std::sync::Arc;

use compute_core::Host;

use crate::layout::{self, Images};
use crate::net::{NetworkConfig, Networks};
use crate::pool::PoolConfig;
use crate::rootfs::Cache;
use crate::state::{Ownership, Records, Stray, claim_host};

use super::config::check_config;
use super::{HANDOVER, HostConfig, HostError};

/// Takes the host's lock at `path` for state root `root`; see
/// [`HostConfig::host_lock`].
async fn claim(path: PathBuf, root: PathBuf) -> Result<std::fs::File, HostError> {
    tokio::task::spawn_blocking(move || claim_host(&path, &root, HANDOVER))
        .await
        .map_err(|error| HostError::Io(error.to_string()))?
        .map_err(HostError::from)
}

/// Checks `config` and takes over its state root: its lock, then its
/// records, which must fit the host's images.
pub(super) async fn open_root(
    config: &HostConfig,
) -> Result<(Host, Records, Vec<Stray>, Images), HostError> {
    let core =
        Host::new(config.policy).map_err(|error| HostError::Invalid(format!("{error:?}")))?;
    check_config(config).map_err(HostError::Invalid)?;
    let host_lock = match config.host_lock.clone() {
        Some(path) => Some(claim(path, config.root.clone()).await?),
        None => None,
    };
    let (records, strays) = Records::open(config.root.clone(), HANDOVER, host_lock).await?;
    let images = host_images(config, staged_kernel(config).await);
    check_fit(&images, &records)?;
    Ok((core, records, strays, images))
}

/// The kernel each boot copies into its jail: the agent's own copy of the
/// host's, which it makes now that it holds the state root (see
/// [`layout::stage_kernel`]). Without one, boots copy the host's file, as
/// they always did.
async fn staged_kernel(config: &HostConfig) -> PathBuf {
    let (kernel, root) = (config.kernel.clone(), config.root.clone());
    let staged = tokio::task::spawn_blocking(move || layout::stage_kernel(&kernel, &root))
        .await
        .map_err(|error| std::io::Error::other(error.to_string()))
        .and_then(|staged| staged);
    staged.unwrap_or_else(|error| {
        tracing::warn!(kernel = %config.kernel.display(), %error, "the guest kernel is not staged on the state root; each boot copies it whole");
        config.kernel.clone()
    })
}

/// Checks that this host's settings fit every recorded sandbox: a sandbox
/// keeps the user and addresses it was given, and new ones are handed out
/// by today's settings, which therefore must agree.
fn check_fit(images: &Images, records: &Records) -> Result<(), HostError> {
    let misfits: Vec<String> = records
        .all()
        .iter()
        .filter_map(|record| images.check(record).err())
        .collect();
    if misfits.is_empty() {
        Ok(())
    } else {
        Err(HostError::Invalid(format!(
            "this host's settings do not fit its sandboxes: {}",
            misfits.join("; ")
        )))
    }
}

/// How this host's VMs are laid out, from its settings.
fn host_images(config: &HostConfig, kernel: PathBuf) -> Images {
    Images {
        kernel,
        boot_args: layout::command_line(&config.boot_args, config.network.is_some()),
        first_uid: config.first_uid,
        network: config.network.clone(),
    }
}

/// Sets up the host's sandbox networking, if sandboxes are networked.
pub(super) async fn prepare_network(
    network: Option<NetworkConfig>,
) -> Result<Option<Arc<Networks>>, HostError> {
    let Some(network) = network else {
        return Ok(None);
    };
    let runtime = tokio::runtime::Handle::current();
    let prepared = tokio::task::spawn_blocking(move || Networks::prepare(&network, runtime))
        .await
        .map_err(|error| HostError::Io(error.to_string()))?
        .map_err(|error| HostError::Io(error.to_string()))?;
    Ok(Some(Arc::new(prepared)))
}

/// The host's sandbox images. An image goes unused as long as a template
/// may before it is removed.
pub(super) async fn open_rootfs(
    config: &HostConfig,
    owner: Ownership,
) -> Result<Arc<Cache>, HostError> {
    let dir = crate::layout::rootfs_dir(&config.root);
    let unused_after = config
        .pool
        .as_ref()
        .map_or(PoolConfig::UNUSED_AFTER, |pool| pool.unused_after);
    let cache = tokio::task::spawn_blocking(move || Cache::open(dir, unused_after, owner))
        .await
        .map_err(|error| HostError::Io(error.to_string()))?
        .map_err(|error| HostError::Io(format!("sandbox images: {error}")))?;
    Ok(Arc::new(cache))
}
