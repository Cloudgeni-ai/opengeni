---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Explain why attachments cannot be staged on a Connected Machine session whose working directory is the filesystem root (`/`, read-only on macOS), and how to fix it, instead of reporting only a raw `mkdir: .opengeni: Read-only file system` error. The original command output and exit code are kept, and files are never redirected to another host folder.
