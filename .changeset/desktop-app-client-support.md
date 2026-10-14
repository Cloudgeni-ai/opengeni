---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
---

Support for native desktop clients. `@opengeni/sdk/app-links` parses server addresses and `opengeni://` app links the same way in mobile and desktop apps. `ClientConfig` gains the optional `connectedMachines` flag, which tells a client whether the deployment accepts connected machines, so it only offers to connect the computer it runs on when that can work.
