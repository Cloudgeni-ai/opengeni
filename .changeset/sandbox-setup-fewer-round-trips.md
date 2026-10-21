---
"@opengeni/runtime": patch
---

Sandbox setup makes far fewer round trips. Run credentials used to take five sandbox commands per file plus six more, each a full provider round trip, so a session with several repositories spent tens of seconds writing credentials before its first command. A credential generation is now packed into as few commands as fit the provider's command-size limit, usually one, with the same atomic activation and verification. The shell wrapper that makes commands cancellable now carries each command once instead of three times, which is what kept those commands small. Modal command starts also reuse the sandbox's task id instead of asking Modal's control plane for it on every command.
