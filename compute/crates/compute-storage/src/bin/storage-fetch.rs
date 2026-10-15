//! Fetch a verified manifest, or reconstruct one small state object.
use compute_storage::{
    Error, Result,
    lazy::LazyReader,
    store::{ChunkStore, provider_from_env},
};
use object_store::path::Path;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    if !(5..=6).contains(&args.len()) {
        eprintln!("usage: storage-fetch PROVIDER PREFIX DIGEST OUTPUT [--image]");
        std::process::exit(2);
    }
    let store = ChunkStore::new(provider_from_env(&args[1])?, Path::from(args[2].as_str()));
    let manifest = store.get_manifest(&args[3]).await?;
    let bytes = if args.get(5).is_some_and(|s| s == "--image") {
        if manifest.disk_len > 16 * 1024 * 1024 {
            return Err(Error::Invalid("state image too large"));
        }
        let mut bytes =
            vec![0; usize::try_from(manifest.disk_len).map_err(|_| Error::Invalid("state size"))?];
        LazyReader::new(manifest, store, 0)?
            .read(0, &mut bytes)
            .await?;
        bytes
    } else {
        manifest.encode()?
    };
    std::fs::write(&args[4], bytes)?;
    Ok(())
}
