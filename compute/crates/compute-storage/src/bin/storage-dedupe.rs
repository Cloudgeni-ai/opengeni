//! Compare complete immutable images; report zero elision separately from dedup.
use compute_storage::{
    Result,
    chunk::{Chunking, EncodedChunk},
};
use serde_json::json;
use std::{collections::HashSet, env, time::Instant};

fn main() -> Result<()> {
    let files: Vec<_> = env::args().skip(1).collect();
    if files.is_empty() {
        eprintln!("usage: storage-dedupe IMAGE...");
        std::process::exit(2);
    }
    for strategy in [
        Chunking::Fixed { size: 65536 },
        Chunking::Fixed { size: 262_144 },
        Chunking::Fixed { size: 1_048_576 },
        Chunking::Gear {
            min: 65536,
            average: 262_144,
            max: 1_048_576,
        },
    ] {
        let mut seen = HashSet::new();
        for (index, path) in files.iter().enumerate() {
            let input = std::fs::read(path)?;
            let started = Instant::now();
            let ranges = strategy.ranges(&input)?;
            let mut zero_bytes = 0;
            let mut duplicate_bytes = 0;
            let mut new_plain = 0;
            let mut new_stored = 0;
            let mut new_chunks = 0;
            for range in &ranges {
                let bytes = &input[range.clone()];
                if bytes.iter().all(|b| *b == 0) {
                    zero_bytes += bytes.len();
                    continue;
                }
                let hash = blake3::hash(bytes);
                if seen.insert(hash) {
                    new_chunks += 1;
                    new_plain += bytes.len();
                    new_stored += EncodedChunk::encode(bytes, 1)?.bytes.len();
                } else {
                    duplicate_bytes += bytes.len();
                }
            }
            println!(
                "{}",
                json!({"strategy":strategy,"image_index":index,"logical_bytes":input.len(),"chunks":ranges.len(),
                "zero_chunk_bytes":zero_bytes,"deduplicated_nonzero_chunk_bytes":duplicate_bytes,"new_plain_chunk_bytes":new_plain,
                "new_compressed_bytes":new_stored,"new_chunks":new_chunks,"ms":started.elapsed().as_secs_f64()*1000.0})
            );
        }
    }
    Ok(())
}
