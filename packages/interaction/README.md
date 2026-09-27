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

Without a durable reader, large terminal receipts are compressed in the controller's in-memory journal
after their command settles. Replay, receipt lookup and explicit journal export
restore the full typed receipt; conflicting operation IDs still fail before
dispatch. In-flight promises and durable journal records keep their existing
semantics. This cache representation does not replace observations in model
history or change screenshot references. The entry-count retention limit remains
in force; compression is not a total memory or durable storage quota.

Placements with durable storage can provide `loadJournalRecord` alongside
`onJournalRecord`. Both callbacks and `initialJournal` must reference the same
resource/controller authority and retention policy. After a successful terminal
write, the controller retains only operation metadata and a receipt SHA-256 in
RAM. Replay and explicit lookup/export read and validate the complete durable
receipt against that digest. Missing or changed storage fails closed without
redispatch. A failed terminal write retains controller-lifetime RAM truth;
locally recovered nonterminal records likewise stay in RAM until persisted.
This reduces live receipt memory without changing SQLite history or model input.
