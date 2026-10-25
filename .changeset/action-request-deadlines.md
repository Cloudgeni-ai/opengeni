---
"@opengeni/contracts": minor
"@opengeni/runtime": patch
"@opengeni/browserd": patch
"@opengeni/api-router": patch
"@opengeni/observability": patch
---

A browser or computer action batch that legitimately runs longer than a minute (for example waiting for an upload, filling a field, pressing Enter and then waiting up to 90 seconds for a reply) now completes and returns its normal receipt instead of failing with "The workspace is temporarily unavailable". Each action request gets a deadline derived from its own declared waits: the sum of each action's longest wait, plus the settle after page input, plus a fixed margin. It is never less than the previous one minute and never more than 20 minutes. Every layer that carries the request honours that deadline: the API's controller request on every transport, the Connected Machine runner (whose cap rises from 15 to 20 minutes) and its reply timer, the socket idle timers of the API-to-controller and tool-to-API requests, and the API and browser controller servers, which no longer apply their idle timeout to a running action. A request that still outlives its deadline (or an older runner's 15-minute cap) is not retried and returns `504 action_timeout`, telling the agent that the action may still be running and to check the page or window before doing anything again. `@opengeni/contracts` exports the shared wait and settle bounds and `browserActionDeadlineMs` / `computerActionDeadlineMs`.
