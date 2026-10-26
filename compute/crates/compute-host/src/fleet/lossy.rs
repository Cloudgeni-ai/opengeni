//! The guard's log, which it writes to without waiting.
//!
//! The guard's standard error goes to the journal, and a write to it waits
//! while the journal is slow to take it, as on a host short of memory,
//! where the journal waits on the same busy disk as everything else. A
//! guard waiting there for longer than the watchdog's timeout resets the
//! machine. So the guard hands each line to a thread of its own, which
//! writes it; when that thread falls behind by [`ROOM`] lines, the lines
//! after those are dropped, as are lines the log refuses, and the thread
//! says how many once it has caught up.

use std::io::{self, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError};
use std::time::{Duration, Instant};

use tracing_subscriber::fmt::MakeWriter;

/// How many lines may wait to be written before more are dropped.
pub const ROOM: usize = 1024;

/// A log written by a thread of its own: writing a line to it never waits.
#[derive(Clone, Debug)]
pub struct Lossy {
    lines: SyncSender<Vec<u8>>,
    counts: Arc<Counts>,
}

#[derive(Debug, Default)]
struct Counts {
    /// Lines handed to the writing thread.
    queued: AtomicU64,
    /// Lines it has written, or tried to.
    written: AtomicU64,
    /// Lines dropped and not yet said to be.
    dropped: AtomicU64,
}

impl Lossy {
    /// A log that writes to `sink`, from a thread it starts.
    ///
    /// # Errors
    ///
    /// When the thread cannot be started.
    pub fn new(sink: impl Write + Send + 'static) -> io::Result<Self> {
        Self::with_room(sink, ROOM)
    }

    fn with_room(sink: impl Write + Send + 'static, room: usize) -> io::Result<Self> {
        let (lines, queue) = mpsc::sync_channel(room);
        let counts = Arc::new(Counts::default());
        let writing = Arc::clone(&counts);
        std::thread::Builder::new()
            .name("guard-log".into())
            .spawn(move || write_out(&queue, sink, &writing))?;
        Ok(Self { lines, counts })
    }

    /// Waits, for at most `within`, for the lines given to the log so far,
    /// and the notice of any dropped, to be written; whether they were.
    #[must_use]
    pub fn flush_within(&self, within: Duration) -> bool {
        let given = self.counts.queued.load(Ordering::Acquire);
        let deadline = Instant::now() + within;
        loop {
            if self.counts.written.load(Ordering::Acquire) >= given
                && self.counts.dropped.load(Ordering::Acquire) == 0
            {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

/// The writing thread: writes each line given, and, whenever it has
/// written all it was given, says how many it was not.
fn write_out(queue: &Receiver<Vec<u8>>, mut sink: impl Write, counts: &Counts) {
    loop {
        let line = match queue.try_recv() {
            Ok(line) => line,
            Err(TryRecvError::Empty) => {
                let dropped = counts.dropped.load(Ordering::Acquire);
                if dropped > 0 {
                    let _ = writeln!(
                        sink,
                        "{dropped} log lines dropped: the log did not take them in time"
                    );
                    let _ = sink.flush();
                    counts.dropped.fetch_sub(dropped, Ordering::AcqRel);
                }
                match queue.recv() {
                    Ok(line) => line,
                    Err(_) => return,
                }
            }
            Err(TryRecvError::Disconnected) => return,
        };
        if sink.write_all(&line).and_then(|()| sink.flush()).is_err() {
            counts.dropped.fetch_add(1, Ordering::AcqRel);
        }
        counts.written.fetch_add(1, Ordering::AcqRel);
    }
}

impl Write for &Lossy {
    /// Hands `buf` (a whole line, as the log's formatter writes each) to
    /// the writing thread, or drops it if the thread has fallen behind.
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self.lines.try_send(buf.to_vec()) {
            Ok(()) => {
                self.counts.queued.fetch_add(1, Ordering::AcqRel);
            }
            Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => {
                self.counts.dropped.fetch_add(1, Ordering::AcqRel);
            }
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for Lossy {
    type Writer = &'a Lossy;

    fn make_writer(&'a self) -> Self::Writer {
        self
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// A sink that takes nothing while the test holds it, as a journal
    /// that has stalled.
    #[derive(Clone)]
    struct Stalled(Arc<Mutex<Vec<u8>>>);

    impl Write for Stalled {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_stalled_log_holds_up_no_writer_and_says_what_it_dropped() {
        let text = Arc::new(Mutex::new(Vec::new()));
        let log = Lossy::with_room(Stalled(Arc::clone(&text)), 2).unwrap();
        let stalled = text.lock().unwrap();
        let started = Instant::now();
        for line in 0..20 {
            (&log)
                .write_all(format!("line {line}\n").as_bytes())
                .unwrap();
        }
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "writing waited on the stalled log"
        );
        assert!(!log.flush_within(Duration::from_millis(50)));
        drop(stalled);
        assert!(log.flush_within(Duration::from_secs(5)));

        let text = String::from_utf8(text.lock().unwrap().clone()).unwrap();
        let written = text
            .lines()
            .filter(|line| line.starts_with("line "))
            .count();
        let notice = text
            .lines()
            .find(|line| line.ends_with("log lines dropped: the log did not take them in time"))
            .expect("no notice of the dropped lines");
        let dropped: usize = notice.split(' ').next().unwrap().parse().unwrap();
        assert!(written >= 2, "{text}");
        assert_eq!(written + dropped, 20, "{text}");
        assert!(
            text.starts_with("line 0\n"),
            "lines kept their order: {text}"
        );
    }

    #[test]
    fn a_log_that_keeps_up_writes_every_line_in_order() {
        let text = Arc::new(Mutex::new(Vec::new()));
        let log = Lossy::with_room(Stalled(Arc::clone(&text)), 2).unwrap();
        for line in 0..20 {
            (&log)
                .write_all(format!("line {line}\n").as_bytes())
                .unwrap();
            assert!(log.flush_within(Duration::from_secs(5)));
        }
        let expected = (0..20)
            .map(|line| format!("line {line}"))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        assert_eq!(
            String::from_utf8(text.lock().unwrap().clone()).unwrap(),
            expected
        );
    }

    /// A sink that refuses its first write, as a log whose stream broke.
    struct Refusing {
        refuse: bool,
        text: Arc<Mutex<Vec<u8>>>,
    }

    impl Write for Refusing {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            if std::mem::take(&mut self.refuse) {
                return Err(io::Error::from(io::ErrorKind::BrokenPipe));
            }
            self.text.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_line_the_log_refuses_is_said_to_be_dropped() {
        let text = Arc::new(Mutex::new(Vec::new()));
        let sink = Refusing {
            refuse: true,
            text: Arc::clone(&text),
        };
        let log = Lossy::with_room(sink, 2).unwrap();
        for line in 0..3 {
            (&log)
                .write_all(format!("line {line}\n").as_bytes())
                .unwrap();
            assert!(log.flush_within(Duration::from_secs(5)));
        }
        assert_eq!(
            String::from_utf8(text.lock().unwrap().clone()).unwrap(),
            "1 log lines dropped: the log did not take them in time\nline 1\nline 2\n"
        );
    }
}
