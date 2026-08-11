# `@opengeni/interaction`

Provider-neutral browser/computer interaction domain and placement-controller
implementation. It owns the causal mutation boundary shared by agents and humans:

- exact controller/target/document/frame generation checks;
- one serialized mutation stream per target, with independent targets concurrent;
- operation-id deduplication and honest `failed` versus `outcome_unknown` receipts;
- attempt authority checked immediately before dispatch;
- driver interfaces that keep Chromium, connected Chrome, Linux, macOS, and later
  external providers behind the same OpenGeni contract.

The package does not own HTTP, Postgres, sandbox placement, credentials, or UI.
Those layers provide placement and attempt authority, persist low-volume resource
state, and attach a concrete driver. Raw CDP/driver endpoints are never public
contracts.

`BrowserInteractionController` publishes the complete operation journal record
(command digest plus typed receipt) at every state transition. Placement storage
must accept `prepared` and `dispatched` synchronously before execution proceeds;
the exported recovery function is the sole crash-settlement policy used by both
the controller and durable adapters.
