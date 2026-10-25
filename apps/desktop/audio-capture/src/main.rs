//! Records the audio other apps play (system audio) for the desktop app's
//! meeting recorder.
//!
//! The desktop app starts this helper when a meeting recording includes other
//! apps' audio. It writes mono 32-bit float PCM (little endian) to stdout at
//! the rate it reports, and one JSON object per line to stderr:
//!
//! - `{"event":"started","sampleRate":48000,"channels":1,"backend":"core-audio-tap"}`
//! - `{"event":"error","code":"permission_denied","message":"..."}`
//! - `{"event":"stopped","droppedSamples":0}`
//!
//! It stops when stdin closes, so it never outlives the app that started it.
//! `--watch-microphone` instead reports which apps use a microphone, for call
//! detection; see the microphone module.
//! Options: `--exclude-pid <pid>` (repeatable) leaves out a process and, where
//! the platform supports it, its children; `--exclude-bundle-prefix <id>`
//! (macOS) leaves out every process whose bundle id starts with it.

mod microphone;
mod output;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

use std::io::Read;
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use output::{Event, Sink};

/// What to leave out of the capture.
#[derive(Debug, Default, Clone)]
pub struct Options {
    pub exclude_pids: Vec<u32>,
    pub exclude_bundle_prefixes: Vec<String>,
}

/// A capture failure, with a stable code the app maps to its own message.
#[derive(Debug)]
pub struct CaptureError {
    pub code: &'static str,
    pub message: String,
}

impl CaptureError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// A running capture. Dropping it stops the capture.
pub struct Capture {
    pub sample_rate: u32,
    pub backend: &'static str,
    pub _guard: Box<dyn std::any::Any>,
}

fn parse_options(args: impl Iterator<Item = String>) -> Result<Options, CaptureError> {
    let mut options = Options::default();
    let mut args = args.peekable();
    while let Some(arg) = args.next() {
        let mut value = |name: &str| {
            args.next().ok_or_else(|| {
                CaptureError::new("invalid_arguments", format!("{name} needs a value"))
            })
        };
        match arg.as_str() {
            "--exclude-pid" => {
                let raw = value("--exclude-pid")?;
                let pid = raw.parse::<u32>().map_err(|_| {
                    CaptureError::new("invalid_arguments", format!("not a process id: {raw}"))
                })?;
                options.exclude_pids.push(pid);
            }
            "--exclude-bundle-prefix" => {
                options
                    .exclude_bundle_prefixes
                    .push(value("--exclude-bundle-prefix")?);
            }
            "--version" => {
                println!("{}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            other => {
                return Err(CaptureError::new(
                    "invalid_arguments",
                    format!("unknown argument: {other}"),
                ));
            }
        }
    }
    Ok(options)
}

fn start(options: &Options, sink: Sink) -> Result<Capture, CaptureError> {
    #[cfg(target_os = "macos")]
    return macos::start(options, sink);
    #[cfg(target_os = "windows")]
    return windows::start(options, sink);
    #[cfg(target_os = "linux")]
    return linux::start(options, sink);
    #[allow(unreachable_code)]
    {
        let _ = (options, sink);
        Err(CaptureError::new(
            "unsupported",
            "System audio capture is not available on this platform.",
        ))
    }
}

fn main() -> ExitCode {
    if std::env::args().nth(1).as_deref() == Some("--watch-microphone") {
        return microphone::watch();
    }
    let options = match parse_options(std::env::args().skip(1)) {
        Ok(options) => options,
        Err(error) => {
            output::event(&Event::Error {
                code: error.code,
                message: &error.message,
            });
            return ExitCode::from(2);
        }
    };
    let stopping = Arc::new(AtomicBool::new(false));
    let sample_rate = Arc::new(AtomicU32::new(0));
    let (sink, writer) = output::spawn_writer(stopping.clone(), sample_rate.clone());
    let dropped = sink.dropped_counter();
    let capture = match start(&options, sink) {
        Ok(capture) => capture,
        Err(error) => {
            output::event(&Event::Error {
                code: error.code,
                message: &error.message,
            });
            return ExitCode::from(1);
        }
    };
    sample_rate.store(capture.sample_rate, Ordering::Relaxed);
    output::event(&Event::Started {
        sample_rate: capture.sample_rate,
        channels: 1,
        backend: capture.backend,
    });

    // Run until stdin closes: the app closes it to stop, and it closes on its
    // own when the app exits. A broken stdout (the app stopped reading) also
    // ends the capture through the writer.
    let stdin_closed = {
        let stopping = stopping.clone();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 64];
            let mut stdin = std::io::stdin();
            while !stopping.load(Ordering::Relaxed) {
                match stdin.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
            stopping.store(true, Ordering::Relaxed);
        })
    };
    while !stopping.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    drop(capture);
    let _ = writer.join();
    drop(stdin_closed);
    output::event(&Event::Stopped {
        dropped_samples: dropped.load(Ordering::Relaxed),
    });
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> impl Iterator<Item = String> {
        list.iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>()
            .into_iter()
    }

    #[test]
    fn parses_exclusions() {
        let options = parse_options(args(&[
            "--exclude-pid",
            "42",
            "--exclude-bundle-prefix",
            "com.example.app",
            "--exclude-pid",
            "7",
        ]))
        .unwrap();
        assert_eq!(options.exclude_pids, vec![42, 7]);
        assert_eq!(options.exclude_bundle_prefixes, vec!["com.example.app"]);
    }

    #[test]
    fn rejects_bad_arguments() {
        assert_eq!(
            parse_options(args(&["--exclude-pid", "x"]))
                .unwrap_err()
                .code,
            "invalid_arguments"
        );
        assert_eq!(
            parse_options(args(&["--exclude-pid"])).unwrap_err().code,
            "invalid_arguments"
        );
        assert_eq!(
            parse_options(args(&["--loud"])).unwrap_err().code,
            "invalid_arguments"
        );
    }
}
