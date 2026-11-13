---
---

On a Linux computer whose system loader cannot run the bundled browser controller (a musl system such as Alpine, where the glibc loader is missing), the agent now finds this out when it starts. A managed browser request on that computer is refused with a plain reason ("Managed browsers can't run on this computer: its Linux has no /lib/ld-linux-aarch64.so.1 …") instead of failing to start with a bare "No such file or directory".
