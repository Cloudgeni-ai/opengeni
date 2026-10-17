//! The kernel watchdog a host's guard holds: if the guard stops feeding it,
//! the machine reboots, which stops every VM for certain.
//!
//! The device is set up when the host is: `softdog` (or a hardware
//! watchdog) loaded with the lease terms' timeout and `nowayout`, so that
//! closing the device, even after the magic `V`, never disarms it. The
//! guard checks both before it relies on the device, and never writes `V`.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// An open watchdog device, armed from the moment it was opened.
#[derive(Debug)]
pub struct Watchdog {
    file: File,
}

impl Watchdog {
    /// Opens `device` (such as `/dev/watchdog0`) after checking, in its
    /// `sysfs` directory, that it fires `timeout` after the last feed and
    /// cannot be disarmed. Opening arms it: from then on the caller feeds
    /// it at least once a timeout, or the machine reboots.
    pub fn open(device: &Path, timeout: Duration) -> io::Result<Self> {
        let sysfs = sysfs_dir(device)?;
        let read = |name: &str| -> io::Result<String> {
            fs::read_to_string(sysfs.join(name)).map(|value| value.trim().to_owned())
        };
        check(&read("timeout")?, &read("nowayout")?, timeout)?;
        let file = OpenOptions::new().write(true).open(device)?;
        Ok(Self { file })
    }

    /// Restarts the watchdog's countdown.
    pub fn feed(&mut self) -> io::Result<()> {
        // Any byte but `V` feeds it.
        self.file.write_all(b"k")
    }
}

/// The `sysfs` directory of watchdog `device`: `/dev/watchdogN` is
/// `/sys/class/watchdog/watchdogN`, and `/dev/watchdog` is the first one.
fn sysfs_dir(device: &Path) -> io::Result<PathBuf> {
    let name = device
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no watchdog device name"))?;
    let name = if name == "watchdog" {
        "watchdog0"
    } else {
        name
    };
    Ok(Path::new("/sys/class/watchdog").join(name))
}

/// Checks a device's `timeout` (whole seconds) and `nowayout` as `sysfs`
/// shows them against the `timeout` wanted.
fn check(seconds: &str, nowayout: &str, timeout: Duration) -> io::Result<()> {
    let invalid = |message: String| io::Error::new(io::ErrorKind::InvalidData, message);
    let seconds: u64 = seconds
        .parse()
        .map_err(|_| invalid(format!("watchdog timeout {seconds:?} is not whole seconds")))?;
    if Duration::from_secs(seconds) != timeout {
        return Err(invalid(format!(
            "the watchdog fires {seconds} s after the last feed, the lease needs {} s",
            timeout.as_secs_f64()
        )));
    }
    if nowayout != "1" {
        return Err(invalid(
            "the watchdog can be disarmed (load it with nowayout=1)".to_owned(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devices_map_to_their_sysfs_directory() {
        assert_eq!(
            sysfs_dir(Path::new("/dev/watchdog")).unwrap(),
            Path::new("/sys/class/watchdog/watchdog0")
        );
        assert_eq!(
            sysfs_dir(Path::new("/dev/watchdog1")).unwrap(),
            Path::new("/sys/class/watchdog/watchdog1")
        );
    }

    #[test]
    fn only_the_lease_timeout_and_nowayout_are_taken() {
        let three = Duration::from_secs(3);
        assert!(check("3", "1", three).is_ok());
        assert!(check("60", "1", three).is_err(), "too long");
        assert!(check("3", "0", three).is_err(), "can be disarmed");
        assert!(check("three", "1", three).is_err());
    }
}
