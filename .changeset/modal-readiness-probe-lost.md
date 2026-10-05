---
"@opengeni/runtime": patch
---

When Modal loses the sandbox readiness check during startup, the failure now reads "lost its command-readiness probe" instead of the raw gRPC `FAILED_PRECONDITION: Failed to poll exec process: exec not found` reply. The original reply is kept on the error cause for diagnostics. Retry and recovery behaviour is unchanged.
