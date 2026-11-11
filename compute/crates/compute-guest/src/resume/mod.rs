//! Resumable streams between the guest and its host's agent link.
//!
//! Firecracker resets every vsock connection whenever it takes a snapshot,
//! a checkpoint of a running VM included, and the host's side of each
//! connection ends with its VM process. A connection the agent made to the
//! host would end with it, and whatever was in flight with it. So each TCP
//! connection the agent opens to the guest's forwarder is carried as one
//! logical stream that outlives the vsock connections under it:
//!
//! - The guest names each stream with a random [`StreamId`] and opens a
//!   vsock connection with a [`Hello`] line: the stream, what it has
//!   received and what it has sent. The host answers with an [`Answer`]:
//!   what it has received of the stream, or that it has none to resume.
//! - Both then send [`Frame`]s: data tagged with its offset in the stream,
//!   acknowledgements of what the receiver handed on, the end of a
//!   direction, and the abandoning of the whole stream.
//! - Each side keeps what it sent until the other acknowledges it, and no
//!   more than [`WINDOW`] of it: past that it stops reading its own side.
//!   When a vsock connection ends without the stream ending, the guest
//!   connects again with the stream's counts, and each side sends again
//!   what the other lacks.
//! - A host that does not know the stream, or whose counts cannot be put
//!   together with the guest's, answers `gone`: the guest then ends the TCP
//!   connection, and the agent connects again as it would to a NATS server
//!   that went away.
//!
//! [`wire`] and [`stream`] are the bytes and the state, with no I/O; the
//! guest's side runs on threads in [`relay`], the host's in the host agent.

pub mod relay;
pub mod stream;
pub mod wire;

pub use stream::{Delivery, Stream, StreamError, WINDOW};
pub use wire::{Answer, CHUNK, Frame, Hello, LINE_MAX, StreamId, WireError};
