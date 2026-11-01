---
"@opengeni/runtime": patch
---

The visualize Skill no longer has agents redraw an existing product by hand. When someone asks for a mockup on top of a product whose source or running build the agent can reach, the agent makes the change in the real source on a scratch branch, with sample data where the backend is missing, builds or runs it, and shows the compiled result. It shows that as screenshots, or, when the person should click through it, as the built page saved as a Site and embedded in chat. Fresh idea sketches still use an inline fragment drawn from the context already in the conversation. The Skill's description is unchanged.
