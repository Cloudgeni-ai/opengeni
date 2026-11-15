# 39. A fresh boot waits for nothing it does not use

Status: Accepted, 2026-11-13. Amends
[36](0036-idle-memory-stays-in-ram.md) only in how long the fresh boot it
relies on takes.

## Context

Since [36](0036-idle-memory-stays-in-ram.md) an idle sandbox's process is
ended when its host needs the memory, and its next wake boots fresh from
its disk. That boot took 2.2 to 3.2 seconds until a chat sandbox could
serve. Measured on one fresh start, from the host's step events, the
guest kernel's log and the agent's log, two parts of it were the host's
and the guest kernel's own:

- **The guest kernel waited half a second for a keyboard.** Of its
  0.77 seconds, 0.51 passed in the keyboard driver's identify command.
  Firecracker emulates an i8042 controller only to take the guest's
  reboot and to send ctrl-alt-del; it acknowledges every keyboard command
  and answers none, so the driver waits out its 500 ms timeout, and the
  kernel waits for its probes to finish before it mounts the root
  filesystem. Firecracker's own default command line turns the probes off
  (`i8042.noaux i8042.nomux i8042.dumbkbd`), but a caller's command line
  replaces it, and ours did not carry them.
- **Every boot copied and synced the whole guest kernel.** Each boot puts
  a copy of the host's kernel in the VM's jail (a hard link would give the
  VMM a name for the host's own file). The copy is a clone on XFS or
  btrfs, but the host's kernel lives under `/opt` and the sandboxes on
  their own filesystem, so the clone failed and every boot wrote some
  28 MB and synced it. Over three days of fresh boots, the host's part
  before the VMM starts took 17 to 25 ms on one production host and 50 to
  140 ms on a busier one, with outliers to 320 ms.

The rest of the boot is the agent in the guest, which is not part of
Opengeni compute; its own start (about a second, most of it reading its
executable and the helpers embedded in it) is changed separately.

## Decision

- **The engine tells the guest kernel not to probe the keyboard**: it adds
  `i8042.noaux i8042.nomux i8042.dumbkbd`, as Firecracker's default does,
  unless the caller's command line sets something of the i8042 driver's
  itself. A guest's reboot (`reboot=k`) writes the controller's reset
  command itself, without the driver, and ctrl-alt-del still arrives as a
  key press, so both work as before.
- **The host agent copies the guest kernel once, as it starts, onto the
  state root** (`kernel/vmlinux`), and every boot copies that copy into
  its jail: a clone that writes nothing where the filesystem shares
  extents, a plain copy elsewhere. Each jail still has a file of its own.
  Neither copy is synced: the agent makes its copy at every start and a
  boot makes the jail's before its VMM reads it, and a restore never reads
  the kernel. If the agent cannot make its copy, boots copy the host's
  file as before.

## Consequences

- The guest kernel boots about half a second sooner, and the host's
  preparation of a fresh boot no longer writes the kernel.
  Measured: the production guest kernel's log shows the keyboard
  registered 0.51 s after its port, and nothing follows that wait but
  the root mount; with the three arguments the driver sends no command.
  The same kernel still reboots with them (checked under QEMU, whose
  controller takes the same reset command). On an XFS state root, a
  28 MB kernel copied and synced took 46 to 55 ms, its clone about 3 ms.
- A new guest kernel reaches boots once the agent restarts, not at the
  next boot after its file changed. An install that changes the kernel
  names a new file and restarts the agent ([the host bundle's
  `agent-inputs`](../../deploy/host/agent-inputs)), so this changes
  nothing in practice.
- Warm templates name the kernel's file among their inputs, so each is
  built once more after the upgrade.
- The agent keeps one more copy of the kernel, about 28 MB, on the state
  root.
