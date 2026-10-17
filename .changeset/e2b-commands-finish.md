---
"@opengeni/runtime": patch
---

Commands on the e2b sandbox backend now finish. E2B's terminal always runs an interactive bash, and the command was typed into it, so the shell went on running after the command ended: a tty command never reported its exit status, and every turn that waited for one hung until the sandbox timed out. Its whole wrapper script was also echoed back as output. The command is now staged in a file, and the one short line typed replaces that bash with a shell running the file, which runs the command as a job of its own and reports its status in the terminal. A tty command therefore ends when it does, with its status: also when it is interrupted with Ctrl-C (exit status 130), and also when it leaves a process running in the background, which keeps running and keeps E2B's terminal open. Its output no longer includes bash's prompt or the typed line.

The backend also works with images whose workspace root is owned by root or lacks write permission. E2B runs commands as its default user, so in such an image every write to the workspace failed. Creating a sandbox now checks that the default user can write and enter the workspace root and, if not, hands it to that user as root with full access for them, then checks again as that user; if either step fails, creating the sandbox fails with the reason.
