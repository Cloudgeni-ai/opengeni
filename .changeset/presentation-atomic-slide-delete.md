---
"@opengeni/artifact-kernel-wasm-presentation": patch
"@opengeni/artifact-tool": patch
"@opengeni/react": patch
---

Deleting a slide that has objects is now one atomic edit. The presentation kernel rejected a batch that deleted a slide's objects and then the slide with "unknown presentation slide", so the editor saved two separate edits. The kernel now applies such a batch, and the same for layouts and masters deleted together with their objects; a rejected batch also restores the deleted slide's hit-testing index. The editor deletes a slide and its objects in a single batch. Presentations edited this way need this kernel or newer, so don't roll the API back below this release.
