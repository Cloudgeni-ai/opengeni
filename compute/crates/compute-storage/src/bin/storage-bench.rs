//! Offline benchmark: immutable disk views only. JSON lines on stdout.
use std::{
    collections::HashSet,
    env,
    fs::File,
    io::{Read, Seek, SeekFrom},
    time::Instant,
};

use compute_storage::{
    Result,
    chunk::{Chunking, EncodedChunk},
    dirty::DirtyTracker,
};
use serde_json::json;

fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    if !(3..=4).contains(&args.len()) {
        eprintln!("usage: storage-bench BEFORE AFTER [--full]");
        std::process::exit(2);
    }
    let mut before = File::open(&args[1])?;
    let mut after = File::open(&args[2])?;
    let size = before.metadata()?.len();
    let t = Instant::now();
    #[cfg(target_os = "linux")]
    let candidates = if args.get(3).is_some_and(|s| s == "--full") {
        std::iter::once(0..size).collect()
    } else {
        compute_storage::fiemap::candidates(&before, &after)?
    };
    #[cfg(not(target_os = "linux"))]
    let candidates: Vec<_> = std::iter::once(0..size).collect();
    let fiemap_ms = t.elapsed().as_secs_f64() * 1000.0;
    let candidate_bytes: u64 = candidates.iter().map(|r| r.end - r.start).sum();
    let mut changed = Vec::new();
    let mut a = vec![0; 1024 * 1024];
    let mut b = vec![0; 1024 * 1024];
    let t = Instant::now();
    let mut bitmap = DirtyTracker::new(size, 4096)?;
    for range in &candidates {
        before.seek(SeekFrom::Start(range.start))?;
        after.seek(SeekFrom::Start(range.start))?;
        let mut pos = range.start;
        while pos < range.end {
            let n = usize::try_from((range.end - pos).min(a.len() as u64)).unwrap();
            before.read_exact(&mut a[..n])?;
            after.read_exact(&mut b[..n])?;
            for (index, (old, new)) in a[..n].chunks(4096).zip(b[..n].chunks(4096)).enumerate() {
                if old != new {
                    bitmap.mark(pos + index as u64 * 4096, new.len() as u64)?;
                    changed.extend_from_slice(new);
                }
            }
            pos += n as u64;
        }
    }
    let scan_ms = t.elapsed().as_secs_f64() * 1000.0;
    println!(
        "{}",
        json!({"operation":"diff", "disk_bytes":size, "fiemap_ms":fiemap_ms,
        "candidate_bytes":candidate_bytes,"candidate_ranges":candidates.len(),"changed_bytes":changed.len(),"scan_ms":scan_ms,
        "bitmap_bytes":bitmap.active_bitmap_bytes()})
    );
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
        for level in [1, 3, 6, 9] {
            let t = Instant::now();
            let ranges = strategy.ranges(&changed)?;
            let mut stored = 0;
            let mut unique = HashSet::new();
            let mut unique_bytes = 0;
            for range in &ranges {
                let chunk = EncodedChunk::encode(&changed[range.clone()], level)?;
                stored += chunk.bytes.len();
                if unique.insert(chunk.reference.hash) {
                    unique_bytes += chunk.bytes.len();
                }
            }
            println!(
                "{}",
                json!({"operation":"chunks","strategy":strategy,"level":level,"chunks":ranges.len(),
                "plain_bytes":changed.len(),"stored_bytes":stored,"unique_bytes":unique_bytes,"unique_chunks":unique.len(),
                "ms":t.elapsed().as_secs_f64()*1000.0})
            );
        }
    }
    Ok(())
}
