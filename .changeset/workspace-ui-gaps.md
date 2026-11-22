---
"@opengeni/react": patch
---

Every app opened in the workspace now offers its Opengeni chat beside it: the chat opens by default wherever the window has room for both (until you close it, which is remembered per app), and a closed chat comes back from a labelled Chat button in the app's header or the macOS window bar. The workbench tab strip shows Changes, Files, Terminal, Browser and Desktop directly while they fit and moves only the ones that don't into "+"; Settings and Debug stay in "+" (`WorkspaceTab.inMenu`). The Files tab leaves tool and cache folders (`.bun`, `.cache`, `.npm`, `node_modules` and the like, and the sandbox home's dot folders) out of the tree by default; one Show hidden files toggle in its toolbar brings them back, and opening a file inside one shows them.
