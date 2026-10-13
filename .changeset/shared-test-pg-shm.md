---
---

The shared test PostgreSQL container now starts with 1 GB of shared memory instead of Docker's 64 MB default. Parallel queries under heavy concurrent test load no longer fail with "could not resize shared memory segment", and the forced template drop that followed such a failure can no longer crash the server into recovery. Test infrastructure only; no runtime behavior changes.
