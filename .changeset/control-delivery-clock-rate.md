---
"@opengeni/runtime": patch
---

Connected Machine calls no longer fail with "the machine could not recover this delivery's outcome" because two hosts' clocks tick at slightly different rates. A control delivery states how long ago its prefetched token arrived, and the machine refuses an offset that lands after its own present. A control plane whose elapsed clock ran even slightly faster than the machine's (time synchronization steers each host by up to 500 ppm, more right after a restart) made every older token unusable once that difference outgrew the network round trip, so ordinary tool calls failed with an unknown outcome. The control plane now understates the offset by 1%. The machine then charges each call slightly more elapsed time, never less, so no deadline is extended.
