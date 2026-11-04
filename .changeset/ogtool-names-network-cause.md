---
"@opengeni/codemode": patch
"@opengeni/ogtool": patch
"@opengeni/worker-bundle": patch
---

`ogtool` and the Codemode client now say why they cannot reach Opengeni instead of printing only "fetch failed". A broken DNS setup reads "Can't reach Opengeni: DNS lookup for <host> failed (ENOTFOUND). Check /etc/resolv.conf.", and a wrong clock reads "Can't reach Opengeni: TLS certificate not yet valid. This machine's clock says <time>, so it is probably wrong." Refused, timed-out and closed connections, unreachable networks and certificates that cannot be verified get their own sentence. The error is a new `CodemodeConnectionError` that keeps the original error as its `cause`; a failure with an unknown reason keeps the transport's own error.
