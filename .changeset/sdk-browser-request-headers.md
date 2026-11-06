---
"@opengeni/sdk": minor
---

Export `OPENGENI_SDK_VERSION_HEADER` (`x-opengeni-sdk-version`) and `OPENGENI_BROWSER_REQUEST_HEADERS`, the list of every request header the SDK's browser clients may send. Hosts that proxy the Opengeni API or session proxy cross-origin with a CORS allow-list must allow `x-opengeni-sdk-version`, which browser clients now send on every request; without it every preflight fails and the chat stays on "reconnecting". Build `Access-Control-Allow-Headers` from `OPENGENI_BROWSER_REQUEST_HEADERS` so new headers are picked up automatically.
