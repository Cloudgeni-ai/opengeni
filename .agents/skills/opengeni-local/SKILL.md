---
name: opengeni-local
description: Install, start, stop, restart, or troubleshoot OpenGeni on a local computer, including a fresh machine with missing dependencies. Use for trying OpenGeni locally, not production deployment or product integration.
---

# Run OpenGeni locally

Get the complete local OpenGeni app running and give the user its working URL.
Handle setup yourself; ask only for decisions or actions the user must supply.
Model connection is a next step, not a prerequisite for getting the app running.

## Find or create the checkout

The public repository is https://github.com/Cloudgeni-ai/opengeni.
An installed copy of this skill is not an application checkout. Reuse the user's
chosen checkout, or clone the repository into an unused directory. No GitHub
login is needed. Preserve existing work, configuration, and data; do not switch
branches or upgrade an existing installation just to start it.

Read the checkout's `AGENTS.md`, the local-start section of `README.md`, and
`docs/local-development.md`. Use those and the startup scripts as the current
authority. Do not load the maintainer or SDK skill for ordinary setup.

## Prepare this machine

Inspect the OS, architecture, installed tools, available memory/disk, and any
existing OpenGeni launcher. Run on macOS or Linux; on Windows use WSL2, keeping
the checkout and toolchain inside Linux. If OS installation, a restart, or an
interactive permission prompt is necessary, explain that specific next step.

Install missing prerequisites from official sources, using existing package
managers where appropriate:

- Git and curl to obtain the source and downloads.
- Bun at the exact version in `.bun-version`, not whatever is latest. Verify
  the binary the launch shell will actually use (`bun --version`).
- rustup and a C build toolchain: Xcode Command Line Tools on macOS, or
  `build-essential` on Debian/Ubuntu. The launcher installs the checked-in Rust
  toolchains and targets through rustup; do not replace the user's default Rust.
- Any installer prerequisites reported by the platform, such as unzip.

Choose infrastructure based on the machine and the user's preference:

- **Docker:** the usual local choice. Verify the daemon, Compose, and buildx
  work, not just that a `docker` command exists. First startup builds a sandbox
  image and needs substantial disk space. Retain an existing working setup.
- **Native:** useful on Linux without Docker or with limited resources. Read
  [native setup](references/native-setup.md) before using it. This normally
  selects the `local` sandbox, whose commands run on this host rather than in
  Docker. Explain that execution choice; preserve explicitly configured remote
  sandbox providers. Do not silently use `none` to make startup pass.

Do not infer that native prerequisites are installed just because the launcher
can select that backend. Check resource pressure during builds rather than
inventing a minimum-memory guarantee or changing swap on every machine.

## Start and verify

Create `.env` from `.env.example` only if missing. Keep the local access mode for
a fresh evaluation and use the launcher's generated secrets and port selection.
Do not copy another installation's credentials, database URLs, or `.env.runtime`.
Keep the evaluation private to the user's machine; remote-machine access needs
a private tunnel or other explicitly chosen access path.

Run `bun run dev` from the checkout in a terminal or supervised process that
will stay alive after your response. Keep its terminal/process reference and
log location. This owns dependency installation, infrastructure, migrations,
builds, the API, both workers, artifact services, and the web app. Use a healthy
existing launcher instead of starting a competing one.

Follow logs through the first build. Fix missing tools, failed downloads, or
PATH issues and retry; preserve database state and do not bypass startup checks.
If a source defect prevents setup, report the exact blocker instead of making
unrequested application changes or claiming success with components disabled.

Wait for **`OpenGeni dev stack ready`**, then check the printed API `/healthz`
and web URL. Confirm both control and turn workers are running. Use the actual
selected ports, not assumed 3000/8000 values; `.env.runtime` records them. A
listening Vite server alone is not a successful install.

Return the working web link, checkout location, and short stop/restart directions.
If no model is connected, say the app is ready and model connection is the next
step. Do not stall installation to collect a provider preference or enumerate
every provider. When requested, use the current UI and `docs/model-providers.md`
to guide login/key entry without placing credentials in chat. Only claim a real
task works after observing a model response and the requested tool execution.

## Stop or restart

Stop the owning `bun run dev` launcher first (Ctrl-C in its terminal, or signal
the exact process you started). Give the user that terminal or a verified PID;
never suggest name-wide `pkill` or `killall`, since other checkouts may be running.
Then `bun run dev:down` stops this checkout's
infrastructure; it does not stop the host app processes by itself. Restart with
`bun run dev` from the same checkout, preserving its `.env` and data.

`bun run dev:clean -- --yes` deletes this project's data and is only for an
explicitly requested reset. Do not use it as a routine restart or prune shared
Docker resources to fix one checkout.
