---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

When a file cannot be staged on a Connected Machine session whose working directory is the filesystem root (`/`, read-only on macOS), the failure now says the root is likely the cause and how to fix it, followed by the underlying error, instead of only a raw `mkdir: .opengeni: Read-only file system` error. The check uses the effective backend and working directory, not the command's localized output. The original command output and exit code are kept, managed sandboxes keep their raw reason, and files are never redirected to another host folder.
