---
"@opengeni/runtime": patch
"@opengeni/db": patch
---

A Connected Machine that stops answering in the middle of a command now fails only that command. Previously the turn could not finish: it kept trying to cancel the command on the unreachable machine until the worker's quiescence watchdog drained the whole worker, ending the turn and every other turn on it. The command is now recorded in the session's command ledger with a stop request, the turn finishes normally, and the reconciler stops or settles the command when the machine returns or its runner is retired. The error the model sees is unchanged, and the later stop adds no model input. If the ledger cannot record the command, the turn keeps ownership as before.
