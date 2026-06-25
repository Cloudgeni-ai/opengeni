# `opengeni-agent` — the self-hosted agent (Rust workspace)

The Rust agent that turns a user's own machine into a first-class OpenGeni
sandbox (the `selfhosted` backend). This is a standalone Cargo workspace — it is
**not** part of the bun monorepo (the bun workspaces glob excludes it, and
`agent/target/` is gitignored).

> Status: **M0** — only the wire protocol + codegen + the round-trip test are
> real. The other crates are minimal stubs; their content lands in later
> milestones (see `.agent/implementation-dossier.md` §11/§24).

## Crates

| Crate | Role |
|---|---|
| `opengeni-agent-proto` | Generated wire-protocol types (Rust side of the codegen). **The M0 deliverable.** |
| `opengeni-agent` | The binary: enrollment, dial, RPC dispatch, supervisor (stub). |
| `opengeni-agent-platform` | Per-OS `Platform`/`ServiceManager` abstraction (stub). |
| `opengeni-agent-stream` | Relay-edge stream transport + pty/framebuffer pumps (stub). |
| `opengeni-agent-update` | Self-update: signed-manifest discovery, verify, atomic replace, rollback (stub). |

## Wire protocol — single source of truth

The protocol is defined **once** in [`proto/opengeni_agent.proto`](proto/opengeni_agent.proto)
(proto3, package `opengeni.agent.v1`) and code-generated to **both** stacks so the
control plane (TypeScript) and the agent (Rust) can never drift:

- **Rust:** `opengeni-agent-proto`'s `build.rs` compiles the proto via
  [`prost`] + [`protox`] (a pure-Rust protobuf compiler — **no `protoc` binary
  needed**, so `cargo build` is hermetic, incl. on NixOS). Generated types live in
  `opengeni_agent_proto::v1`.
- **TypeScript:** [`ts-proto`] generates `packages/agent-proto/src/gen/`, shipped
  as the `@opengeni/agent-proto` package and consumed by the control plane.

### Regenerate everything (one command)

```sh
agent/scripts/codegen.sh        # regenerates BOTH Rust and TS from the proto
```

`protoc` for the TS side is resolved from `nixpkgs#protobuf` automatically (or set
`PROTOC` / put `protoc` on `PATH`). The Rust side regenerates on any `cargo build`.

### Round-trip test (the "no drift" proof)

```sh
agent/scripts/roundtrip.sh      # Rust-encode -> TS-decode AND TS-encode -> Rust-decode
```

Both stacks encode an identical canonical corpus; each decodes the other's bytes
and asserts field-equality, and for map-free messages asserts **byte-for-byte**
wire equality. A green run proves the two generated stacks agree. The fixtures
(`tests/fixtures/{rust,ts}_encoded.txt`) are committed so `cargo test` and
`bun test packages/agent-proto/test/roundtrip.test.ts` each pass standalone.

[`prost`]: https://docs.rs/prost
[`protox`]: https://docs.rs/protox
[`ts-proto`]: https://github.com/stephenh/ts-proto
