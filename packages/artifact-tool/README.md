# `@opengeni/artifact-tool`

OpenGeni's Office-artifact engine. The package root is the synchronous exact
native skill facade; hosts must configure its manifest-pinned N-API runtime
before creating an artifact. `@opengeni/artifact-tool/reference` is the
explicit universal TypeScript fixture/codec model, while browser production
editing is owned by the SDK Worker and paired WASM kernel.

The public authoring API intentionally follows the artifact workflows shipped
with OpenGeni's spreadsheet and presentation skills:

```ts
import { SpreadsheetFile, Workbook } from "@opengeni/artifact-tool";

const workbook = Workbook.create();
const sheet = workbook.worksheets.add("Summary");
sheet.getRange("A1:B3").values = [
  ["Month", "Revenue"],
  ["Jan", 100],
  ["Feb", 120],
];
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save("summary.xlsx");
```

Design invariants:

- Sparse live models; rectangular writes are one transaction.
- Stable object ids and deterministic inspection output.
- Formula values derive from formulas; exports never replace formulas with
  hardcoded display values.
- Render and Office-file codecs are replaceable adapters around the same model.
- Unknown imported content is never silently presented as supported.

Every root-facade mutation is atomic across the host projection and native
session. Use `artifact.batch(draft => { ... })` for many sequential public
mutations: it applies host calls synchronously, reconciles native state once,
and rolls the complete batch back on failure. On the measured Darwin-arm64
fixture, 1,000 calls took 9.65 s spreadsheet / 4.48 s document / 7.20 s
presentation unbatched versus under 70 ms per modality batched. Ordinary
single calls remain exact; large builders must batch rather than rely on the
full-projection reconciliation fallback.

Filesystem, rasterization, and Office codecs remain lazy and outside the eager
facade closure.

## Kernel distribution status

The safe-Rust N-API and WebAssembly bindings are implemented and verified in
`kernel/bindings`. This package intentionally does **not** embed a partial
binary matrix: its tarball contains `dist/` and `src/`, while exact generated
kernel target packages carry platform assets separately.
The exported runtime locator/doctor verifies a local canonical installation
manifest, complete release manifest, pinned facade, target package, and every
executable byte before evaluating code. It performs no download, `latest`
lookup, target guess, or TypeScript fallback.

Native publication is one atomic matrix: macOS arm64/x64, Linux glibc
arm64/x64, Linux musl arm64/x64, and Windows x64, plus one browser-WASM
glue/binary/type set built from the same Rust source and protocol identity.
Every target requires a canonical receipt produced by executing its smoke test;
until every declared asset is present and provenance-verified, a complete
release cannot be materialized and production loading fails closed.

Installed hosts expose the exact local assembly with
`OPENGENI_ARTIFACT_RUNTIME_MANIFEST` and `OPENGENI_ARTIFACT_TOOL_ENTRY`. They
can run `opengeni-artifact-runtime locate --json` for verification without code
evaluation, or `opengeni-artifact-runtime doctor --json` to verify, load the
pinned bootstrap, and perform a minimal native facade health probe. Both
commands fail closed and return machine-readable JSON; neither performs network
discovery.

`scripts/assemble-artifact-runtime-installation.ts` is the production
installer. It accepts only absolute local paths to one canonical complete
release manifest, its exact already-materialized target package, and the packed
artifact-tool tarball named by that manifest. It verifies package identity,
tarball SHA-512, smoke receipt, and every runtime-file SHA-256 before atomically
publishing a relocatable root with a relative kernel import. The two OCI inputs
are assembled atomically by
`scripts/assemble-artifact-runtime-container-inputs.ts`: `amd64` is exactly
`linux-x64-gnu`; `arm64` is exactly `linux-arm64-gnu`. Missing either target
preserves the previous complete tree and fails the build.

`.github/workflows/artifact-runtime.yml` produces the inputs. Seven OS-native
jobs execute the addon on its exact target host/userspace; one WASM job executes
the generated browser ABI. Aggregation requires all eight canonical receipts,
one build identity, and the exact packed artifact-tool integrity, then runs the
strict doctor directly and through both Docker architectures. CI and immutable
release-candidate image builds consume only that run-local verified artifact.

Local development is deliberately separate. `scripts/dev-stack.sh` installs
workspace links first, then `scripts/prepare-development-artifact-runtime.ts`
builds and smokes only the current native host when its canonical source +
Rust-toolchain fingerprint is absent or stale. It writes the ignored
`.opengeni/artifact-runtime-development` bundle and exports its exact paths in
`.env.runtime`. This development manifest is a different schema, cannot claim
missing targets, cannot coexist with the production manifest, and is rejected
when `NODE_ENV=production`.

Performance evidence is deliberately narrower than the target matrix. The
machine-readable status in `bench/platform-evidence.json` distinguishes local
Darwin-arm64/kernel-WASM measurements from still-unmeasured packaged,
cross-platform, and sandbox runtimes; one platform's kernel result is never
presented as evidence for another.
