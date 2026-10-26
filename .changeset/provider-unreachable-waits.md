---
"@opengeni/worker": patch
---

A turn whose model provider cannot be reached at all, as when the machine running it loses its internet connection, now waits for the connection to return instead of failing after five quick retries. It retries at a calm pace (up to every five minutes) for up to six hours from the first failure and continues by itself when the provider answers again; a new message still ends the wait at once. Name-resolution failures, refused connections, missing routes and the OpenAI SDK's bare "Connection error." qualify. Provider errors with an HTTP status, dropped or slow connections, unknown host names and TLS failures keep the existing five-retry budget. "No route to host" and "network is unreachable" failures are now retried instead of failing the turn at once.
