---
"@opengeni/db": patch
"@opengeni/core": patch
---

A Docker sandbox whose container is reported missing during an idle drain no longer loses its chat. The drain used to commit the lease as archive-only and drop the provider state, so the workspace was declared unrecoverable even though its host directory was still on disk, and every later turn in that chat was blocked (this also happened when the daemon briefly reported NotFound while the host was under memory pressure). The cold commit now keeps the same Docker continuity receipt a lost warm instance keeps, and the next turn restarts a container on the same host directory, or reattaches the one a false NotFound missed. Separately, sandbox recovery consent can now be given through the API by an organization key acting as one verified external user on that user's own behalf (asUser), not only from the browser cookie session. Agents, bare API keys, service initiators and delegated bearers still cannot consent.
