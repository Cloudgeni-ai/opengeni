---
---

A compute host whose boot disk is rebuilt, for example when a cloud restart recreates it from a newer image while the state disk survives, keeps its state volume and the sandboxes on it. `install.sh --state-device` used to format the device whenever the host's record of its state volume was missing, and that record lived on the boot disk. Now it mounts and keeps a file system it finds on the device, records it again, and also keeps the record on the volume itself; it formats only a blank device, and refuses one that holds other files or something that is not a file system. Formatting such a device takes the separate `--reformat-state-device DEV`. On Google Cloud, the startup script assembles striped local SSDs that already carry an array instead of creating a new one over them.
