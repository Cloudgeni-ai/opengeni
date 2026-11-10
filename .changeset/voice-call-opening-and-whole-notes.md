---
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Voice calls open and follow along more cleanly. The voice model now gets the agent's working notes as whole messages when each note completes. Before, every streaming fragment ("You pic", "ked up, so…") arrived as its own context item, and final answers showed up twice. A final answer now reaches the voice once, as the turn's result. The resume prompt for chats with earlier voice calls no longer demands total silence at the start, which contradicted a call the agent placed ("speak first"). The placed-call opening also says to answer right away, or to answer the person's hello if they spoke first.
