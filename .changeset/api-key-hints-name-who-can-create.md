---
"@opengeni/contracts": minor
"@opengeni/react": patch
---

API key dialogs now name who can actually create a key you can't. On a workspace key, "All permissions" says only a workspace owner can create a key that reads secret values, since a Workspace admin can't give that. A member who manages keys sees "A workspace admin can create it." on presets that need workspace administration. For an organization admin who isn't the owner, Full access and Developer setup on an organization key stay visible but off, saying only the organization owner can create a key that manages people, keys or billing. Custom checkboxes name who can give each permission instead of "beyond your own access". The workspace-key rule, the Workspace admin and owner permission sets and the `workspaceKeyCreator`, `workspaceKeyCreatorSentence` and `workspaceKeyLiteralRefusal` helpers live in `@opengeni/contracts`, shared by the API and the apps. The API's refusal for a workspace key keeps its prefix and now ends with the same sentence.
