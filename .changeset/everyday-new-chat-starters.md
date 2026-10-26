---
"@opengeni/react": patch
---

The new-chat page now suggests everyday asks to people who chose "Get help with everyday things" at sign-up: plan a trip, write a message, explain something, help me decide, plan the week's meals and learn to do something. People who chose to add agents to a product keep their own agent and the demo first, and everyone else keeps the general suggestions. `signupStarterSet` now also returns `"everyday"`, and `EVERYDAY_SESSION_STARTERS` lists the new set.
