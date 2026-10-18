---
"@opengeni/codemode": patch
"@opengeni/runtime": patch
---

Reuse integrity verification for the exact immutable catalog snapshot produced by `createAttemptToolEnvironment`, reducing repeated turn-start parsing and hashing. The factory's catalog is now deeply frozen and detached from caller-owned schemas; callers constructing modified fixtures should clone it first. Deserialized catalogs and database reads retain full integrity checks. Catalog bytes, tool definitions and execution authority are unchanged.

Allow an owning runtime to start deferred tool preparation at provider dispatch rather than during first-request setup. Earlier tool demand starts the same operation, while closing before either event releases resources without starting unused preparation. Existing embedded callers retain immediate background preparation by default.
