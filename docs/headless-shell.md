# Optional Chromium headless shell

The placement-resident browser controller can use the official Chrome for Testing
headless shell for **new managed headless Chromium profiles**. This is real Blink
rendering, including screenshots, responsive viewports and CDP streaming. It has
no native desktop window and cannot link a ComputerSession. Headed sessions,
attached Chrome, external providers, Lightpanda and the default executable remain
unchanged. Selecting `headed: false` still requires an operator-enabled placement.

## Installation and opt-in

The initial pinned bundle supports Linux x86-64 only. On that machine, from a
reviewed source checkout, install to a new operator-owned directory:

```sh
bun packages/browserd/scripts/install-headless-shell.ts /opt/opengeni/headless-shell-150.0.7871.46
```

The installer downloads the exact Google archive, verifies its recorded SHA-256,
extracts it and verifies every bundled file. It refuses an existing destination.
Configure the controller process explicitly:

```sh
OPENGENI_BROWSERD_HEADLESS_SHELL_DIRECTORY=/opt/opengeni/headless-shell-150.0.7871.46/bundle
```

Controller startup verifies the complete pinned bundle again. Installation does
not change native-agent releases, image defaults, running browsers or services;
there is no download on startup and no automatic switch on failure. The digest
is a repository-reviewed record of the official archive, not an upstream signed
checksum. Keep the installed directory protected from modification as with the
other placement executables. The installer requires `unzip` and Chromium's usual
Linux shared libraries; it introduces no sandbox-disabling flags.

## Profiles and recovery

Existing or restored profiles without a shell marker keep the ordinary Chromium
launcher. A new shell profile carries a private version marker in its profile,
including through profile suspend/restore. Recovery requires the matching verified
shell and a headless session; it fails closed if the operator removes the opt-in.
Do not delete that marker to force a different executable. The existing private
profile, downloads, proxy configuration, process teardown and CDP adapter remain
in use. Disable opt-in only after ending or moving shell sessions to a placement
with the matching bundle. No profile is automatically converted or deleted.

Headless shell does not persist session cookies itself. Controlled profile capture
adds a private cookie capsule inside the authenticated, encrypted profile archive;
it restores session cookies before loading saved tabs. The capsule never becomes
a plaintext profile file, public manifest or tool result. Persistent cookies and
other browser storage continue to use the Chromium profile.

An unexpected shell process loss cannot safely reconstruct newer session cookies.
The controller therefore refuses automatic recovery for shell sessions instead
of silently restarting with missing login state. Restore an explicitly saved
profile revision or start a new session. This limitation does not apply to the
ordinary Chromium recovery path.

This path remains opt-in pending broader product acceptance. Resource savings
vary with page complexity; it is not a promise of a fixed memory reduction.
