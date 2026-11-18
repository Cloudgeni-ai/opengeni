---
"@opengeni/worker-bundle": patch
---

A turn no longer wedges when a model response with no tool calls (for example one a Steer cut short) arrives while the worker is still busy recording the request's start. The worker kept the response's streamed items only while it waited for tool calls, so when it read the response afterwards it never learned the items were complete. The response then never settled, and the next model step (which hands the turn over to the Steer) waited on it until the attempt was cancelled. The items now wait for the response that owns them.
