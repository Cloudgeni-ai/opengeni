# Saving a Modal workspace at its scheduled deadline

Status: implementation record, 23 September 2026.

## Failure

A scheduled rotation started with an hour of provider lifetime left. Two
background commands kept process holders after their owner turn ended. The
legacy stop attempt for a non-PTY command wrote Ctrl-C to stdin, which is not a
Unix signal without a PTY. The old save rule waited for both commands to exit.
They did not, so the provider expired before a new archive was captured.

The workspace save does not require a command to finish successfully. It needs
a provider snapshot of current files with new mutations fenced. A background command
may leave incomplete output; losing the entire workspace is worse.

## Scheduled rotation behavior

1. Fence new workspace mutations when the deadline rotation is requested.
2. For each retained legacy Modal command, try a stop if the command has a PTY.
   A non-PTY Ctrl-C byte is ordinary stdin data, not a signal, so do not send
   it. Probe that command and record deadline cancellation intent. Continue
   observing without repeated stop bytes. If an earlier explicit stop is still
   pending, preserve that request and start a separate deadline grace.
3. After two minutes, allow the existing drain path to capture the workspace
   even if any legacy command is still running or observation failed. Require
   a closed, physically quiesced turn owner or a returned direct request; reject
   any other live holder or mutation admission. Active supervised commands
   remain on their separate proof path.
4. Publish the captured archive for the current workspace generation, then
   terminate the old sandbox. Mark the command lost, not cleanly completed.
   Restore the captured files in the replacement sandbox.

Capture failure keeps the old sandbox live for a retry. This policy is limited
to scheduled provider-deadline rotations. The saved files are a point-in-time
view: a command that ignored stop may have left an incomplete generated file.
The command result is never reported as successful because of the save.
Configuration validation reserves the two-minute stop window, full capture
budget, and two reaper ticks before the provider deadline.

This is not yet a hard guarantee under an overloaded reaper: its retained
process claim batch is limited, and a worker can crash before recording
cancellation intent. A claim left behind after intent is recorded does not
block the save. Supervised commands still use their separate proof gate.

## Verification

The database regression constructs two active legacy commands with a closed
turn owner and a deadline rotation: one still running, one unobservable. It
checks that the lease remains blocked before the grace, then captures the
current generation while both remain active. A separate regression covers a
returned direct-request owner. The drain terminates only after capture and
records both commands as lost. Existing containment tests cover other holders,
child admissions, failed captures, and late process exit.

The integration canary should run a non-PTY process and a
PTY render against a real Modal sandbox, modify a file after the previous
checkpoint, and verify the replacement has that file. It should also force a
capture failure and verify the old sandbox stays live for retry.
