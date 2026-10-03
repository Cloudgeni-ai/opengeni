---
"@opengeni/runtime": patch
---

Add a nonactivating, synchronous compiler for the explicit known-ID native fresh-create recipe. Retain the full pre-election origin, stable operation IDs, declared sleep entrypoint and create workdir, pinned SDK defaults, and exact normalized create-JSON correlation.

Compilation performs no provider, database or configuration I/O and supplies no credential, reservation, dispatch permission, physical receipt or helper-continuation authority. Export the compiler, descriptor and their types passively from `@opengeni/runtime/sandbox`; existing Modal helpers remain unchanged and no production caller is activated.