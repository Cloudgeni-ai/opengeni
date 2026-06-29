# Evidence — baked-agent install.sh end-to-end verification (local, no cloud build)

Decision: "the agent ships inside the control-plane" — the per-SHA API image bakes
the signed `opengeni-agent` Linux musl binary and serves it from `/agent/*`;
install.sh downloads it, verifies sha256 + minisign against the pinned key, installs.

This is the LOCAL proof that the serving + verify chain works end-to-end. The cloud
preview build/deploy is owned by the coordinator.

## Toolchain (NixOS host, x86_64)

- Rust musl build of `opengeni-agent` (static, 7.9 MB ELF64) via the nix
  `pkgsCross.musl64` cross-cc (`x86_64-unknown-linux-musl-gcc`). CI uses
  cargo-zigbuild (agent-release.yml / scripts/bake-agent.sh) for the same static link.
- `rsign` (rsign2, pure-Rust minisign) for signing + the install.sh verify path.

## Minisign keypair (rotated — see PR report)

The repo secret `OPENGENI_AGENT_MINISIGN_KEY` is ABSENT and the previously pinned
pubkey had no confirmable matching secret, so a fresh passwordless keypair was
generated. New pinned pubkey (now in install.sh / install.ps1 / the .pub file /
agent-update verify.rs):

    RWSaqgF1EVFuci7hXvDJO7cBh2xf2k0XKhCpvl23aWKG+nMAGfZ6D2Pn   (key id 726E51117501AA9A)

Secret key written ONLY to /tmp/oge-secrets/oge-agent-minisign.key (0600, never
committed). The coordinator must store it as the `OPENGENI_AGENT_MINISIGN_KEY` GH
secret before any deployed-env build can sign.

## Local API harness

`registerInstallRoutes` (the real serving code) mounted on a fresh Hono app, served
with Bun.serve. The baked dir agent/install/baked/ held the signed x86_64 musl
binary + .sha256 + .minisig.

### Route probes

    install.sh             -> 200
    baked musl bin         -> 200 ctype=application/octet-stream
    baked .sha256          -> 200 ctype=text/plain; charset=utf-8
    baked .minisig         -> 200 ctype=text/plain; charset=utf-8
    mac asset (not baked)  -> 302 https://github.com/Cloudgeni-ai/opengeni/releases/latest/download/opengeni-agent-universal-apple-darwin
    aarch64 (not baked)    -> 302 https://github.com/Cloudgeni-ai/opengeni/releases/latest/download/opengeni-agent-aarch64-unknown-linux-musl

Baked Linux musl = served locally; everything else = GitHub-Releases 302 fallback.

## install.sh end-to-end (baked, happy path)

    $ OPENGENI_INSTALL_BASE_URL=http://127.0.0.1:8833 OPENGENI_NO_RUN=1 \
      OPENGENI_INSTALL_DIR=/tmp/.../bin sh agent/install/install.sh
    opengeni-install: installing opengeni-agent-x86_64-unknown-linux-musl (version: latest) from http://127.0.0.1:8833
    opengeni-install: downloading binary + checksum + signature
    opengeni-install: sha256 checksum OK
    opengeni-install: minisign signature verified (rsign2)
    opengeni-install: installed verified binary to /tmp/.../bin/opengeni-agent
    install.sh EXIT: 0

    $ /tmp/.../bin/opengeni-agent --version
    opengeni-agent 0.1.0

Download -> sha256 (GATE 1) -> minisign verify against the pinned key (GATE 2) ->
install all pass, and the installed binary runs.

## install.sh negative test (tampered binary, stale signature)

Tampered the served binary + re-checksummed (GATE 1 passes) but kept the original
signature (now stale):

    opengeni-install: sha256 checksum OK
    opengeni-install: ERROR: rsign2 signature verification FAILED for opengeni-agent-x86_64-unknown-linux-musl
    install.sh EXIT: 5   (nothing installed)

GATE 2 fails closed — the minisign verify is genuinely enforced, not a no-op.
