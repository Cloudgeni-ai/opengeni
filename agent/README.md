# `opengeni-agent` — the Connected Machine agent (Rust workspace)

The Rust agent that turns a user's own machine into a **Connected Machine** — a
first-class, co-equal PRIMARY OpenGeni compute target (the `selfhosted` backend,
internally). This is a standalone Cargo workspace — it is **not** part of the bun
monorepo (the bun workspaces glob excludes it, and Cargo build output is gitignored).

**How the control plane treats a Connected Machine** (canonical:
[`../docs/architecture.md`](../docs/architecture.md) §3.8 and [`../AGENTS.md`](../AGENTS.md)):
a machine-targeted turn runs on this agent **directly** — the control plane
establishes the session on the machine and does **not** create, lease, or bill a
cloud box for it. It ships the machine **no OpenGeni credential**: the platform
GitHub-App token mint is skipped and exec carries `env: {}` on the wire, so this
agent authenticates git with the machine's **own** credentials. The session runs
under a **per-session working directory** (the control plane's `sessions.working_dir`,
threaded to the agent as `workingDir`); the agent's reported `workspace_root` is the
default base, and the control plane never `git clone`s a repo onto the machine.

## Canonical command inventory

The only installed executable is **`opengeni-agent`**. It is not a subcommand of
another OpenGeni CLI: there is no standalone `opengeni` executable, and neither
`opengeni agent` nor `opengeni agents` is a supported command. Do not add a
wrapper, spaced form, plural alias, or documentation shortcut for them.

The complete command surface is:

```text
opengeni-agent [--api-url <origin>] run [run options]
opengeni-agent [--api-url <origin>] enroll [enroll options]
opengeni-agent service install|uninstall|start|stop|status|logs
opengeni-agent update [--check] [--base-url <origin>] [--channel <channel>]
opengeni-agent uninstall [--purge [--local-only]]
```

The service verbs are real on Linux (systemd) and macOS (a per-user LaunchAgent).
On Windows every service verb, including `install --print`, returns one explicit
unsupported error without invoking `sc.exe`; the supported Windows lifecycle is
foreground `opengeni-agent run`. A direct `uninstall` attempts service cleanup and
can purge enrollment credentials/state, but retains the running executable.
`install/uninstall.sh` removes the file after that process exits.

There are currently **no CLI compatibility aliases**. Existing persisted-state
compatibility (for example the legacy `nats_credentials` JSON field) is unrelated
to the executable command surface and remains unchanged.

## Crates

| Crate | Role |
|---|---|
| `opengeni-agent-proto` | Generated wire-protocol types (Rust side of the codegen). |
| `opengeni-agent` | The binary: `run`/`enroll`/`service`/`update`/`uninstall`; dial, RPC dispatch, supervisor. |
| `opengeni-agent-platform` | Per-OS `Platform` + systemd/launchd service definitions; explicit Windows SCM unsupported contract. |
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
  piping. `OPENGENI_INSTALL_BASE_URL` overrides the asset base with an origin that
  implements `/agent/latest/*` and `/agent/v<ver>/*` (for example a local mock).
  The installer itself exists only at `<base>/install.sh`; direct GitHub Release
  assets are an archive, not a route-compatible installer base.
  [`install/uninstall.sh`](install/uninstall.sh) removes the executable/bundle
  (`--purge` also deletes credentials + deactivates the enrollment).
- **Signing key** — the minisign **public** key is committed at
  [`install/opengeni-agent-minisign.pub`](install/opengeni-agent-minisign.pub) and
  embedded in both install scripts + `opengeni-agent-update` (one key, one verify
  routine for install AND self-update). The **private** key is the GitHub Actions
  secret `OPENGENI_AGENT_MINISIGN_KEY` — never in the repo.
- **Self-update** — `opengeni-agent update [--check]` fetches the signed stable
  manifest at `<base>/agent/stable/manifest.json` and fully downloads/verifies the
  candidate with minisign + sha256 + version monotonicity. On Linux/Windows, apply
  atomically self-replaces (including Windows rename-self-aside) and retains the
  previous binary as a **manual** rollback copy; the foreground user or supervisor
  must restart it. On macOS, check-only works but apply fails **before any write**:
  mutating only `.app/Contents/MacOS/opengeni-agent` would invalidate the signed
  bundle/TCC identity, so the error directs the user to reinstall the complete
  verified bundle with `curl -fsSL '<base>/install.sh' |
  OPENGENI_INSTALL_REPLACE_APP=1 sh`. This command does not claim an automatic
  post-restart health gate or rollback. A tampered artifact is always rejected.
  `beta` requires an explicit custom publication origin.
- **Service (opt-in)** — `opengeni-agent service install|uninstall|start|stop|status|logs`
  installs an always-on service on Linux (systemd user/system unit) or macOS
  (per-user LaunchAgent). `logs` is bounded by default and `--follow` is explicit;
  `--print` dry-runs the generated unit/plist. Windows service hosting is not
  implemented and every service action fails without mutation. The default remains
  foreground `run` on every OS.

### macOS compatibility versus live acceptance

The source contains a ScreenCaptureKit/CGEvent backend behind the experimental
`macos-desktop` Cargo feature. Stable release artifacts intentionally build with
default features, so that backend is disabled and stable macOS agents report
`display_unavailable`. Native compilation and unit tests are **compatibility
evidence only**, not proof that a Mac is ready for desktop use. Service persistence
is deliberately a per-user `LaunchAgent` in the logged-in `gui/<uid>` Aqua domain
— never a LaunchDaemon or system scope.

Enabling the feature in stable requires all of: a signed and notarized stable app
bundle, full-bundle update/reinstall verification (never an in-place Mach-O swap),
a live Mac with a logged-in Aqua user, human Screen Recording and Accessibility
grants, and human whole-machine enrollment consent. A live consenting Mac must
accept capture, input, relaunch, and full-bundle replacement while preserving the
expected identity/grants; CI/cross-compilation cannot grant or prove them.
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
