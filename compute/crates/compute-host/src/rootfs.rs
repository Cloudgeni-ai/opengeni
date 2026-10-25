//! Sandbox images built from OCI images (ADR 19): the `build-image`
//! command, which builds one and stores it, the builds the control service
//! asks hosts for ([`PrepareConfig`]), and the host's copies of them ([`Cache`]).

mod cache;
mod prepare;

pub(crate) use cache::{Cache, Missing};
pub(crate) use prepare::Preparer;
pub use prepare::{PrepareConfig, PrepareError, Prepared, Progress};

use std::path::PathBuf;

use compute_image::{Build, Credentials, Reference};

use crate::chunked::file_id;
use crate::{Chunked, Directory};

/// What `build-image` takes.
#[derive(Debug, clap::Args)]
pub struct BuildArgs {
    /// The OCI image: `alpine:3.20`, `ghcr.io/owner/name:tag`,
    /// `registry.example/name@sha256:…`.
    reference: String,
    /// The directory `guest/build.sh` made.
    #[arg(long)]
    guest: PathBuf,
    /// The ext4 file to write.
    #[arg(long)]
    output: PathBuf,
    /// Scratch space, kept for the next build; defaults to a directory
    /// beside the output that is removed afterwards.
    #[arg(long)]
    work: Option<PathBuf>,
    /// Free space to leave for sandboxes, in GiB.
    #[arg(long, default_value_t = 4)]
    free_gib: u64,
    /// The user name for the registry's token service. The token or
    /// password comes from the `REGISTRY_TOKEN` environment variable; with
    /// neither, the pull is anonymous.
    #[arg(long)]
    registry_user: Option<String>,
    /// Store the image here, as `serve --store` takes it: an object
    /// storage URL, or a directory on this host.
    #[arg(long)]
    store: Option<String>,
}

/// Builds the image `args` names, stores it if asked, and prints what was
/// built as JSON, with the image's id, which creates name it by.
pub async fn build(args: BuildArgs) -> anyhow::Result<()> {
    let reference = Reference::parse(&args.reference).map_err(anyhow::Error::msg)?;
    let credentials = registry_credentials(args.registry_user)?;
    let (work, scratch) = match args.work {
        Some(work) => (work, false),
        None => (args.output.with_extension("work"), true),
    };
    let built = compute_image::build(&Build {
        reference,
        credentials,
        guest: args.guest,
        work: work.clone(),
        output: args.output.clone(),
        free_bytes: args.free_gib << 30,
    })
    .await;
    if scratch {
        let _ = std::fs::remove_dir_all(&work);
    }
    let built = built?;
    let mut report = serde_json::to_value(&built)?;
    let started = std::time::Instant::now();
    let image = match args.store {
        Some(store) => match Chunked::from_url(&store)? {
            Some(chunked) => chunked.put_rootfs(&args.output).await?,
            None => Directory::new(store).put_rootfs(&args.output).await?,
        },
        None => file_id(&args.output).await?,
    };
    report["image"] = image.to_string().into();
    report["idOrStoreSeconds"] = started.elapsed().as_secs_f64().into();
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

/// The credentials for registries' token services: the token or password
/// in the `REGISTRY_TOKEN` environment variable, for `user` (`token` when
/// not given). `None`, for anonymous pulls, without a token.
///
/// # Errors
///
/// When a user is given without a token.
pub fn registry_credentials(user: Option<String>) -> anyhow::Result<Option<Credentials>> {
    let secret = std::env::var("REGISTRY_TOKEN")
        .ok()
        .filter(|token| !token.is_empty());
    Ok(match (user, secret) {
        (user, Some(secret)) => Some(Credentials {
            username: user.unwrap_or_else(|| "token".to_owned()),
            secret,
        }),
        (Some(_), None) => anyhow::bail!("--registry-user needs REGISTRY_TOKEN"),
        (None, None) => None,
    })
}
