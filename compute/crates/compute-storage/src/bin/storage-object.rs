//! Synthetic same-region object transport measurements. Credentials use the
//! provider builders' standard environment/metadata chains; never log them.
use std::{env, sync::Arc, time::Instant};

use bytes::Bytes;
use futures::{StreamExt, stream};
use object_store::{ObjectStore, path::Path};
use serde_json::json;

fn backend(kind: &str) -> object_store::Result<Arc<dyn ObjectStore>> {
    match kind {
        "gcs" => Ok(Arc::new(
            object_store::gcp::GoogleCloudStorageBuilder::from_env().build()?,
        )),
        "azure" => Ok(Arc::new(
            object_store::azure::MicrosoftAzureBuilder::from_env().build()?,
        )),
        "s3" => Ok(Arc::new(
            object_store::aws::AmazonS3Builder::from_env().build()?,
        )),
        _ => panic!("expected gcs, azure or s3"),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: storage-object PROVIDER UNIQUE_PREFIX");
        std::process::exit(2);
    }
    let store = backend(&args[1])?;
    let prefix = &args[2];
    let mut rng = 0x1234_5678_9abc_def0_u64;
    let payload: Bytes = (0..16 * 1024 * 1024)
        .map(|_| {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            rng.to_le_bytes()[0]
        })
        .collect::<Vec<_>>()
        .into();
    for size in [65536, 262_144, 1_048_576, 4_194_304, 16_777_216] {
        for concurrency in [1, 8, 32] {
            let count = (64 * 1024 * 1024 / size).min(128);
            let paths: Vec<_> = (0..count)
                .map(|i| Path::from(format!("{prefix}/{size}-{concurrency}-{i}")))
                .collect();
            for operation in ["put", "get"] {
                let t = Instant::now();
                let results: Vec<object_store::Result<(f64, f64)>> =
                    stream::iter(paths.iter().cloned())
                        .map(|path| {
                            let store = store.clone();
                            let bytes = payload.slice(..size);
                            async move {
                                let start = Instant::now();
                                let first_ms = if operation == "put" {
                                    store.put(&path, bytes.into()).await?;
                                    0.0
                                } else {
                                    let result = store.get(&path).await?;
                                    let mut body = result.into_stream();
                                    let mut n = 0;
                                    let mut first = None;
                                    while let Some(part) = body.next().await {
                                        let part = part?;
                                        first.get_or_insert_with(|| {
                                            start.elapsed().as_secs_f64() * 1000.0
                                        });
                                        assert_eq!(&part[..], &bytes[n..n + part.len()]);
                                        n += part.len();
                                    }
                                    assert_eq!(n, size);
                                    first.unwrap_or(0.0)
                                };
                                Ok((start.elapsed().as_secs_f64() * 1000.0, first_ms))
                            }
                        })
                        .buffer_unordered(concurrency)
                        .collect()
                        .await;
                let elapsed = t.elapsed().as_secs_f64();
                let samples = results
                    .into_iter()
                    .collect::<object_store::Result<Vec<_>>>()?;
                println!(
                    "{}",
                    json!({"provider":args[1],"operation":operation,"object_bytes":size,"concurrency":concurrency,
                    "objects":count,"seconds":elapsed,"mib_per_second":f64::from(u32::try_from(size*count)?) / 1_048_576.0 / elapsed,"samples_ms":samples})
                );
            }
            for path in paths {
                store.delete(&path).await?;
            }
        }
    }
    Ok(())
}
