---
---

The shared test PostgreSQL container records its run spec as a label. A container built from an older spec, such as the earlier 64 MB shared memory, is replaced on the next acquire while no process holds it. A container in use is never disturbed. Long-lived machines therefore pick up fixture changes through the normal test lifecycle instead of keeping the old container indefinitely. Test infrastructure only.
