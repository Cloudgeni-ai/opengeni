//! Pure bitmap hot-path measurement; does not claim ublk integration overhead.
use compute_storage::{Result, dirty::DirtyTracker};
use serde_json::json;
use std::{hint::black_box, time::Instant};

fn main() -> Result<()> {
    let disk_bytes = 4_u64 * 1024 * 1024 * 1024;
    let mut tracker = DirtyTracker::new(disk_bytes, 4096)?;
    let started = Instant::now();
    let mut rng = 7_u64;
    for _ in 0..1_000_000 {
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        tracker.mark(black_box((rng % (disk_bytes / 4096)) * 4096), 4096)?;
    }
    let mark_ms = started.elapsed().as_secs_f64() * 1000.0;
    let started = Instant::now();
    let generation = tracker.freeze()?;
    let freeze_ms = started.elapsed().as_secs_f64() * 1000.0;
    let started = Instant::now();
    let ranges = tracker.ranges(generation)?;
    let enumerate_ms = started.elapsed().as_secs_f64() * 1000.0;
    println!(
        "{}",
        json!({"disk_bytes":disk_bytes,"writes":1_000_000,"mark_ms":mark_ms,"freeze_ms":freeze_ms,
        "enumerate_ms":enumerate_ms,"ranges":ranges.len(),"bitmap_bytes":tracker.active_bitmap_bytes()})
    );
    Ok(())
}
