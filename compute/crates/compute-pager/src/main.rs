//! Minimal supervised lab runner. The embedding host owns pager/VMM lifetimes.

#[cfg(target_os = "linux")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use compute_pager::{MappedFile, Profile, linux::Pager};
    use std::{
        fs::{self, File},
        os::unix::net::UnixListener,
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
        time::{Duration, Instant},
    };
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 5 {
        return Err("usage: compute-pager SOCKET SNAPSHOT SNAPSHOT_ID OUTPUT_PREFIX [lazy|eager|PROFILE] [record_ms] [ordered|sorted]".into());
    }
    let listener = UnixListener::bind(&args[1])?;
    listener.set_nonblocking(true)?;
    let stopped = Arc::new(AtomicBool::new(false));
    signal_hook::flag::register(signal_hook::consts::SIGTERM, Arc::clone(&stopped))?;
    signal_hook::flag::register(signal_hook::consts::SIGINT, Arc::clone(&stopped))?;
    let snapshot = File::open(&args[2])?;
    let accept_started = Instant::now();
    let peer = loop {
        if stopped.load(Ordering::Relaxed) {
            return Ok(());
        }
        match listener.accept() {
            Ok((peer, _)) => break peer,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if accept_started.elapsed() > Duration::from_secs(30) {
                    return Err("VMM handshake timed out".into());
                }
                std::thread::sleep(Duration::from_millis(1));
            }
            Err(error) => return Err(error.into()),
        }
    };
    let record_ms = args.get(6).map_or(Ok(5000), |s| s.parse::<u64>())?;
    // SAFETY: the supervisor contract requires an immutable snapshot.
    let source = unsafe { MappedFile::new(&snapshot)? };
    let mut pager = Pager::new(peer, source, Duration::from_millis(record_ms))?;
    let mode = args.get(5).map_or("lazy", String::as_str);
    let mut plan = match mode {
        "lazy" => Vec::new(),
        "eager" => {
            let mut offsets = Vec::new();
            for region in pager.layout().regions() {
                let mut offset = region.offset;
                while offset < region.offset + region.size {
                    offsets.push(offset);
                    offset += region.page_size;
                }
            }
            pager.layout().plan(&offsets)?
        }
        path => {
            let profile: Profile = serde_json::from_slice(&fs::read(path)?)?;
            profile.validate(&args[3], pager.layout())?
        }
    };
    match args.get(7).map_or("ordered", String::as_str) {
        "ordered" => (),
        "sorted" => plan.sort_unstable_by_key(|entry| entry.offset),
        _ => return Err("profile order must be ordered or sorted".into()),
    }
    pager.prefetch(&plan, 2_097_152)?;
    fs::write(format!("{}.ready", args[4]), b"ready\n")?;
    let result = pager.run(&stopped, |_| {});
    fs::write(
        format!("{}.profile.json", args[4]),
        serde_json::to_vec(&pager.profile(args[3].clone()))?,
    )?;
    fs::write(
        format!("{}.stats.json", args[4]),
        serde_json::to_vec_pretty(&pager.stats)?,
    )?;
    result?;
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("compute-pager requires Linux; the layout library is portable");
    std::process::exit(1);
}
