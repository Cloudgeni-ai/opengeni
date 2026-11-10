---
"@opengeni/worker-bundle": patch
---

Claude and SuperGrok requests on the shared subscription core no longer read the source and the turn lease in two separate transactions right before their reservation: the reservation already checks both in its own transaction, as Codex requests have done since their admission change. A turn's credential read no longer runs a separate source check either: a disconnected connection is disabled and scrubbed, so the credential load itself already refuses it. Each Claude or SuperGrok model request makes three fewer sequential database transactions before it reaches the provider, and each Codex request one fewer.
