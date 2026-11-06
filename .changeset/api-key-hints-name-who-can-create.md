---
"@opengeni/contracts": minor
"@opengeni/react": patch
---

API key dialogs now name who can actually create a key you can't. On a workspace key, "All permissions" says only a workspace owner can create a key that reads secret values (a Workspace admin can't), and presets a member can't give say a workspace admin can create them. For an organization admin who isn't the owner, Full access and Developer setup on an organization key stay visible but off, saying only the organization owner can create a key that manages people, keys or billing, and the Custom checkboxes say the same instead of "beyond your own access". The workspace-key rule, the Workspace admin and owner permission sets and the new `workspaceKeyCreator` and `workspaceKeyCreatorSentence` helpers live in `@opengeni/contracts`, shared by the API and the apps; the API's refusal for a workspace key now ends with the same sentence.
