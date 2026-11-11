//! `compute-guest`: PID 1 inside a sandbox. See the library's docs.

#[cfg(target_os = "linux")]
fn main() {
    compute_guest::linux::run();
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("compute-guest runs only inside a Linux guest");
    std::process::exit(1);
}
