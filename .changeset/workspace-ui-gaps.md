---
"@opengeni/react": minor
"@opengeni/contracts": minor
"@opengeni/api-router": patch
---

Every app opened in the workspace now offers its Opengeni chat beside it: the chat opens by default wherever the window has room for both (until you close it, which is remembered per app), and a closed chat comes back from a labelled Chat button in the app's header or the macOS window bar. A new chat there starts on the app's configured model when the workspace allows it (`SitePublicationLink.agentModel`, `useNewConversation({ defaultModel })`). The app header's publication control reads **Share**, and a published app shows a loading screen until it has loaded. "Let people chat" now says the app's own chat uses the agent, and the apps guidance has the agent add a chat that suits the app when chat is turned on.

The workbench tab strip shows Changes, Files, Terminal, Browser and Desktop directly while they fit and moves only the ones that don't into "+"; Settings and Debug stay in "+". This changes `WorkspaceTab.optional`: an optional tab now fills spare room on the strip. Add `inMenu: true` to keep a tab in "+" as before. The strip has one maximize/restore button (Esc also restores), and the session header's Pin moved into its … menu.

The Files tab leaves tool and cache folders (`.bun`, `.cache`, `.npm`, `node_modules` and the like, and the sandbox home's dot folders) out of the tree by default; one Show hidden files toggle in its toolbar brings them back, and opening a file inside one shows them in that view. `hideToolFolders={false}` on `SandboxWorkspace` or `SandboxFiles` turns this off.
