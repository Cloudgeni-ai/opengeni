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
default base. Exact `~` / `~/...` paths resolve against the service user's home;
ordinary relative and absolute paths retain their usual meaning. The control plane
never `git clone`s a repo onto the machine.

## Crates

| Crate | Role |
|---|---|
| `opengeni-agent-proto` | Generated wire-protocol types (Rust side of the codegen). |
| `opengeni-agent` | The binary: `run`/`connect`/`connections`/`disconnect`/`service`/`update`/`uninstall`; multi-deployment dial, RPC dispatch, supervisor. |
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
  the script body** + a sha256 — then installs to a per-user path, connects the
  requested workspace, and leaves the ordinary background service running. It
  contains **no secrets**. Read it before
  piping. `OPENGENI_INSTALL_BASE_URL` overrides the asset base (e.g. a local mock
  dir or the direct GitHub-Releases URL). [`install/uninstall.sh`](install/uninstall.sh)
  removes it (`--purge` also deletes credentials + deactivates the enrollment).
- **Signing key** — the minisign **public** key is committed at
  [`install/opengeni-agent-minisign.pub`](install/opengeni-agent-minisign.pub) and
  embedded in both install scripts + `opengeni-agent-update` (one key, one verify
  routine for install AND self-update). The **private** key is the GitHub Actions
  secret `OPENGENI_AGENT_MINISIGN_KEY` — never in the repo.
- **Self-update** — `opengeni-agent update [--check]` discovers signed manifests
  from the enrolled deployments, verifies minisign + sha256 + version monotonicity,
  selects the highest valid release, atomically self-replaces, executes the swapped
  binary as a health gate, and automatically rolls back on failure. A tampered or
  non-booting artifact is always rejected.
- **Background service** — `opengeni-agent start|stop|status` is the normal simple
  lifecycle; `service install|uninstall|...` is the advanced surface. It uses a
  systemd user/system unit, macOS LaunchAgent, or Windows Service. Repeated `start`
  repairs the definition without disrupting a running same-version process;
  `start --restart` activates a real binary upgrade once. The generated service
  preserves the installer's command `PATH`; agent commands retain that normal
  machine environment, while the lifecycle CLI resolves the operating system's
  real systemd tools ahead of unrelated user shims. `service install --print` is the dry run.
  `opengeni-agent run` remains the explicit foreground mode.
- **Pipelines** — `.github/workflows/agent-ci.yml` (fmt/clippy/test/build +
  install-smoke across ubuntu/macOS/Windows per PR) and `.github/workflows/agent-release.yml`
  (matrix build → minisign-sign + sha256 → GitHub Release; macOS notarize + Windows
  Authenticode are guarded creds-drop-ins that skip cleanly when absent).

## One agent, many OpenGeni deployments

Install the binary once, then run the one-liner from every workspace you want
this machine to serve. `opengeni-agent connect` adds or refreshes only that exact
deployment/workspace pair; it never replaces other credentials. A running agent
reconciles the connection directory live within a few seconds.

```sh
opengeni-agent connections
opengeni-agent disconnect <connection-id-or-prefix>
```

Credentials live as independent owner-only documents under
`$OPENGENI_CONFIG_DIR/connections/` (or the platform config default). The local
identity is derived from **API origin + workspace id**, so unrelated deployments
may safely contain the same workspace UUID. Each link owns its NATS bearer, relay
token, epoch, reconnect loop, and stream registrar. Links share one host-capacity
sampler, one operation engine/spool ledger, and the OS containment manager.
Operation ids and admission origins are locally namespaced by connection, so one
deployment cannot cancel, query, acknowledge, detach, or collide with another's
work. Removing one connection sends its own going-offline event and leaves every
other link and command running.

The control plane deliberately rotates each connection's short-lived NATS user
JWT. That expected expiry reconnects immediately with the durable enrollment
bearer; established op-stream commands detach, keep running, and replay any
missed output after re-attachment. Full-jitter backoff is reserved for actual
transport failures.

On Linux the systemd aggregate is deliberately unlimited and each accepted host
operation gets a separate cgroup-v2 leaf. The supervisor has its own leaf carrying
systemd-oomd's avoid marker before it is moved, so memory pressure in a command
cannot erase the control process's protection. Local opt-in operation limits apply
only to command leaves; the default remains the machine's available resources.

An installation upgraded from the old single-connection file keeps that link
online immediately. Because the old file did not record its deployment URL,
`connections` labels the migrated origin unverified; running the exact
deployment's connect command once confirms the origin and replaces only that
legacy record. An unverified URL hint is never used as an update source; the
signed public channel (or an explicit `update --base-url …`) remains the safe
fallback until reconnect confirms it. Self-update is binary-wide: matching
per-connection channels are used automatically, while mixed `stable`/`beta`
links require an explicit `opengeni-agent update --channel …` choice instead of
silently picking one.

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
