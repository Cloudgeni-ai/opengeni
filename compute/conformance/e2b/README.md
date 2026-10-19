# E2B conformance

Checks that unchanged E2B clients work against the E2B front door in
`compute-control` ([ADR 19](../../docs/adr/0019-e2b-compatible-front-door-and-guest-init.md)).

`run.sh` starts a whole fleet on one lab host: the control service with its
front door serving HTTPS for `api.e2b.test` and `*.e2b.test`, a host agent
in the fleet with its guard, and object storage (a local Azurite unless
`STORE` names one). It builds the public Opengeni sandbox image as the
`base` template and `busybox:1.37` as `minimal`, an image without bash.
Then it runs four suites against the front door:

| Suite | What it runs |
| --- | --- |
| `sdk` | `sdk.mjs`: the E2B JS SDK 2.56.0, unchanged. Lifecycle, commands, PTYs, files and signed URLs, ports, private traffic, pause and resume, waking on traffic, timeouts, what keeps a sandbox awake, the minimal image. |
| `headers` | The core of `sdk.mjs` again, with every request sent to one address and routed by the `E2b-Sandbox-Id` and `E2b-Sandbox-Port` headers (`E2B_SANDBOX_URL`). |
| `adapter` | `adapter.mjs`: the E2B client from `@openai/agents-extensions` 0.14.3, built with the options Opengeni's e2b backend passes, through a turn: manifest, commands, PTY, editor, exposed port, workspace tar, serialize, pause, resume, delete. |
| `smoke` | The `ecw.*` smoke scenarios with `COMPUTE_SMOKE_TARGET=e2b` (`../../smoke`). |

```sh
CONTROL_BIN=target/release/compute-control HOST_BIN=target/release/compute-host \
  GUEST=~/guest-out PROFILE=nested sudo -E conformance/e2b/run.sh
```

It needs root, a lab host (`../../lab/host-setup.sh`), python 3.10 or
later, curl, openssl, and ports 443, 10000, 17443, 18080 and 18443 free on
127.0.0.1. It sets up the rest itself: node 22 when PATH has none (a
pinned, checksummed download into `$LAB/tools`), the clients, certificates,
object storage, the control service and the host agent. When something is
missing or a port is taken it fails; it never skips a suite. The Linux
gate (run before every merge into lab) runs it.

Names under `e2b.test` resolve to 127.0.0.1 inside the suites
(`resolve.cjs`); nothing outside the host is reached except the image
registries, nodejs.org and npm. Results, with each suite's measurements,
go to `$WORK/results` (`/lab/t/e2b-conformance/results`); it prints
`CONFORMANCE_PASSED` or `CONFORMANCE_FAILED`.

The clients are pinned to exact versions in `package.json`.
