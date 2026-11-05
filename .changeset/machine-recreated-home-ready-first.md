---
"@opengeni/agent-host": patch
---

A workspace root or home folder that the machine agent (0.1.155) creates again is now complete before any command can start in it. Before, the folder appeared first and got its owner and mode afterwards, so a command racing to start there could begin in a folder still owned by the agent with the agent's umask mode. If the agent couldn't give a run-as user's home to that user, it left that half-made folder behind, and the command ran in it. On Linux and macOS the agent now makes the folder under a private name, sets its owner and mode, and moves it into place without replacing anything. If the owner can't be set, the agent removes it and that one command fails as not found. On macOS, the developer-tools check behind the Git identity probe now also uses the agent's retained `/dev/null`, so it keeps working when `/dev/null` was removed.
