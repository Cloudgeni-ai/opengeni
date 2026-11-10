---
---

A compute host's agent keeps answering while it measures its sandboxes' disks at rest. Each sample used to read, on the agent's own loop, how much every saved or archived sandbox's disk may still grow (a FIEMAP of the disk, which on XFS walks the shared-extent tree). With about 140 resting sandboxes on a host under memory and I/O pressure, one sample took tens of seconds, the agent stopped answering its status, and its lease watchdog restarted it over and over, leaving chats on that host without their machine. The agent now measures disks at rest on the blocking pool, one measurement at a time, and ignores a result for a sandbox that woke, had a step start or was replaced since it was read. A measurement that takes 5 s or longer is logged.
