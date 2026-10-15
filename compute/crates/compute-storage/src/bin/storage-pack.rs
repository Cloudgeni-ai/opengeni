//! Upload one immutable image as fixed, independently compressed chunks.
use compute_storage::{
    Result,
    chunk::EncodedChunk,
    manifest::{DiskManifest, Extent, ExtentSource},
    store::{ChunkStore, provider_from_env},
};
use futures::{StreamExt, stream};
use object_store::path::Path;
use serde_json::json;
use std::{env, fs::File, io::Read, time::Instant};

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = env::args().collect();
    if args.len() != 5 {
        eprintln!("usage: storage-pack PROVIDER PREFIX IMAGE LOCAL_MANIFEST");
        std::process::exit(2);
    }
    let store = ChunkStore::new(provider_from_env(&args[1])?, Path::from(args[2].as_str()));
    let mut file = File::open(&args[3])?;
    let size = file.metadata()?.len();
    let mut manifest = DiskManifest {
        version: 1,
        disk_len: size,
        base_len: 0,
        base_digest: "0".repeat(64),
        extents: Vec::new(),
    };
    let mut buffer = vec![0; 262_144];
    let mut pos = 0;
    let mut uploads = Vec::new();
    let mut new_objects = 0;
    let mut stored_bytes = 0_u64;
    let start = Instant::now();
    while pos < size {
        let n = usize::try_from((size - pos).min(buffer.len() as u64)).unwrap();
        file.read_exact(&mut buffer[..n])?;
        let source = if buffer[..n].iter().all(|b| *b == 0) {
            ExtentSource::Zero
        } else {
            let chunk = EncodedChunk::encode(&buffer[..n], 1)?;
            stored_bytes += u64::from(chunk.reference.stored_len);
            let reference = chunk.reference.clone();
            uploads.push(chunk);
            ExtentSource::Chunk {
                reference,
                offset: 0,
            }
        };
        manifest.extents.push(Extent {
            offset: pos,
            length: n as u64,
            source,
        });
        pos += n as u64;
        if uploads.len() >= 32 || pos == size {
            let results: Vec<_> = stream::iter(uploads.drain(..))
                .map(|chunk| {
                    let store = store.clone();
                    async move { store.put_chunk(&chunk).await }
                })
                .buffer_unordered(16)
                .collect()
                .await;
            for result in results {
                if result? {
                    new_objects += 1;
                }
            }
        }
    }
    let digest = store.put_manifest(&manifest).await?;
    std::fs::write(&args[4], manifest.encode()?)?;
    println!(
        "{}",
        json!({"disk_bytes":size,"stored_bytes_including_duplicates":stored_bytes,"new_objects":new_objects,
        "manifest_digest":digest,"elapsed_ms":start.elapsed().as_secs_f64()*1000.0})
    );
    Ok(())
}
