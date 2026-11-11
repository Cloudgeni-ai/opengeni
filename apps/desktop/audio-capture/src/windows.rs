//! Windows: process loopback (Windows 10 2004 and later) of everything the
//! system plays except the app's own process tree, converted by WASAPI to mono
//! 48 kHz float.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;

use wasapi::{AudioClient, Direction, SampleType, StreamMode, WaveFormat, initialize_mta};

use crate::output::Sink;
use crate::{Capture, CaptureError, Options};

const SAMPLE_RATE: u32 = 48_000;

struct Guard {
    running: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for Guard {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn open(
    exclude_pid: u32,
) -> Result<(AudioClient, wasapi::AudioCaptureClient, wasapi::Handle), String> {
    initialize_mta().ok().map_err(|error| error.to_string())?;
    let format = WaveFormat::new(32, 32, &SampleType::Float, SAMPLE_RATE as usize, 1, None);
    // Excluding a process tree records everything else the system plays.
    let mut client = AudioClient::new_application_loopback_client(exclude_pid, false)
        .map_err(|error| error.to_string())?;
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: 0,
    };
    client
        .initialize_client(&format, &Direction::Capture, &mode)
        .map_err(|error| error.to_string())?;
    let event = client
        .set_get_eventhandle()
        .map_err(|error| error.to_string())?;
    let capture = client
        .get_audiocaptureclient()
        .map_err(|error| error.to_string())?;
    client.start_stream().map_err(|error| error.to_string())?;
    Ok((client, capture, event))
}

pub fn start(options: &Options, sink: Sink) -> Result<Capture, CaptureError> {
    // With no process to leave out, leave out this helper, which plays nothing.
    let exclude_pid = options
        .exclude_pids
        .first()
        .copied()
        .unwrap_or_else(std::process::id);
    let running = Arc::new(AtomicBool::new(true));
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let thread = {
        let running = running.clone();
        std::thread::spawn(move || {
            // COM objects stay on the thread that created them.
            let (client, capture, event) = match open(exclude_pid) {
                Ok(opened) => {
                    let _ = ready_tx.send(Ok(()));
                    opened
                }
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                    return;
                }
            };
            let mut bytes: VecDeque<u8> = VecDeque::new();
            while running.load(Ordering::Relaxed) {
                // Loopback signals no event while nothing plays, so wake up
                // regularly to notice a stop.
                let _ = event.wait_for_event(200);
                loop {
                    match capture.get_next_packet_size() {
                        Ok(Some(0)) | Ok(None) => break,
                        Ok(Some(_)) => {
                            if let Err(error) = capture.read_from_device_to_deque(&mut bytes) {
                                crate::output::fatal("capture_failed", &error.to_string());
                            }
                        }
                        Err(error) => crate::output::fatal("capture_failed", &error.to_string()),
                    }
                }
                let whole = bytes.len() / 4 * 4;
                if whole > 0 {
                    let (front, back) = bytes.as_slices();
                    let joined: Vec<u8> = front
                        .iter()
                        .chain(back.iter())
                        .take(whole)
                        .copied()
                        .collect();
                    sink.push_iter(
                        joined.chunks_exact(4).map(|chunk| {
                            f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])
                        }),
                    );
                    bytes.drain(..whole);
                }
            }
            let _ = client.stop_stream();
        })
    };
    match ready_rx.recv() {
        Ok(Ok(())) => Ok(Capture {
            sample_rate: SAMPLE_RATE,
            backend: "wasapi-process-loopback",
            _guard: Box::new(Guard {
                running,
                thread: Some(thread),
            }),
        }),
        Ok(Err(message)) => {
            let _ = thread.join();
            Err(CaptureError::new(
                "capture_failed",
                format!("Could not record other apps' audio: {message}"),
            ))
        }
        Err(_) => Err(CaptureError::new(
            "capture_failed",
            "The capture thread stopped.",
        )),
    }
}
