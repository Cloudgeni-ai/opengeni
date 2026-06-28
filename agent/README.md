# `opengeni-agent` — the self-hosted agent (Rust workspace)

The Rust agent that turns a user's own machine into a first-class OpenGeni
sandbox (the `selfhosted` backend). This is a standalone Cargo workspace — it is
**not** part of the bun monorepo (the bun workspaces glob excludes it, and
`agent/target/` is gitignored).

## Crates

| Crate | Role |
|---|---|
| `opengeni-agent-proto` | Generated wire-protocol types (Rust side of the codegen). |
| `opengeni-agent` | The binary: `run`/`enroll`/`service`/`update`/`uninstall`; dial, RPC dispatch, supervisor. |
| `opengeni-agent-platform` | Per-OS `Platform` + the `service` (systemd/launchd/SCM) renderer. |
| `opengeni-agent-stream` | Relay-edge stream transport + pty/framebuffer pumps. |
| `opengeni-agent-update` | Self-update: signed-manifest discovery, minisign+sha256 verify, atomic replace, rollback. |
| `opengeni-relay` | The stateless stream-relay edge image. |

## Distribution + self-update (M11)

The agent reaches a user's machine via one trusted line and keeps itself current.

- **Install scripts** — [`install/install.sh`](install/install.sh) (strict POSIX
  `sh`, Linux + macOS) and [`install/install.ps1`](install/install.ps1) (Windows).
  Each detects os/arch, resolves the matching GitHub-Release asset, downloads it,
  **verifies it two ways** — a minisign signature against a public key **pinned in
  the script body** + a sha256 — then installs to a per-user path and prints the
  enroll+run command. It installs **no service by default** (foreground `run` is
  the default run model, dossier §23.0) and contains **no secrets**. Read it before
  piping. `OPENGENI_INSTALL_BASE_URL` overrides the asset base (e.g. a local mock
  dir or the direct GitHub-Releases URL). [`install/uninstall.sh`](install/uninstall.sh)
  removes it (`--purge` also deletes credentials + deactivates the enrollment).
- **Signing key** — the minisign **public** key is committed at
  [`install/opengeni-agent-minisign.pub`](install/opengeni-agent-minisign.pub) and
  embedded in both install scripts + `opengeni-agent-update` (one key, one verify
  routine for install AND self-update). The **private** key is the GitHub Actions
  secret `OPENGENI_AGENT_MINISIGN_KEY` — never in the repo.
- **Self-update** — `opengeni-agent update [--check]` fetches a signed channel
  manifest, verifies minisign + sha256 + version-monotonicity, atomically self-
  replaces (incl. the Windows rename-self-aside), and rolls back to the prior
  binary on a failed boot health-gate. A tampered artifact is always rejected.
- **Service (opt-in)** — `opengeni-agent service install|uninstall|start|stop|status`
  installs an always-on service (systemd user/system unit, macOS LaunchAgent,
  Windows Service). `--print` dry-runs the generated unit/plist. The default
  remains foreground `run`.
- **Pipelines** — `.github/workflows/agent-ci.yml` (fmt/clippy/test/build +
  install-smoke across ubuntu/macOS/Windows per PR) and `.github/workflows/agent-release.yml`
  (matrix build → minisign-sign + sha256 → GitHub Release; macOS notarize + Windows
  Authenticode are guarded creds-drop-ins that skip cleanly when absent).

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
