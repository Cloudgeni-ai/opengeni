---
"@opengeni/runtime": patch
---

Sandbox setup step timing now covers fresh Modal boxes. Modal creates boxes through its lifecycle-aware create call, which the setup-operation metric did not wrap, so `opengeni_sandbox_setup_operation_duration_seconds` stayed empty for every newly created Modal sandbox. Every client method that returns a new session is now measured.
