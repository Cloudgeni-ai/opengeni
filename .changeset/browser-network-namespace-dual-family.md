---
"@opengeni/browserd": patch
---

Localhost servers listening only on ::1 (for example a default Vite dev server on many Linux distributions) stay reachable in managed browsers on Linux machines. The private browser network namespace now keeps IPv6 loopback and is used only when the pasta found forwards each host loopback listener on its own address family; otherwise the browser launches on the machine's network as before, with the existing one-line notice. Chrome also waits for the namespace's IPv6 addresses to settle, so a late kernel address announcement no longer drops its first connections.
