---
"@opengeni/runtime": patch
---

Sandbox setup before the first command is shorter. The artifact runtime check and the managed Codemode client install used to run one after another with credential setup and the repository clone, and each costs at least one provider round trip (on a fresh Modal box the client install alone takes several). They depend on no other setup step, so they now run alongside the ordered steps. Ordered steps keep their order, setup still waits for everything it started, and a failure is reported for the earliest failing step in the same order as before.
