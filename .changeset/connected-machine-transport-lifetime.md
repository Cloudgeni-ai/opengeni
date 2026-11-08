---
"@opengeni/api-router": patch
"@opengeni/events": patch
---

Keep authenticated Connected Machine transports open across login credential expiry instead of disconnecting healthy commands every five minutes. The native runner refreshes renewed credentials in place and explicitly closes retired connection generations so old RPC handles cannot accumulate reconnecting sockets. The auth responder explicitly revokes live sockets whose durable enrollment authority changed; apply the documented NATS KICK service import/export before deploying this API.
