---
"@opengeni/react": minor
"@opengeni/sdk": minor
---

Carve the connected-machine UI into a dedicated `@opengeni/react/machines` subpath, and add `workingDir` to the SDK create-session request.

- **`@opengeni/react`**: the bring-your-own-compute surface (`useMachines`, `MachinesDashboard`, `MachineCard`, `MachineDockBar`, `SharedMachineDisclosure`, `MachineStatusPill`, `ConnectionStatusPill`, `ConnectionDot`, `MachineMetrics`, `EnrollmentDeviceFlow`, `EnrollmentConsent`, `connectionStatusForState`, and the `MachineView` / `MachineState` / `MachineKind` / `MachinesResponse` / `MetricSample` view-model types) now lives at `@opengeni/react/machines`. The root keeps re-exporting it for backwards compatibility — **non-breaking** — but the root re-export is **deprecated** and will move in a future major. Import from `@opengeni/react/machines` going forward.
- **`@opengeni/sdk`**: `CreateSessionRequest` gains an optional `workingDir?: string` field — the host working directory for a connected-machine target (the agent runs there; defaults to the machine's launch dir). Ignored for managed sandboxes.
