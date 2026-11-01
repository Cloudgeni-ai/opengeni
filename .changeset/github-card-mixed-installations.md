---
"@opengeni/react": patch
"@opengeni/api-router": patch
---

The in-chat GitHub card lets a chat use repositories from any number of GitHub App installations, as the composer picker already does; it no longer says "This chat already uses another account's repositories. Start a new chat". `github_connect_link` also returns `settingsUrl`, a console link to the workspace's GitHub settings, so the agent can point a person to **Install on another account** when its own grant cannot mint the install link.
