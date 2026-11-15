---
"@opengeni/runtime": patch
---

Saving a browser download (and any other routed workspace file import) into a Modal sandbox works again. The import's internal steps ran through a wrapper of the Modal session, and Modal's lossless output collection only recognised the session itself, so every save failed at once as "completion is pending or unknown" without starting the transfer. A forwarding wrapper now shares its session's output collection.
