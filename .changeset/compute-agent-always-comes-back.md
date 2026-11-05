---
---

A compute sandbox's agent now always comes back after it ends. The guest init keeps its own copy of the agent's program and puts it back when the usual path was moved, removed or overwritten, recreates missing or replaced core `/dev` nodes, and takes the agent link's random stream ids from `getrandom(2)` instead of `/dev/urandom`. Takes effect for sandbox images built with the new init (compute release only; no package versions change).
