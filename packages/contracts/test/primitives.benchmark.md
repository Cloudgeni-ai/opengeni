# Shared primitive validator allocation

Eleven ordinary eager Zod schemas replace 4,938 duplicate primitive constructor
expressions across 98 contract modules. The production implementation is a small
constants module and direct imports, not an interning registry, lazy proxy,
validation cache, bundler plugin or new runtime dependency.

## Reproduce

On the baseline and candidate checkouts, using the pinned Bun version:

```sh
bun run build:runtime-processes
bun scripts/bench-process-memory.ts
bun test packages/contracts/test
```

Baseline: `8f645aba3`. Measurements below are medians of three fresh processes per
profile, after import/activity registration and full diagnostic GC. They are not
service readiness, loaded-process residency, live deployment savings or a
controlled latency experiment. The first paired benchmark ran on a shared host;
import latency and RSS are more variable than retained heap.

| Release profile | Base heap MiB | Shared heap MiB | Base RSS MiB | Shared RSS MiB |
| --- | ---: | ---: | ---: | ---: |
| API | 154.9 | 123.9 | 323.6 | 275.2 |
| Control worker | 85.7 | 75.7 | 219.3 | 216.5 |
| Turn worker | 86.9 | 77.0 | 221.1 | 210.2 |
| Artifact materializer | 35.0 | 31.8 | 106.0 | 100.8 |
| Artifact outbox | 35.3 | 32.2 | 103.5 | 98.1 |

The API retains about 20% less import-time heap; workers retain about 11% less.
An earlier build-only prototype shared 178 arbitrary repeated expressions and
saved more memory, but the production change deliberately uses only eleven common
primitive definitions rather than introducing generated schema machinery.

## Behavior checks

- Full contracts suite, including bundler/tree-shaking fixtures and shared
  primitive tests: 1,327 tests, 31,270 assertions.
- Contracts plus five full API MCP suites: 1,397 tests, 31,844 assertions.
- Five further full runtime/schema-consumer suites: 169 tests, 929 assertions.
- Contracts, runtime, API and worker typechecks passed.
- A local differential capture of 3,396 exported schemas from the same module set
  produced byte-identical draft-7 input/output JSON Schemas and validation results
  for 16 scalar/empty-object samples per export. SHA-256 of the complete capture:
  `23e48f590ffa2c8ab2d01e60f79f1a143457c3acc661bb6824eb395bf5c46f0e`.
- The committed primitive suite checks the original constructor against each
  shared value, including nested error paths and repeated fields, across input
  and output conversion for draft-7, draft-2020-12 and OpenAPI 3.0. Field-specific
  builder/description calls leave the shared primitive unchanged.

Existing exported schema names, validators, defaults, descriptions and JSON
Schema bytes are retained. Object identity is intentionally shared: consumers
must not mutate a primitive's internal definition or register field-specific
metadata directly on that shared instance. Normal builder methods produce derived
schemas. No in-repository mutation/registration of these primitives was found;
arbitrary external mutation is not a universal-equivalence claim.
