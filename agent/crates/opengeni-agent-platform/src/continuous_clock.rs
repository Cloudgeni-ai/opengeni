//! Elapsed time including suspend, independent of civil-clock corrections.

use std::time::Duration;

/// A process-local duration since boot, including time asleep. Never persist or
/// compare it across machines. Failure must not fall back to civil time.
///
/// # Errors
/// Returns the OS error if its continuous clock cannot be read, or Unsupported
/// on a platform without an implemented suspend-inclusive clock.
pub fn continuous_time() -> std::io::Result<Duration> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        // Apple's CLOCK_MONOTONIC_RAW uses mach_continuous_time; Linux BOOTTIME
        // includes suspend, unlike its CLOCK_MONOTONIC and MONOTONIC_RAW.
        #[cfg(target_os = "linux")]
        let clock = nix::time::ClockId::CLOCK_BOOTTIME;
        #[cfg(target_os = "macos")]
        let clock = nix::time::ClockId::from_raw(nix::libc::CLOCK_MONOTONIC_RAW);
        nix::time::clock_gettime(clock)
            .map(Duration::from)
            .map_err(std::io::Error::from)
    }
    #[cfg(windows)]
    {
        Ok(Duration::from_millis(
            opengeni_agent_windows_ffi::continuous_millis(),
        ))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "continuous clock unavailable",
        ))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn elapsed_clock_is_available_and_advances() {
        let before = super::continuous_time().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        assert!(super::continuous_time().unwrap() > before);
    }
}
