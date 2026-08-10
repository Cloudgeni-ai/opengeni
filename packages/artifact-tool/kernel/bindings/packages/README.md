# Artifact kernel target package skeletons

`targets.json` is the checked-in, ordered build matrix for the generated
`@opengeni/artifact-kernel-*` packages. It contains build inputs only—never
prebuilt or placeholder binaries.

`scripts/materialize-artifact-kernel-packages.ts` converts explicitly supplied,
already-built binding assets into deterministic package directories. Native
assets use `bindings/dist/native/<target>/opengeni_artifact_kernel.node`; the
generated browser package uses the verified `bindings/dist/wasm-web`
wasm-bindgen output and contains the complete cross-target release matrix.
Normal browser editors instead consume one publishable, committed workspace
package per lazy capability boundary:

- `@opengeni/artifact-kernel-wasm-spreadsheet`
- `@opengeni/artifact-kernel-wasm-document`
- `@opengeni/artifact-kernel-wasm-presentation`

Each package contains only its real wasm-bindgen glue/binary pair,
declarations, and hash/size manifest. Its entry point exports exact asset URLs
and the typed kernel/protocol/model/command/build identity that the SDK Worker
verifies before accepting state. Package builds regenerate version-bearing
metadata from the immutable executable bytes; no ignored binding directory is
needed.

Materialization is fail-closed: a requested target with any missing file is an
error and no network is used. Every target directory must also contain the
canonical `artifact-kernel-build-receipt.json` written only after its binding
was loaded and smoke-tested. The receipt pins the target, actual binding build
identity, capabilities digest, and every executable runtime file by size and
SHA-256. Materialization rejects stale/noncanonical receipts and cannot emit a
complete release manifest unless all eight exact targets carry one build
identity. The complete release-matrix package is not published implicitly. The
three browser capability packages are ordinary fixed-version Bun workspaces
released with `@opengeni/artifact-tool`.

Example for an already-smoked local subset:

```sh
bun scripts/materialize-artifact-kernel-packages.ts \
  --asset-root /absolute/path/to/bindings/dist \
  --output /absolute/path/to/generated-packages \
  --artifact-tool-version 1.2.3 \
  --target darwin-arm64 \
  --target wasm-web
```

`--target all` plus the packed artifact-tool SHA-512 integrity is required to
emit the complete release manifest. A partial invocation never advertises a
complete runtime release.

Release automation never cross-labels an unexecuted binary. It invokes
`scripts/build-artifact-runtime-target.ts` on the exact native host/userspace
for each target and uploads only the resulting asset plus canonical smoke
receipt. The aggregate job may materialize `--target all` only after all seven
native receipts and the WASM receipt exist and share one source/toolchain build
identity. There is no download, previous-release reuse, or “nearest target”
fallback in materialization or installation.
