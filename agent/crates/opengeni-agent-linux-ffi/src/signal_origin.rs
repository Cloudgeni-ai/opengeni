//! Who sent a signal. `kill -1` and a targeted `kill <pid>` look the same to
//! their receiver; only the sending process tells them apart, and only
//! `SA_SIGINFO` delivery (or `sigwaitinfo(2)`) reports it.

use std::fs::File;
use std::io::{self, Read as _};
use std::mem::{size_of, zeroed};
use std::os::fd::{FromRawFd as _, OwnedFd};

/// One signal delivery and its sender.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SignalDelivery {
    /// The signal number.
    pub signal: i32,
    /// The sending process for a signal a process sent (`kill(2)`,
    /// `sigqueue(3)`, `tgkill(2)`); `None` for one the kernel raised, such as
    /// a terminal's Ctrl-C.
    pub sender: Option<i32>,
}

const RECORD: usize = 3 * size_of::<i32>();

fn sender_of(info: &libc::siginfo_t) -> Option<i32> {
    if matches!(
        info.si_code,
        libc::SI_USER | libc::SI_QUEUE | libc::SI_TKILL
    ) {
        // SAFETY: for these codes the kernel fills the `kill` member of the
        // union, which holds the sender's PID.
        Some(unsafe { info.si_pid() })
    } else {
        None
    }
}

fn encode(signal: i32, sender: Option<i32>) -> [u8; RECORD] {
    let mut record = [0_u8; RECORD];
    record[..4].copy_from_slice(&signal.to_ne_bytes());
    record[4..8].copy_from_slice(&i32::from(sender.is_some()).to_ne_bytes());
    record[8..].copy_from_slice(&sender.unwrap_or(0).to_ne_bytes());
    record
}

fn decode(record: &[u8; RECORD]) -> SignalDelivery {
    let word = |at: usize| {
        let mut bytes = [0_u8; 4];
        bytes.copy_from_slice(&record[at..at + 4]);
        i32::from_ne_bytes(bytes)
    };
    SignalDelivery {
        signal: word(0),
        sender: (word(4) != 0).then(|| word(8)),
    }
}

/// Every later delivery of the relayed signals, with its sender. Relaying
/// replaces the signals' default action, so they no longer end the process.
#[derive(Debug)]
pub struct SignalRelay {
    reader: File,
}

impl SignalRelay {
    /// Blocks until the next delivery.
    ///
    /// # Errors
    /// Returns the pipe's read error; the relay's writer is never closed.
    pub fn recv(&mut self) -> io::Result<SignalDelivery> {
        let mut record = [0_u8; RECORD];
        self.reader.read_exact(&mut record)?;
        Ok(decode(&record))
    }
}

/// Starts relaying `signals`, with their senders, to the returned
/// [`SignalRelay`]. Other handlers registered for the same signals through
/// `signal-hook-registry` (Tokio's among them) keep running.
///
/// # Errors
/// Returns the error creating the pipe or registering a handler. Handlers
/// already registered stay registered.
pub fn relay_signals(signals: &[i32]) -> io::Result<SignalRelay> {
    let mut fds = [0_i32; 2];
    // SAFETY: `fds` has room for the two descriptors pipe2(2) writes.
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: pipe2 succeeded, so both descriptors are new and owned here.
    let (reader, writer) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
    let writer = std::os::fd::IntoRawFd::into_raw_fd(writer);
    // A full pipe drops a delivery rather than blocking a signal handler.
    // SAFETY: plain fcntl(2) calls on the descriptor owned above.
    unsafe {
        let flags = libc::fcntl(writer, libc::F_GETFL);
        if flags < 0 || libc::fcntl(writer, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
            let error = io::Error::last_os_error();
            libc::close(writer);
            return Err(error);
        }
    }
    for &signal in signals {
        // SAFETY: the action only encodes integers on the stack and calls
        // write(2), which is async-signal-safe. The writer is deliberately
        // never closed, so the descriptor stays valid for every later call.
        unsafe {
            signal_hook_registry::register_sigaction(signal, move |info: &libc::siginfo_t| {
                let record = encode(signal, sender_of(info));
                let _ = libc::write(writer, record.as_ptr().cast(), record.len());
            })
        }?;
    }
    Ok(SignalRelay {
        reader: File::from(reader),
    })
}

/// Waits for one of `signals`, which every thread must block, and returns it
/// with its sender (`sigwaitinfo(2)`). Interrupted waits are retried.
///
/// # Errors
/// Returns an invalid signal number or another `sigwaitinfo` failure.
pub fn wait_for_signal(signals: &[i32]) -> io::Result<SignalDelivery> {
    // SAFETY: sigemptyset/sigaddset initialize and fill the local set, and
    // sigwaitinfo writes one siginfo_t into the zeroed local value.
    unsafe {
        let mut set: libc::sigset_t = zeroed();
        libc::sigemptyset(&raw mut set);
        for &signal in signals {
            if libc::sigaddset(&raw mut set, signal) != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        loop {
            let mut info: libc::siginfo_t = zeroed();
            let signal = libc::sigwaitinfo(&raw const set, &raw mut info);
            if signal >= 0 {
                return Ok(SignalDelivery {
                    signal,
                    sender: sender_of(&info),
                });
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_record_keeps_its_signal_and_sender() {
        for delivery in [
            SignalDelivery {
                signal: libc::SIGTERM,
                sender: Some(4_194_303),
            },
            SignalDelivery {
                signal: libc::SIGINT,
                sender: None,
            },
        ] {
            assert_eq!(decode(&encode(delivery.signal, delivery.sender)), delivery);
        }
    }

    #[test]
    fn a_relayed_signal_names_its_sender_and_does_not_end_the_process() {
        let mut relay = relay_signals(&[libc::SIGUSR2]).expect("relay SIGUSR2");
        let mut child = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(format!("kill -USR2 {}", std::process::id()))
            .spawn()
            .expect("start the sender");
        let sender = i32::try_from(child.id()).expect("pid fits");
        let status = child.wait().expect("sender exits");
        assert!(status.success());
        assert_eq!(
            relay.recv().expect("one delivery"),
            SignalDelivery {
                signal: libc::SIGUSR2,
                sender: Some(sender),
            }
        );
    }
}
