//! Reflink creation density on an explicitly supplied Linux scratch filesystem.
#[cfg(target_os = "linux")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use serde_json::json;
    use std::{
        env,
        fs::{File, OpenOptions},
        os::{fd::AsRawFd, unix::fs::FileExt},
        time::Instant,
    };
    let args: Vec<_> = env::args().collect();
    if args.len() != 4 {
        eprintln!("usage: storage-density BASE EMPTY_DIRECTORY COUNT");
        std::process::exit(2);
    }
    let source = File::open(&args[1])?;
    let directory = std::path::Path::new(&args[2]);
    std::fs::create_dir(directory)?;
    let count: usize = args[3].parse()?;
    if count == 0 {
        return Err("count must be positive".into());
    }
    let before = used_bytes(&source)?;
    let mut create_us = Vec::with_capacity(count);
    let started = Instant::now();
    for i in 0..count {
        let t = Instant::now();
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(directory.join(i.to_string()))?;
        // SAFETY: both descriptors are open regular files and FICLONE takes the
        // source fd by value, not a userspace pointer.
        if unsafe {
            libc::ioctl(
                file.as_raw_fd(),
                0x4004_9409 as libc::c_ulong,
                source.as_raw_fd(),
            )
        } < 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        create_us.push(t.elapsed().as_micros());
    }
    let total_ms = started.elapsed().as_secs_f64() * 1000.0;
    let t = Instant::now();
    // Sync this disposable filesystem, not unrelated hosts or disks.
    if unsafe { libc::syncfs(source.as_raw_fd()) } < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let sync_ms = t.elapsed().as_secs_f64() * 1000.0;
    let after_create = used_bytes(&source)?;
    let t = Instant::now();
    for i in 0..count {
        let file = OpenOptions::new()
            .write(true)
            .open(directory.join(i.to_string()))?;
        file.write_all_at(&[0x5a; 4096], 1024 * 1024)?;
    }
    let write_ms = t.elapsed().as_secs_f64() * 1000.0;
    let t = Instant::now();
    // SAFETY: source remains an open file on the measured filesystem.
    if unsafe { libc::syncfs(source.as_raw_fd()) } < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let cow_sync_ms = t.elapsed().as_secs_f64() * 1000.0;
    let after_write = used_bytes(&source)?;
    create_us.sort_unstable();
    println!(
        "{}",
        json!({"count":count,"create_ms":total_ms,"sync_ms":sync_ms,"cow_write_ms":write_ms,
        "cow_sync_ms":cow_sync_ms,"used_bytes_before":before,"used_bytes_after_create":after_create,"used_bytes_after_cow":after_write,
        "p50_create_us":create_us[count/2],"p99_create_us":create_us[count*99/100],"logical_bytes_each":source.metadata()?.len()})
    );
    Ok(())
}

#[cfg(target_os = "linux")]
fn used_bytes(file: &std::fs::File) -> std::io::Result<u64> {
    use std::os::fd::AsRawFd;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: fstatvfs initializes the pointed-to structure on success.
    if unsafe { libc::fstatvfs(file.as_raw_fd(), stats.as_mut_ptr()) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: checked successful initialization above.
    let stats = unsafe { stats.assume_init() };
    Ok((stats.f_blocks - stats.f_bfree) * stats.f_frsize)
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("Linux FICLONE required");
    std::process::exit(2);
}
