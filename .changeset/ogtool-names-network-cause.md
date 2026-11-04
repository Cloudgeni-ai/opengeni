---
"@opengeni/codemode": patch
"@opengeni/ogtool": patch
"@opengeni/worker-bundle": patch
---

`ogtool` and the Codemode client now say why they cannot reach Opengeni instead of printing only "fetch failed". A broken DNS setup reads "Can't reach Opengeni: DNS lookup for <host> failed (ENOTFOUND). Check /etc/resolv.conf." (other systems are pointed at their DNS settings), and a wrong clock reads "Can't reach Opengeni: TLS certificate not yet valid. This machine's clock says <time>, so it is probably wrong." An expired certificate names both possibilities, the clock or the server. Refused, timed-out, unanswered and closed connections, unreachable networks and certificates that cannot be verified get their own sentence, including a connection lost while reading the answer. When a call was already submitted, the message adds that it may have run and how to check it with `ogtool read <operationId>`. The error is a new `CodemodeConnectionError` that keeps the original error as its `cause`; a failure with an unknown reason, or a caller's own abort, keeps its original error.
