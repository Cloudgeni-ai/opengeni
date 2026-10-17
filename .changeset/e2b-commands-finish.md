---
"@opengeni/runtime": patch
---

Commands on the e2b sandbox backend now finish. E2B's terminal always runs an interactive bash, and the command was typed into it, so the shell went on running after the command ended: a tty command never reported its exit status, and every turn that waited for one hung until the sandbox timed out. Its whole wrapper script was also echoed back as output. The command is now staged in a file, and the one short line typed runs it and leaves the shell with its exit status. Background processes it starts keep running.

The backend also works with images whose workspace root is owned by root. E2B runs commands as its default user, so in such an image every write to the workspace failed. Creating a sandbox now checks that the default user can write the workspace root and, if not, hands it to that user as root; if that is impossible, creating the sandbox fails with the reason.
