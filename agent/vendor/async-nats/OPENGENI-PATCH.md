# Retained publication receipts

This is the published `async-nats` 0.46.0 crate, from upstream revision
`49d9e80bd8bc14aa4505599fd6e7e8f6b493ee53` (`async-nats` directory).
The original crate archive SHA256 is
`df5af9ebfb0a14481d3eaf6101e6391261e4f30d25b26a7635ade8a39482ded0`.
Its source copyright headers remain intact. `LICENSE` contains the Apache 2.0
license from that exact upstream revision. The declared Rust 1.79 requirement
remains compatible with the agent workspace's Rust 1.82 minimum.

The local changes are confined to three source files and synthetic tests:

- `connection.rs` treats every nonempty internal write buffer as pending work,
  including a first write that returns `Pending` before any bytes are accepted.
- `client.rs` adds `publish_with_flush`, preserving ordinary subject and payload
  validation. Its command carries the publication and settlement receipt together.
- `lib.rs` attaches the receipt when that command enters its actual connection.
  Success requires empty internal buffers and a successful flush on that stream.
  Leaving the connection processor fails attached receipts before reconnecting,
  including cancellation, panic and closure. A replacement socket cannot redeem
  an old receipt. Commands not yet handled have not been dispatched and retain
  the client's ordinary queue behavior.
- `flush_custody_tests.rs` exercises the actual handler and client with paused
  sequential and vectored streams, cancellation, validation, and a real TCP
  replacement connection after a partial write.

This confirms transport settlement, not server processing or consumer storage.
Receipt failure remains an unknown publication outcome; it does not authorize
replaying the publication. Ordinary queued publication stays unchanged.

The package is excluded from the workspace's member set. Native CI runs its
focused library tests explicitly; unrelated upstream server integration tests
are not part of the agent suite. Remove this vendored copy when an upstream
release compatible with the supported Rust minimum provides these guarantees.
