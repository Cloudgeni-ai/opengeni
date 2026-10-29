---
"@opengeni/browser-extension": patch
"@opengeni/browserd": patch
---

Attached Chrome keeps working on sign-in pages whose password manager loads its inline menu into a frame it created blank. The extension found other extensions' frames only by their address, and such a frame's address stays blank while it shows the other extension's page, so Chrome kept refusing the tab and every call failed with "it could not be removed". The extension now also removes a frame that was created blank and holds a page the extension cannot script: before a removal, every frame it can script says so to the frame that holds it, and a blank-created frame that does not is another extension's page. A page's own frames, including ones it created blank and loaded from another site, stay.

An observation made just before Chrome ended the tab's debugging (as it does whenever another extension adds a frame) now still holds when the new attachment finds the same document. browserd used to give every new attachment a new target, document and frame generation, so an action right after a fresh observation failed with `target_stale` whenever a password manager's menu appeared in between. A new attachment now keeps the ended one's generations and element references when the tab's main frame still has the same frame and loader ids; a new document, a crash or a closed tab still gets fresh ones, and commands of the ended attachment still never reach the new one.
