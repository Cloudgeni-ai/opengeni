//! What one side of a resumable stream keeps (see [`super`]): what it sent
//! and the other side has not yet acknowledged, and what it received and
//! has not yet handed on.

use std::collections::VecDeque;
use std::fmt;

use super::wire::{CHUNK, Frame, Hello, StreamId};

/// The most a side keeps of what it sent before the other acknowledges it:
/// beyond it, the side stops reading its own end of the stream. It also
/// bounds what the other side holds received and not yet handed on.
pub const WINDOW: usize = 1 << 20;

/// One side of a stream.
#[derive(Debug, Default)]
pub struct Stream {
    /// What this side sent from `out_base` on, not yet acknowledged.
    out: VecDeque<u8>,
    out_base: u64,
    /// This side's direction has ended, at `out_base + out.len()`.
    ended: bool,
    /// What the other side acknowledged, its end counted.
    acked: u64,
    /// What this side received of the other's direction, its end counted.
    received: u64,
    /// What it received and has not yet handed on.
    inbound: VecDeque<u8>,
    /// The other side's direction ended.
    peer_ended: bool,
    /// What it handed on, the end counted once handed on.
    taken: u64,
    /// What it last acknowledged.
    acknowledged: u64,
}

/// What a side hands on to its end of the stream.
#[derive(Debug, PartialEq, Eq)]
pub enum Delivery {
    Bytes(Vec<u8>),
    /// The other side's direction ended: end the writing to this side's end.
    End,
}

/// What a received frame did.
#[derive(Debug, PartialEq, Eq)]
pub enum Received {
    /// The stream took it.
    Taken,
    /// The other side gave the stream up.
    Abandoned,
}

/// A frame that cannot follow what the stream holds: the other side is not
/// keeping the protocol, and the stream cannot go on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamError {
    /// Data or an end past what was received: something was skipped.
    Gap { at: u64, received: u64 },
    /// Data after the end of the other side's direction, or an end that
    /// moved.
    PastEnd,
    /// More data than the window lets the other side send.
    Overrun,
    /// An acknowledgement of more than this side sent.
    AckPastSent { ack: u64, sent: u64 },
}

impl fmt::Display for StreamError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Gap { at, received } => {
                write!(f, "a frame at {at} after only {received} received")
            }
            Self::PastEnd => f.write_str("data past the end of the stream"),
            Self::Overrun => f.write_str("more data than the window allows"),
            Self::AckPastSent { ack, sent } => {
                write!(f, "an acknowledgement of {ack} with {sent} sent")
            }
        }
    }
}

impl std::error::Error for StreamError {}

impl Stream {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// How much more this side's end may add now: nothing once ended, or
    /// while [`WINDOW`] waits for an acknowledgement.
    #[must_use]
    pub fn room(&self) -> usize {
        if self.ended {
            0
        } else {
            WINDOW.saturating_sub(self.out.len())
        }
    }

    /// Adds what this side's end sent. Call within [`Self::room`].
    pub fn push(&mut self, bytes: &[u8]) {
        debug_assert!(!self.ended);
        self.out.extend(bytes);
    }

    /// This side's end sends no more.
    pub fn end(&mut self) {
        self.ended = true;
    }

    /// What this side sent, its end counted.
    #[must_use]
    pub fn sent(&self) -> u64 {
        self.data_sent() + u64::from(self.ended)
    }

    fn data_sent(&self) -> u64 {
        self.out_base + self.out.len() as u64
    }

    /// What this side received, the other's end counted.
    #[must_use]
    pub fn received(&self) -> u64 {
        self.received
    }

    /// Appends to `out` the frame that sends what follows `cursor`, the
    /// position the other side has up to on this connection, and returns
    /// the position after it; `None` with nothing more to send.
    pub fn next_frame(&self, cursor: u64, out: &mut Vec<u8>) -> Option<u64> {
        // What precedes the base was acknowledged, so the other side has
        // it: never a gap.
        let cursor = cursor.max(self.out_base);
        let data_sent = self.data_sent();
        if cursor < data_sent {
            let start = usize::try_from(cursor - self.out_base).unwrap_or(usize::MAX);
            let length = (self.out.len() - start).min(CHUNK);
            let mut bytes = Vec::with_capacity(length);
            bytes.extend(self.out.range(start..start + length));
            Frame::Data {
                offset: cursor,
                bytes: &bytes,
            }
            .encode(out);
            Some(cursor + length as u64)
        } else if cursor == data_sent && self.ended {
            Frame::End(cursor).encode(out);
            Some(cursor + 1)
        } else {
            None
        }
    }

    /// Takes a frame from the other side.
    pub fn receive(&mut self, frame: &Frame<'_>) -> Result<Received, StreamError> {
        let data_received = self.received - u64::from(self.peer_ended);
        match *frame {
            Frame::Data { offset, bytes } => {
                let length = bytes.len() as u64;
                if offset > data_received {
                    return Err(StreamError::Gap {
                        at: offset,
                        received: data_received,
                    });
                }
                let skip = data_received - offset;
                if skip >= length {
                    return Ok(Received::Taken);
                }
                if self.peer_ended {
                    return Err(StreamError::PastEnd);
                }
                let new = &bytes[usize::try_from(skip).unwrap_or(usize::MAX)..];
                if self.inbound.len() + new.len() > WINDOW {
                    return Err(StreamError::Overrun);
                }
                self.inbound.extend(new);
                self.received += new.len() as u64;
            }
            Frame::End(offset) => {
                if self.peer_ended {
                    if offset != data_received {
                        return Err(StreamError::PastEnd);
                    }
                } else if offset > data_received {
                    return Err(StreamError::Gap {
                        at: offset,
                        received: data_received,
                    });
                } else if offset < data_received {
                    return Err(StreamError::PastEnd);
                } else {
                    self.peer_ended = true;
                    self.received += 1;
                }
            }
            Frame::Ack(ack) => {
                let sent = self.sent();
                if ack > sent {
                    return Err(StreamError::AckPastSent { ack, sent });
                }
                self.acked = self.acked.max(ack);
                let through = self.acked.min(self.data_sent());
                if through > self.out_base {
                    let trimmed = usize::try_from(through - self.out_base).unwrap_or(usize::MAX);
                    self.out.drain(..trimmed);
                    self.out_base = through;
                }
            }
            Frame::Abandon => return Ok(Received::Abandoned),
        }
        Ok(Received::Taken)
    }

    /// Hands on up to `max` received bytes, or the other side's end once
    /// everything before it was handed on.
    pub fn take(&mut self, max: usize) -> Option<Delivery> {
        if !self.inbound.is_empty() {
            let length = self.inbound.len().min(max.max(1));
            let bytes: Vec<u8> = self.inbound.drain(..length).collect();
            self.taken += length as u64;
            return Some(Delivery::Bytes(bytes));
        }
        if self.peer_ended && self.taken < self.received {
            self.taken = self.received;
            return Some(Delivery::End);
        }
        None
    }

    /// Appends to `out` an acknowledgement of what was handed on since the
    /// last one, if anything was; whether it did.
    pub fn acknowledge(&mut self, out: &mut Vec<u8>) -> bool {
        if self.taken <= self.acknowledged {
            return false;
        }
        Frame::Ack(self.taken).encode(out);
        self.acknowledged = self.taken;
        true
    }

    /// Whether both directions ended, each was handed on, and each end was
    /// acknowledged: neither side needs the other again.
    #[must_use]
    pub fn finished(&self) -> bool {
        self.ended
            && self.acked == self.sent()
            && self.peer_ended
            && self.acknowledged == self.received
    }

    /// The guest's hello for a connection that carries this stream.
    #[must_use]
    pub fn hello(&self, id: StreamId) -> Hello {
        Hello {
            id,
            received: self.received,
            sent: self.sent(),
        }
    }

    /// Where this side sends from on a connection to a side that received
    /// `peer_received`: `None` if it no longer holds what that side lacks,
    /// or that side says it received more than this side sent.
    #[must_use]
    pub fn resume_from(&self, peer_received: u64) -> Option<u64> {
        (self.out_base..=self.sent())
            .contains(&peer_received)
            .then_some(peer_received)
    }

    /// Whether the host's side may go on with the guest's `hello`: it
    /// holds what the guest lacks, and it received no more than the guest
    /// sent. A guest restored from a checkpoint older than what the host
    /// received has sent other bytes since, which the host cannot take
    /// back, so it cannot go on.
    #[must_use]
    pub fn resumes(&self, hello: &Hello) -> bool {
        self.received <= hello.sent && self.resume_from(hello.received).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every frame `from` has to send after `cursor`, and the cursor after.
    fn frames(from: &Stream, mut cursor: u64) -> (Vec<u8>, u64) {
        let mut out = Vec::new();
        while let Some(next) = from.next_frame(cursor, &mut out) {
            cursor = next;
        }
        (out, cursor)
    }

    /// Feeds `bytes`, whole frames, to `to`.
    fn feed(to: &mut Stream, mut bytes: &[u8]) -> Result<Received, StreamError> {
        let mut last = Received::Taken;
        while let Some((frame, length)) = Frame::decode(bytes).unwrap() {
            last = to.receive(&frame)?;
            bytes = &bytes[length..];
        }
        assert_eq!(bytes, b"");
        Ok(last)
    }

    /// Everything `stream` hands on.
    fn drain(stream: &mut Stream) -> (Vec<u8>, bool) {
        let (mut bytes, mut ended) = (Vec::new(), false);
        while let Some(delivery) = stream.take(usize::MAX) {
            match delivery {
                Delivery::Bytes(more) => bytes.extend(more),
                Delivery::End => ended = true,
            }
        }
        (bytes, ended)
    }

    fn ack(from: &mut Stream, to: &mut Stream) {
        let mut out = Vec::new();
        if from.acknowledge(&mut out) {
            feed(to, &out).unwrap();
        }
    }

    #[test]
    fn bytes_and_the_end_go_across_in_chunks_and_both_sides_finish() {
        let (mut guest, mut host) = (Stream::new(), Stream::new());
        let payload: Vec<u8> = (0..200_000_u32).map(|n| n.to_le_bytes()[0]).collect();
        guest.push(&payload);
        guest.end();
        let (out, cursor) = frames(&guest, 0);
        assert_eq!(cursor, payload.len() as u64 + 1);
        feed(&mut host, &out).unwrap();
        assert_eq!(drain(&mut host), (payload.clone(), true));
        ack(&mut host, &mut guest);
        assert_eq!(guest.room(), 0, "an ended side adds nothing");
        assert!(!guest.finished(), "the host's direction has not ended");
        host.end();
        let (out, _) = frames(&host, 0);
        feed(&mut guest, &out).unwrap();
        assert_eq!(drain(&mut guest), (Vec::new(), true));
        ack(&mut guest, &mut host);
        assert!(host.finished() && guest.finished());
    }

    #[test]
    fn the_window_closes_until_the_other_side_hands_on_and_acknowledges() {
        let (mut guest, mut host) = (Stream::new(), Stream::new());
        guest.push(&vec![7; WINDOW]);
        assert_eq!(guest.room(), 0);
        let (out, _) = frames(&guest, 0);
        feed(&mut host, &out).unwrap();
        let mut empty = Vec::new();
        assert!(!host.acknowledge(&mut empty), "nothing handed on yet");
        assert_eq!(guest.room(), 0, "received is not acknowledged");
        let Some(Delivery::Bytes(first)) = host.take(1000) else {
            panic!("bytes")
        };
        assert_eq!(first.len(), 1000);
        ack(&mut host, &mut guest);
        assert_eq!(guest.room(), 1000);
    }

    #[test]
    fn a_new_connection_sends_again_only_what_the_other_side_lacks() {
        let (mut guest, mut host) = (Stream::new(), Stream::new());
        guest.push(b"first second");
        // The connection carried only "first " and an ack of it.
        let mut out = Vec::new();
        let cursor = guest.next_frame(0, &mut out).unwrap();
        assert_eq!(cursor, 12);
        let partial = Frame::Data {
            offset: 0,
            bytes: b"first ",
        };
        feed(&mut host, &{
            let mut bytes = Vec::new();
            partial.encode(&mut bytes);
            bytes
        })
        .unwrap();
        drain(&mut host);
        ack(&mut host, &mut guest);
        // It ended there; the guest says hello on another.
        let hello = guest.hello(StreamId(1));
        assert!(host.resumes(&hello));
        let from = guest.resume_from(host.received()).unwrap();
        assert_eq!(from, 6);
        let (out, _) = frames(&guest, from);
        feed(&mut host, &out).unwrap();
        assert_eq!(drain(&mut host).0, b"second");
    }

    #[test]
    fn sending_again_from_before_what_arrived_delivers_each_byte_once() {
        let (mut guest, mut host) = (Stream::new(), Stream::new());
        guest.push(b"abcdef");
        let (out, _) = frames(&guest, 0);
        feed(&mut host, &out).unwrap();
        feed(&mut host, &out).unwrap();
        let mut overlap = Vec::new();
        Frame::Data {
            offset: 4,
            bytes: b"efgh",
        }
        .encode(&mut overlap);
        feed(&mut host, &overlap).unwrap();
        assert_eq!(drain(&mut host).0, b"abcdefgh");
    }

    #[test]
    fn frames_that_cannot_follow_are_errors() {
        let mut host = Stream::new();
        let gap = Frame::Data {
            offset: 3,
            bytes: b"x",
        };
        assert_eq!(
            host.receive(&gap),
            Err(StreamError::Gap { at: 3, received: 0 })
        );
        assert_eq!(
            host.receive(&Frame::Ack(1)),
            Err(StreamError::AckPastSent { ack: 1, sent: 0 })
        );
        host.receive(&Frame::Data {
            offset: 0,
            bytes: b"ab",
        })
        .unwrap();
        assert_eq!(host.receive(&Frame::End(1)), Err(StreamError::PastEnd));
        host.receive(&Frame::End(2)).unwrap();
        assert_eq!(host.receive(&Frame::End(2)), Ok(Received::Taken), "again");
        assert_eq!(
            host.receive(&Frame::Data {
                offset: 2,
                bytes: b"c"
            }),
            Err(StreamError::PastEnd)
        );
        let mut flood = Stream::new();
        let chunk = vec![0; CHUNK];
        let mut offset = 0;
        while offset < WINDOW as u64 {
            flood
                .receive(&Frame::Data {
                    offset,
                    bytes: &chunk,
                })
                .unwrap();
            offset += CHUNK as u64;
        }
        assert_eq!(
            flood.receive(&Frame::Data {
                offset,
                bytes: b"z"
            }),
            Err(StreamError::Overrun)
        );
        assert_eq!(flood.receive(&Frame::Abandon), Ok(Received::Abandoned));
    }

    #[test]
    fn a_guest_restored_from_an_older_checkpoint_cannot_resume_once_it_diverged() {
        let (mut guest, mut host) = (Stream::new(), Stream::new());
        guest.push(b"before");
        let (out, cursor) = frames(&guest, 0);
        feed(&mut host, &out).unwrap();
        drain(&mut host);
        host.push(b"reply");
        let (reply, _) = frames(&host, 0);
        feed(&mut guest, &reply).unwrap();
        drain(&mut guest);
        // The checkpoint: what the guest is when restored.
        let checkpoint = guest.hello(StreamId(9));
        assert!(host.resumes(&checkpoint), "nothing moved since");

        // After it, the guest sent more and acknowledged the reply.
        guest.push(b" after");
        let mut more = Vec::new();
        guest.next_frame(cursor, &mut more).unwrap();
        feed(&mut host, &more).unwrap();
        ack(&mut guest, &mut host);
        assert!(
            !host.resumes(&checkpoint),
            "the host received what the restored guest never sent"
        );

        // Nor may a guest go on that lacks what the host already dropped.
        let mut quiet = Stream::new();
        quiet.push(b"reply");
        let behind = Hello {
            id: StreamId(9),
            received: 0,
            sent: 0,
        };
        let mut ack_all = Vec::new();
        Frame::Ack(5).encode(&mut ack_all);
        feed(&mut quiet, &ack_all).unwrap();
        assert!(!quiet.resumes(&behind));
        assert_eq!(quiet.resume_from(0), None);
        assert_eq!(quiet.resume_from(6), None, "more than was sent");
    }
}
