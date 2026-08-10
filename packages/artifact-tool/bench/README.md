# Artifact performance harness

`budgets.json` is the machine-readable projection of the release targets in
`docs/artifact-engine.md`. Keep the exact release fixture sizes stable so
historical results stay comparable.

Fast local/CI measurement:

```bash
bun packages/artifact-tool/bench/run.ts
```

Full fixture sizes and a single JSON report:

```bash
bun packages/artifact-tool/bench/run.ts --deep --json
```

The TypeScript runner describes the API reference engine and deliberately
cannot certify native/WASM release budgets. Pinned native runners may enforce
the architecture budgets:

```bash
OPENGENI_ARTIFACT_BENCH_DEEP=1 OPENGENI_ARTIFACT_BENCH_PINNED=1 cargo bench \
  --manifest-path packages/artifact-tool/kernel/Cargo.toml --bench kernel
```

Normal shared CI runs `test/perf`. Its wider time ceilings detect accidental
quadratic work while deterministic byte/count bounds enforce sparse memory and
browser bundle closure without relying on noisy wall-clock microbenchmarks.
