---
"@opengeni/runtime": patch
---

On Modal sandboxes, `apply_patch` now writes any file the agent's own shell can write, such as a throwaway script under `/tmp`, the same as on Connected Machine and compute sandboxes. Before, it refused every path outside the workspace with "escapes the workspace root" while the agent's instructions told it to keep scratch work in a temporary directory outside the project. Paths resolve the way the shell resolves them (absolute as given, relative from the workspace root), and the adapter's own file read, write, delete and existence probe still do the work, which also removes one path-validation round trip per edited file. A `runAs` edit keeps the adapter's user-scoped path.
