//! The stdout PCM writer and the stderr event lines.
//!
//! Capture backends push samples into a [`Sink`] from their audio thread. The
//! sink is a fixed-size single-producer ring, so pushing never allocates or
//! blocks; samples that don't fit (stdout stalled for seconds) are counted as
//! dropped. A writer thread drains the ring to stdout every few milliseconds.

use std::cell::UnsafeCell;
use std::io::Write;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// About ten seconds of 48 kHz mono audio.
const RING_CAPACITY: usize = 1 << 19;

pub enum Event<'a> {
    Started {
        sample_rate: u32,
        channels: u32,
        backend: &'a str,
    },
    Error {
        code: &'a str,
        message: &'a str,
    },
    Stopped {
        dropped_samples: u64,
    },
}

pub fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control if (control as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", control as u32));
            }
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

pub fn render(event: &Event) -> String {
    match event {
        Event::Started {
            sample_rate,
            channels,
            backend,
        } => format!(
            "{{\"event\":\"started\",\"sampleRate\":{sample_rate},\"channels\":{channels},\"backend\":{}}}",
            json_string(backend)
        ),
        Event::Error { code, message } => format!(
            "{{\"event\":\"error\",\"code\":{},\"message\":{}}}",
            json_string(code),
            json_string(message)
        ),
        Event::Stopped { dropped_samples } => {
            format!("{{\"event\":\"stopped\",\"droppedSamples\":{dropped_samples}}}")
        }
    }
}

pub fn event(event: &Event) {
    let mut stderr = std::io::stderr().lock();
    let _ = writeln!(stderr, "{}", render(event));
    let _ = stderr.flush();
}

/// Report a failure that ends a running capture, and exit. The samples
/// already written stay valid; the app sees the error line and the exit.
/// (Core Audio reports nothing mid-capture, so macOS never calls it.)
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn fatal(code: &str, message: &str) -> ! {
    event(&Event::Error { code, message });
    std::process::exit(1);
}

struct Ring {
    buffer: Box<[UnsafeCell<f32>]>,
    /// Total samples written; only the producer advances it.
    head: AtomicUsize,
    /// Total samples read; only the consumer advances it.
    tail: AtomicUsize,
}

// The producer only writes slots between tail and head + capacity, the
// consumer only reads slots between tail and head, and each side publishes
// its index with release ordering after touching the slots.
unsafe impl Sync for Ring {}
unsafe impl Send for Ring {}

impl Ring {
    fn new(capacity: usize) -> Self {
        Self {
            buffer: (0..capacity).map(|_| UnsafeCell::new(0.0)).collect(),
            head: AtomicUsize::new(0),
            tail: AtomicUsize::new(0),
        }
    }
}

/// The audio thread's end of the ring. Only one thread may push.
pub struct Sink {
    ring: Arc<Ring>,
    dropped: Arc<AtomicU64>,
}

impl Sink {
    /// Push samples without blocking or allocating. Returns how many fit.
    pub fn push(&self, samples: &[f32]) -> usize {
        let capacity = self.ring.buffer.len();
        let head = self.ring.head.load(Ordering::Relaxed);
        let tail = self.ring.tail.load(Ordering::Acquire);
        let free = capacity - (head - tail);
        let count = samples.len().min(free);
        for (offset, sample) in samples[..count].iter().enumerate() {
            // SAFETY: slot (head + offset) is free: the consumer has read it.
            unsafe { *self.ring.buffer[(head + offset) % capacity].get() = *sample };
        }
        self.ring.head.store(head + count, Ordering::Release);
        if count < samples.len() {
            self.dropped
                .fetch_add((samples.len() - count) as u64, Ordering::Relaxed);
        }
        count
    }

    /// Push samples produced by a conversion, one at a time.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn push_iter(&self, samples: impl Iterator<Item = f32>) {
        let mut chunk = [0f32; 256];
        let mut filled = 0;
        for sample in samples {
            chunk[filled] = sample;
            filled += 1;
            if filled == chunk.len() {
                self.push(&chunk);
                filled = 0;
            }
        }
        if filled > 0 {
            self.push(&chunk[..filled]);
        }
    }

    pub fn dropped_counter(&self) -> Arc<AtomicU64> {
        self.dropped.clone()
    }
}

fn drain(ring: &Ring, scratch: &mut Vec<u8>) -> usize {
    let capacity = ring.buffer.len();
    let tail = ring.tail.load(Ordering::Relaxed);
    let head = ring.head.load(Ordering::Acquire);
    scratch.clear();
    for index in tail..head {
        // SAFETY: slots between tail and head were published by the producer.
        let sample = unsafe { *ring.buffer[index % capacity].get() };
        scratch.extend_from_slice(&sample.to_le_bytes());
    }
    ring.tail.store(head, Ordering::Release);
    head - tail
}

/// How many silent samples to write so the output keeps up with the clock
/// while the system plays nothing. Some platforms deliver no data at all then,
/// and the app's track must stay in step with the microphone. Pads only after
/// a stretch with no data, and keeps a little slack for late packets, so a
/// stream that delivers steadily is never padded.
pub fn silence_needed(
    elapsed: Duration,
    since_data: Duration,
    written: u64,
    sample_rate: u32,
) -> u64 {
    if sample_rate == 0 || since_data < Duration::from_millis(100) {
        return 0;
    }
    let expected = (elapsed.as_secs_f64() * f64::from(sample_rate)) as u64;
    let slack = u64::from(sample_rate / 20);
    expected.saturating_sub(written).saturating_sub(slack)
}

/// Start the stdout writer. It stops when `stopping` is set (after a final
/// drain) or when stdout breaks, which also sets `stopping`. Once
/// `sample_rate` is set (the capture started), it also fills silent stretches.
pub fn spawn_writer(
    stopping: Arc<AtomicBool>,
    sample_rate: Arc<AtomicU32>,
) -> (Sink, JoinHandle<()>) {
    let ring = Arc::new(Ring::new(RING_CAPACITY));
    let sink = Sink {
        ring: ring.clone(),
        dropped: Arc::new(AtomicU64::new(0)),
    };
    let handle = std::thread::spawn(move || {
        let mut stdout = std::io::stdout().lock();
        let mut scratch = Vec::with_capacity(RING_CAPACITY * 4);
        let mut clock: Option<(Instant, u32)> = None;
        let mut last_data = Instant::now();
        let mut written: u64 = 0;
        loop {
            let finishing = stopping.load(Ordering::Relaxed);
            if clock.is_none() {
                let rate = sample_rate.load(Ordering::Relaxed);
                if rate > 0 {
                    clock = Some((Instant::now(), rate));
                    written = 0;
                    last_data = Instant::now();
                }
            }
            let count = drain(&ring, &mut scratch);
            if count > 0 {
                written += count as u64;
                last_data = Instant::now();
            } else if let Some((started, rate)) = clock {
                let pad = silence_needed(started.elapsed(), last_data.elapsed(), written, rate);
                if pad > 0 {
                    scratch.clear();
                    scratch.resize(pad as usize * 4, 0);
                    written += pad;
                }
            }
            if !scratch.is_empty() {
                if stdout.write_all(&scratch).is_err() || stdout.flush().is_err() {
                    stopping.store(true, Ordering::Relaxed);
                    return;
                }
                scratch.clear();
            }
            if finishing {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    });
    (sink, handle)
}

#[cfg(test)]
pub fn test_sink(capacity: usize) -> (Sink, Arc<Ring>) {
    let ring = Arc::new(Ring::new(capacity));
    (
        Sink {
            ring: ring.clone(),
            dropped: Arc::new(AtomicU64::new(0)),
        },
        ring,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_keeps_order_across_wraparound_and_counts_overflow() {
        let (sink, ring) = test_sink(8);
        let mut bytes = Vec::new();
        assert_eq!(sink.push(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]), 6);
        assert_eq!(drain(&ring, &mut bytes), 6);
        assert_eq!(
            sink.push(&[7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0, 14.0, 15.0]),
            8
        );
        assert_eq!(sink.dropped_counter().load(Ordering::Relaxed), 1);
        assert_eq!(drain(&ring, &mut bytes), 8);
        let samples: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|chunk| f32::from_le_bytes(chunk.try_into().unwrap()))
            .collect();
        assert_eq!(samples, vec![7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0, 14.0]);
    }

    #[test]
    fn push_iter_pushes_everything() {
        let (sink, ring) = test_sink(1024);
        sink.push_iter((0..600).map(|value| value as f32));
        let mut bytes = Vec::new();
        assert_eq!(drain(&ring, &mut bytes), 600);
    }

    #[test]
    fn pads_only_after_a_stretch_without_data() {
        let second = Duration::from_secs(1);
        // Steady data: never padded, even when slightly behind the clock.
        assert_eq!(
            silence_needed(second * 10, Duration::from_millis(20), 470_000, 48_000),
            0
        );
        // Nothing for a while: catch up to the clock, less 50 ms of slack.
        assert_eq!(
            silence_needed(second * 2, Duration::from_millis(500), 48_000, 48_000),
            45_600
        );
        // Ahead of the clock: nothing to pad.
        assert_eq!(silence_needed(second, second, 96_000, 48_000), 0);
        // Not started: nothing to pad.
        assert_eq!(silence_needed(second, second, 0, 0), 0);
    }

    #[test]
    fn renders_events_as_json_lines() {
        assert_eq!(
            render(&Event::Started {
                sample_rate: 48_000,
                channels: 1,
                backend: "pulse"
            }),
            r#"{"event":"started","sampleRate":48000,"channels":1,"backend":"pulse"}"#
        );
        assert_eq!(
            render(&Event::Error {
                code: "denied",
                message: "say \"no\"\n"
            }),
            r#"{"event":"error","code":"denied","message":"say \"no\"\n"}"#
        );
    }
}
