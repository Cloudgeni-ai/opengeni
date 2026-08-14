# opengeni-agent-linux-ffi

Small Linux-only unsafe boundary for process setup that Rust requires to run
between `fork` and `exec`.

The public API installs an async-signal-safe OOM-bias hook on a Tokio command.
All raw operations are confined to `src/ffi.rs`; the rest of the agent workspace
retains `unsafe_code = "forbid"`.
