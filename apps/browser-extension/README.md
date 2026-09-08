# OpenGeni Browser

Chrome Manifest V3 bridge to the separately installed OpenGeni machine agent.
See [connected machines](../../docs/connected-machines.md) for runtime setup.

Run `bun run build` in this directory for the unpacked extension and TAR.
For a Web Store upload, run `bun scripts/build.ts --store` (requires `zip`).
Upload `dist/opengeni-browser-extension-store.zip`. The store archive omits the
development manifest key; the unpacked archive preserves it.

The assigned Chrome Web Store item ID is `phpmmcbeelfkcinjfbbggegjdcdmnnch`.
The native agent must support that exact origin in both its installed native
messaging manifest and command-line dispatch. Do not publish an extension that
requires a host release users cannot install yet.

The extension privacy notice is [PRIVACY.md](PRIVACY.md). Store descriptions
must disclose the local agent requirement and the forwarding of browser data
to the configured deployment.
