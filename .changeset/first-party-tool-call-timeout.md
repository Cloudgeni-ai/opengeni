---
"@opengeni/config": patch
"@opengeni/runtime": patch
---

Opengeni's own tools get four minutes per call instead of the MCP client's 60-second default. Publishing a large file could take longer than a minute; the client gave up with "Request timed out" while the API went on to publish it, so the agent was left unsure whether the file existed. A server's explicit setup timeout now bounds its setup on its own, so the longer call bound never stretches setup against an unreachable server.
