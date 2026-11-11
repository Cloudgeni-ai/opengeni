---
"@opengeni/runtime": patch
---

Modal sessions restored from a directory snapshot save as tar archives when `OPENGENI_MODAL_WORKSPACE_PERSISTENCE=tar` is set.

- Before, such a session kept writing Modal directory snapshots for the rest of its life, so moving a deployment to tar persistence only reached new workspaces.
- The directory snapshot is mounted into a destination created in tar mode. It is the last native snapshot the session reads, and every later save goes to the deployment's own object storage.
- A box that is still live keeps the mode it was created in until it is next restored. Sessions saved as filesystem snapshots are unchanged.
